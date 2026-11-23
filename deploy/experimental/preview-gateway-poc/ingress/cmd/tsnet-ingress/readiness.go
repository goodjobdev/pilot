package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"tailscale.com/ipn/ipnstate"
)

const (
	startupTimeout = 20 * time.Second // within the container supervisor's 30s startup deadline
	statusInterval = 200 * time.Millisecond
)

var (
	errNoEnrolledState = errors.New("expected a private, pre-enrolled tsnet state file")
	errAmbientTSNet    = errors.New("ambient Tailscale configuration is not allowed")
	errStatus          = errors.New("cannot read local gateway status")
	errNotAuthorized   = errors.New("gateway node requires authorization or is stopped")
	errWrongIdentity   = errors.New("gateway DNS name or stable node ID does not match reviewed configuration")
)

// The default backend must reopen existing state, not create a new state store.
// This is called only after the enclosing state directory and ancestors have
// passed the separate UID, ownership, permission, and symlink checks.
func validateEnrolledState(dir string, uid int) error {
	info, err := os.Lstat(filepath.Join(dir, "tailscaled.state"))
	if err != nil || info.Mode() != 0600 || info.Size() == 0 {
		return errNoEnrolledState
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != uid || owner.Nlink != 1 {
		return errNoEnrolledState
	}
	return nil
}

func validateKeylessEnvironment(env []string) error {
	for _, entry := range env {
		name, _, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "TS_") || strings.HasPrefix(name, "TAILSCALE_") || name == "TSNET_FORCE_LOGIN" {
			return errAmbientTSNet
		}
	}
	return nil
}

// Wait for the local backend to report the expected authenticated identity.
// Deliberately only read LocalAPI status: Up also clears persisted Serve and
// Service settings. A cold node can briefly be NoState (even with a node key).
// The caller must not bind a preview listener or request its certificate before
// this function succeeds. Cancellation and timeout are never readiness.
func waitForNode(ctx context.Context, status func(context.Context) (*ipnstate.Status, error), expectedName, expectedID string, interval time.Duration) (string, error) {
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		st, err := status(ctx)
		if contextErr := ctx.Err(); contextErr != nil {
			return "", contextErr
		}
		if err != nil || st == nil {
			return "", errStatus
		}
		if st.AuthURL != "" || st.BackendState == "NeedsLogin" || st.BackendState == "NeedsMachineAuth" || st.BackendState == "Stopped" {
			return "", errNotAuthorized
		}
		if st.BackendState == "Running" {
			if st.Self == nil || !st.HaveNodeKey || len(st.TailscaleIPs) == 0 || st.Self.Expired ||
				(st.Self.KeyExpiry != nil && !st.Self.KeyExpiry.IsZero() && !st.Self.KeyExpiry.After(time.Now())) {
				return "", errNotAuthorized
			}
			name := strings.TrimSuffix(st.Self.DNSName, ".")
			if name != expectedName || string(st.Self.ID) != expectedID {
				return "", errWrongIdentity
			}
			return name, nil
		}
		if st.BackendState != "NoState" && st.BackendState != "Starting" {
			return "", errStatus
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return "", ctx.Err()
		case <-timer.C:
		}
	}
}
