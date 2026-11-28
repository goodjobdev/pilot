package main

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"tailscale.com/ipn/ipnstate"
)

const testName = "gateway.example-tailnet.ts.net"
const testID = "nDedicatedGateway"

func testNodeStatus() *ipnstate.Status {
	return &ipnstate.Status{
		BackendState: "Running", HaveNodeKey: true,
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.2")},
		Self:         &ipnstate.PeerStatus{DNSName: testName + ".", ID: testID},
	}
}

func TestWaitForNodeColdStartup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	calls := 0
	name, err := waitForNode(ctx, func(context.Context) (*ipnstate.Status, error) {
		calls++
		switch calls {
		case 1:
			return &ipnstate.Status{BackendState: "NoState", HaveNodeKey: true}, nil
		case 2:
			return &ipnstate.Status{BackendState: "Starting", Self: testNodeStatus().Self}, nil
		default:
			return testNodeStatus(), nil
		}
	}, testName, testID, time.Millisecond)
	if err != nil || name != testName || calls != 3 {
		t.Fatalf("got name=%q err=%v calls=%d", name, err, calls)
	}
}

func TestWaitForNodeRejectsUnusableIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*ipnstate.Status)
		want   error
	}{
		{"wrong-id", func(s *ipnstate.Status) { s.Self.ID = "other-node" }, errWrongIdentity},
		{"wrong-name", func(s *ipnstate.Status) { s.Self.DNSName = "somewhere.else.ts.net." }, errWrongIdentity},
		{"missing-name", func(s *ipnstate.Status) { s.Self.DNSName = "" }, errWrongIdentity},
		{"missing-self", func(s *ipnstate.Status) { s.Self = nil }, errNotAuthorized},
		{"no-ip", func(s *ipnstate.Status) { s.TailscaleIPs = nil }, errNotAuthorized},
		{"no-key", func(s *ipnstate.Status) { s.HaveNodeKey = false }, errNotAuthorized},
		{"expired", func(s *ipnstate.Status) { s.Self.Expired = true }, errNotAuthorized},
		{"past-expiry", func(s *ipnstate.Status) { now := time.Now().Add(-time.Hour); s.Self.KeyExpiry = &now }, errNotAuthorized},
		{"login", func(s *ipnstate.Status) { s.BackendState = "NeedsLogin" }, errNotAuthorized},
		{"auth-url", func(s *ipnstate.Status) { s.AuthURL = "https://login.example/never-forward" }, errNotAuthorized},
		{"approval", func(s *ipnstate.Status) { s.BackendState = "NeedsMachineAuth" }, errNotAuthorized},
		{"stopped", func(s *ipnstate.Status) { s.BackendState = "Stopped" }, errNotAuthorized},
		{"unknown", func(s *ipnstate.Status) { s.BackendState = "Unknown" }, errStatus},
	} {
		t.Run(tc.name, func(t *testing.T) {
			st := testNodeStatus()
			tc.mutate(st)
			name, err := waitForNode(context.Background(), func(context.Context) (*ipnstate.Status, error) { return st, nil }, testName, testID, time.Millisecond)
			if name != "" || !errors.Is(err, tc.want) {
				t.Fatalf("got name=%q err=%v, want %v", name, err, tc.want)
			}
		})
	}
}

func TestWaitForNodeHonorsDeadlineAndCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if name, err := waitForNode(ctx, func(context.Context) (*ipnstate.Status, error) {
		return &ipnstate.Status{BackendState: "NoState"}, nil
	}, testName, testID, time.Hour); name != "" || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got name=%q err=%v", name, err)
	}

	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	if name, err := waitForNode(ctx, func(context.Context) (*ipnstate.Status, error) {
		stop()
		return testNodeStatus(), nil
	}, testName, testID, time.Millisecond); name != "" || !errors.Is(err, context.Canceled) {
		t.Fatalf("accepted status arriving after cancellation: name=%q err=%v", name, err)
	}
}

func TestWaitForNodeSanitizesStatusFailure(t *testing.T) {
	_, err := waitForNode(context.Background(), func(context.Context) (*ipnstate.Status, error) {
		return nil, errors.New("private upstream diagnostic")
	}, testName, testID, time.Millisecond)
	if err != errStatus {
		t.Fatalf("unexpected output: %v", err)
	}
}

func TestKeylessEnvironmentRejectsCredentialAndControlOverrides(t *testing.T) {
	for _, entry := range []string{"TS_AUTHKEY=", "TS_AUTH_KEY=x", "TS_CLIENT_SECRET=x", "TS_ID_TOKEN=x", "TS_CONTROL_URL=x", "TS_DEBUG_REGISTER=x", "TSNET_FORCE_LOGIN=x", "TAILSCALE_EXAMPLE=x"} {
		if !errors.Is(validateKeylessEnvironment([]string{entry}), errAmbientTSNet) {
			t.Fatalf("did not reject %q", entry)
		}
	}
	if err := validateKeylessEnvironment([]string{"TSNET_STATE_DIR=/var/lib/tsnet", "TSNET_HOSTNAME=gateway"}); err != nil {
		t.Fatal(err)
	}
}

func TestValidateEnrolledStateRequiresPrivateUnlinkedRegularFile(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "tailscaled.state")
	uid := os.Geteuid()
	refuse := func(asUID int) {
		t.Helper()
		if err := validateEnrolledState(dir, asUID); err != errNoEnrolledState {
			t.Fatalf("unsafe state accepted: %v", err)
		}
	}
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	refuse(uid)
	must(os.WriteFile(state, nil, 0600))
	refuse(uid)
	must(os.WriteFile(state, []byte("synthetic file, not trusted tsnet state"), 0600))
	must(validateEnrolledState(dir, uid))
	refuse(uid + 1)
	must(os.Chmod(state, 0644))
	refuse(uid)
	must(os.Chmod(state, 0600))
	linked := filepath.Join(dir, "other")
	must(os.Link(state, linked))
	refuse(uid)
	must(os.Remove(state))
	must(os.Symlink(linked, state))
	refuse(uid)
}
