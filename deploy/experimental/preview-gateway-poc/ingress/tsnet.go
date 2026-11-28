package ingress

import (
	"context"
	"fmt"

	"tailscale.com/client/local"
	"tailscale.com/client/tailscale/apitype"
)

// TsnetWhoIs adapts the tsnet node's own LocalAPI. It does not use the host
// tailscaled socket.
type TsnetWhoIs struct{ client *local.Client }

func NewTsnetWhoIs(client *local.Client) (*TsnetWhoIs, error) {
	if client == nil {
		return nil, fmt.Errorf("nil tsnet LocalAPI client")
	}
	return &TsnetWhoIs{client: client}, nil
}

func (t *TsnetWhoIs) WhoIs(ctx context.Context, remoteAddr string) (Peer, error) {
	result, err := t.client.WhoIs(ctx, remoteAddr)
	if err != nil {
		return Peer{}, err
	}
	return peerFromWhoIs(result)
}

func peerFromWhoIs(result *apitype.WhoIsResponse) (Peer, error) {
	if result == nil || result.Node == nil || result.UserProfile == nil {
		return Peer{}, fmt.Errorf("WhoIs returned incomplete identity")
	}
	stableNodeID := string(result.Node.StableID)
	peer := Peer{Login: result.UserProfile.LoginName, NodeID: stableNodeID, Tags: append([]string(nil), result.Node.Tags...)}
	if peer.Login == "" || peer.NodeID == "" {
		return Peer{}, fmt.Errorf("WhoIs returned empty identity")
	}
	return peer, nil
}
