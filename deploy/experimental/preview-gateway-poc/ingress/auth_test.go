package ingress

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeWhoIs struct {
	peer Peer
	err   error
	addr  string
	calls int
}

func (f *fakeWhoIs) WhoIs(_ context.Context, addr string) (Peer, error) {
	f.calls++
	f.addr = addr
	return f.peer, f.err
}

func policy() Policy {
	return Policy{OwnerLogin: "owner@example.test", AllowedNodeIDs: map[string]struct{}{"remote-approved": {}}, GatewayNodeID: "gateway", HostNodeID: "host"}
}
func call(t *testing.T, lookup WhoIs, p Policy, headers map[string]string) (*httptest.ResponseRecorder, bool) {
	t.Helper()
	called := false
	h := Protect(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) }), lookup, p)
	r := httptest.NewRequest(http.MethodGet, "https://ingress.example.test/ws", nil)
	r.RemoteAddr = "100.80.0.7:4321"
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w, called
}
func TestProtectAllowsOnlyApprovedOwnerRemoteNode(t *testing.T) {
	who := &fakeWhoIs{peer: Peer{Login: "owner@example.test", NodeID: "remote-approved"}}
	w, called := call(t, who, policy(), nil)
	if !called || w.Code != http.StatusNoContent {
		t.Fatalf("status=%d called=%v", w.Code, called)
	}
	if who.addr != "100.80.0.7:4321" {
		t.Fatalf("WhoIs address=%q", who.addr)
	}
}
func TestProtectRejectsIdentityVariantsAndClientForgery(t *testing.T) {
	cases := []struct {
		name    string
		peer    Peer
		headers map[string]string
	}{
		{"different owner", Peer{Login: "other@example.test", NodeID: "remote-approved"}, nil},
		{"tagged peer", Peer{Login: "owner@example.test", NodeID: "remote-approved", Tags: []string{"tag:server"}}, nil},
		{"unapproved owner device", Peer{Login: "owner@example.test", NodeID: "unknown"}, nil},
		{"host identity", Peer{Login: "owner@example.test", NodeID: "host"}, nil},
		{"gateway identity", Peer{Login: "owner@example.test", NodeID: "gateway"}, nil},
		{"forged headers", Peer{Login: "other@example.test", NodeID: "unknown"}, map[string]string{"X-Forwarded-For": "100.80.0.7", "Tailscale-User-Login": "owner@example.test", "X-Remote-Node-ID": "remote-approved"}},
		{"ambiguous identity", Peer{Login: "owner@example.test"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			who := &fakeWhoIs{peer: tc.peer}
			w, called := call(t, who, policy(), tc.headers)
			if called || w.Code != http.StatusForbidden {
				t.Fatalf("status=%d called=%v", w.Code, called)
			}
		})
	}
}
func TestProtectFailsClosedOnWhoIsFailureIncludingUpgrade(t *testing.T) {
	who := &fakeWhoIs{err: errors.New("localapi unavailable")}
	w, called := call(t, who, policy(), map[string]string{"Connection": "Upgrade", "Upgrade": "websocket", "Sec-WebSocket-Version": "13"})
	if called || w.Code != http.StatusForbidden {
		t.Fatalf("status=%d called=%v", w.Code, called)
	}
}
func TestProtectFailsClosedOnInvalidPolicy(t *testing.T) {
	p := policy()
	p.AllowedNodeIDs["host"] = struct{}{}
	w, called := call(t, &fakeWhoIs{}, p, nil)
	if called || w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d called=%v", w.Code, called)
	}
}
func TestProtectDoesNotTreatHeaderAsIdentity(t *testing.T) {
	who := &fakeWhoIs{peer: Peer{Login: "untrusted", NodeID: "untrusted"}}
	w, called := call(t, who, policy(), map[string]string{"Authorization": "Bearer owner@example.test", "Cookie": "identity=owner@example.test"})
	if called || w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "owner") {
		t.Fatalf("status=%d called=%v body=%q", w.Code, called, w.Body.String())
	}
}
