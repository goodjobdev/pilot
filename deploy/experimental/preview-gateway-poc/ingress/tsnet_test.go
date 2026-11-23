package ingress

import (
	"testing"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/tailcfg"
)

func TestPeerFromWhoIsUsesStableNodeID(t *testing.T) {
	response := &apitype.WhoIsResponse{
		Node: &tailcfg.Node{
			ID:       42,
			StableID: tailcfg.StableNodeID("stable-approved-device"),
		},
		UserProfile: &tailcfg.UserProfile{LoginName: "owner@example.test"},
	}

	peer, err := peerFromWhoIs(response)
	if err != nil {
		t.Fatalf("peerFromWhoIs returned error: %v", err)
	}
	if peer.NodeID != string(response.Node.StableID) {
		t.Fatalf("NodeID = %q; want stable ID %q", peer.NodeID, response.Node.StableID)
	}
	if peer.NodeID == response.Node.ID.String() {
		t.Fatalf("NodeID %q is numeric Node.ID, want StableID", peer.NodeID)
	}
}

func TestPeerFromWhoIsRejectsMissingStableNodeID(t *testing.T) {
	response := &apitype.WhoIsResponse{
		Node:        &tailcfg.Node{ID: 42},
		UserProfile: &tailcfg.UserProfile{LoginName: "owner@example.test"},
	}

	if peer, err := peerFromWhoIs(response); err == nil {
		t.Fatalf("peerFromWhoIs returned peer with missing StableID: %+v", peer)
	}
}
