//go:build linux

package ingress

import (
	"crypto/ed25519"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func privateTestDir(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir(); if err != nil { t.Fatal(err) }
	dir, err := os.MkdirTemp(home, ".bridge-boundary-test-"); if err != nil { t.Fatal(err) }
	if err := os.Chmod(dir, 0700); err != nil { t.Fatal(err) }
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}

func TestTsnetStateDirectoryRequiresProtectedServiceOwnedPath(t *testing.T) {
	dir := privateTestDir(t)
	stateDir := filepath.Join(dir, "state")
	if err := os.Mkdir(stateDir, 0700); err != nil { t.Fatal(err) }
	uid := os.Geteuid()
	if err := ValidateTsnetStateDirectory(stateDir, uid, uid+1); err != nil { t.Fatalf("valid state directory rejected: %v", err) }
	if err := ValidateTsnetStateDirectory("relative/state", uid, uid+1); err == nil { t.Fatal("relative state directory accepted") }
	if err := ValidateTsnetStateDirectory(stateDir, uid, uid); err == nil { t.Fatal("shared service/Pilot UID accepted") }

	stateLink := filepath.Join(dir, "state-link")
	if err := os.Symlink(stateDir, stateLink); err != nil { t.Fatal(err) }
	if err := ValidateTsnetStateDirectory(stateLink, uid, uid+1); err == nil { t.Fatal("symlinked state directory accepted") }
	parentLink := dir + "-link"
	if err := os.Symlink(dir, parentLink); err != nil { t.Fatal(err) }
	defer os.Remove(parentLink)
	if err := ValidateTsnetStateDirectory(filepath.Join(parentLink, "state"), uid, uid+1); err == nil { t.Fatal("symlinked state ancestor accepted") }

	if err := os.Chmod(stateDir, 0770); err != nil { t.Fatal(err) }
	if err := ValidateTsnetStateDirectory(stateDir, uid, uid+1); err == nil { t.Fatal("Pilot/group-writable state directory accepted") }
	if err := os.Chmod(stateDir, 0750); err != nil { t.Fatal(err) }
	if err := ValidateTsnetStateDirectory(stateDir, uid, uid+1); err == nil { t.Fatal("group-readable state directory accepted") }
	if err := os.Chmod(stateDir, 0700); err != nil { t.Fatal(err) }
	if err := os.Chmod(dir, 0777); err != nil { t.Fatal(err) }
	if err := ValidateTsnetStateDirectory(stateDir, uid, uid+1); err == nil { t.Fatal("writable state ancestor accepted") }
}

func TestPrivateAssertionKeyRejectsSymlinkAndUnsafeMode(t *testing.T) {
	dir := privateTestDir(t)
	keyPath := filepath.Join(dir, "key")
	if err := os.WriteFile(keyPath, make([]byte, ed25519.PrivateKeySize), 0600); err != nil { t.Fatal(err) }
	uid := os.Geteuid()
	if _, err := PrivateAssertionKey(keyPath, uid, uid+1); err != nil { t.Fatalf("valid key rejected: %v", err) }
	link := filepath.Join(dir, "key-link")
	if err := os.Symlink(keyPath, link); err != nil { t.Fatal(err) }
	if _, err := PrivateAssertionKey(link, uid, uid+1); err == nil { t.Fatal("symlink key accepted") }
	parentLink := dir + "-link"
	if err := os.Symlink(dir, parentLink); err != nil { t.Fatal(err) }
	defer os.Remove(parentLink)
	if _, err := PrivateAssertionKey(filepath.Join(parentLink, "key"), uid, uid+1); err == nil { t.Fatal("symlinked parent directory accepted") }
	if err := os.Chmod(keyPath, 0644); err != nil { t.Fatal(err) }
	if _, err := PrivateAssertionKey(keyPath, uid, uid+1); err == nil { t.Fatal("group/world-readable key accepted") }
}

func TestUnixForwarderRequiresProtectedSocketAndPeerUID(t *testing.T) {
	dir := privateTestDir(t)
	path := filepath.Join(dir, "core.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"}); if err != nil { t.Fatal(err) }
	defer listener.Close()
	if err := os.Chmod(path, 0600); err != nil { t.Fatal(err) }
	uid := os.Geteuid()
	if err := validateSocketPath(path, uid, uid+1); err != nil { t.Fatalf("valid socket rejected: %v", err) }
	link := filepath.Join(dir, "socket-link")
	if err := os.Symlink(path, link); err != nil { t.Fatal(err) }
	if err := validateSocketPath(link, uid, uid+1); err == nil { t.Fatal("symlinked socket accepted") }
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"}); if err != nil { t.Fatal(err) }
	defer client.Close()
	server, err := listener.AcceptUnix(); if err != nil { t.Fatal(err) }
	defer server.Close()
	if err := verifySocketPeer(client, uid); err != nil { t.Fatalf("valid peer rejected: %v", err) }
	if err := verifySocketPeer(client, uid+1); err == nil { t.Fatal("unexpected peer UID accepted") }
}

func TestUntrustedIdentityHeaderFamilies(t *testing.T) {
	for _, name := range []string{"Forwarded", "Forwarded-For", "Tailscale-User-Login", "X-Tailscale-User-Login", "X-Pilot-Claim", "X-Forwarded-For", "Authorization", "X-Auth-Request-User", "Remote-User", "tAiLsCaLe-User-Login", "X-AuTh-ReQuEsT-User"} {
		if !untrustedIdentityHeader(name) { t.Errorf("identity header not marked untrusted: %s", name) }
	}
	for _, name := range []string{"Accept", "Content-Type", "Sec-WebSocket-Key", "X-Gateway-CSRF"} {
		if untrustedIdentityHeader(name) { t.Errorf("application header unexpectedly stripped: %s", name) }
	}
}
