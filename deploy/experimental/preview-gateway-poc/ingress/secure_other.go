//go:build !linux

package ingress

import (
	"fmt"
	"net"
)

func ValidateTsnetStateDirectory(string, int, int) error { return fmt.Errorf("tsnet state directory validation requires Linux UID and no-follow support") }
func readPrivateKey(string, int, int) ([]byte, error) { return nil, fmt.Errorf("private assertion key access requires Linux O_NOFOLLOW/fstat support") }
func ReadOwnerTLSMaterial(string, string, int, int) ([]byte, []byte, error) { return nil, nil, fmt.Errorf("owner TLS material validation requires Linux UID and no-follow support") }
func validateSocketPath(string, int, int) error { return fmt.Errorf("private socket path validation requires Linux UID support") }
func verifySocketPeer(net.Conn, int) error { return fmt.Errorf("SO_PEERCRED is unavailable on this platform") }
