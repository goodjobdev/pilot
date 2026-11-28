package ingress

import (
	"context"
	"net/http"
	"strings"
)

type Peer struct {
	Login, NodeID string
	Tags          []string
}
type WhoIs interface {
	WhoIs(context.Context, string) (Peer, error)
}
type Policy struct {
	OwnerLogin                string
	AllowedNodeIDs            map[string]struct{}
	GatewayNodeID, HostNodeID string
}

func valid(p Policy) bool {
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
func Protect(next http.Handler, lookup WhoIs, p Policy) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if lookup == nil || !valid(p) {
			http.Error(w, "service unavailable", 503)
			return
		}
		addr := r.RemoteAddr
		if addr == "" || strings.ContainsAny(addr, " \t\r\n") {
			http.Error(w, "forbidden", 403)
			return
		}
		peer, err := lookup.WhoIs(r.Context(), addr)
		if err != nil || peer.Login == "" || peer.NodeID == "" || peer.Login != p.OwnerLogin || len(peer.Tags) != 0 || peer.NodeID == p.GatewayNodeID || peer.NodeID == p.HostNodeID {
			http.Error(w, "forbidden", 403)
			return
		}
		if _, ok := p.AllowedNodeIDs[peer.NodeID]; !ok {
			http.Error(w, "forbidden", 403)
			return
		}
		next.ServeHTTP(w, r)
	})
}
