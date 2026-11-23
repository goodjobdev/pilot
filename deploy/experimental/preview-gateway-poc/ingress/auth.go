// Package ingress provides per-request authorization for handlers exposed by
// a separately managed tsnet node. It deliberately does not implement proxying.
package ingress

import (
	"context"
	"net/http"
	"strings"
)

// Peer is the identity attributed by tsnet LocalAPI WhoIs to the accepted
// socket's remote address. NodeID must be the stable tailnet node ID, not a
// display name or IP address.
type Peer struct {
	Login  string
	NodeID string
	Tags   []string
}

// WhoIs resolves a socket peer through the gateway node's own LocalAPI.
type WhoIs interface {
	WhoIs(context.Context, string) (Peer, error)
}

// Policy requires the exact account login and explicit approved remote node
// IDs. These exclusions prevent the gateway and host node being accepted even
// if they are mistakenly present in the allowlist.
type Policy struct {
	OwnerLogin     string
	AllowedNodeIDs map[string]struct{}
	GatewayNodeID  string
	HostNodeID     string
}

func (p Policy) valid() bool {
	if p.OwnerLogin == "" || p.GatewayNodeID == "" || p.HostNodeID == "" || p.GatewayNodeID == p.HostNodeID || len(p.AllowedNodeIDs) == 0 {
		return false
	}
	for id := range p.AllowedNodeIDs {
		if id == "" || id == p.GatewayNodeID || id == p.HostNodeID {
			return false
		}
	}
	return true
}

type peerContextKey struct{}

// PeerFromContext returns the identity resolved for this request by WhoIs.
func PeerFromContext(ctx context.Context) (Peer, bool) {
	peer, ok := ctx.Value(peerContextKey{}).(Peer)
	return peer, ok
}

// Protect authenticates each HTTP request, including an HTTP Upgrade request
// for WebSockets. The identity is obtained exclusively from RemoteAddr, which
// net/http sets from the accepted connection; forwarded/client identity headers
// are not consulted. Do not put a peer-rewriting proxy in front of this handler.
func Protect(next http.Handler, lookup WhoIs, policy Policy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !policy.valid() || lookup == nil {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		peerAddr := r.RemoteAddr // preserve IP:port as required by LocalAPI WhoIs
		if peerAddr == "" || strings.ContainsAny(peerAddr, " \t\r\n") {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		peer, err := lookup.WhoIs(r.Context(), peerAddr)
		if err != nil || peer.Login == "" || peer.NodeID == "" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if peer.Login != policy.OwnerLogin || len(peer.Tags) != 0 || peer.NodeID == policy.GatewayNodeID || peer.NodeID == policy.HostNodeID {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if _, ok := policy.AllowedNodeIDs[peer.NodeID]; !ok {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), peerContextKey{}, peer)))
	})
}
