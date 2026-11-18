package ingress

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"sync"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const integrationOwner = "bridge-owner@example.test"

type integrationWhoIs struct{}
func (integrationWhoIs) WhoIs(context.Context, string) (Peer, error) {
	return Peer{Login: integrationOwner, NodeID: "approved-node"}, nil
}

func TestGoProxyToNodeCoreHTTPAndWebSocket(t *testing.T) {
	if os.Getenv("TAILNET_BRIDGE_E2E") != "1" { t.Skip("set TAILNET_BRIDGE_E2E=1 in the disposable Linux ARM64 lane after building the SO_PEERCRED addon") }
	if os.Geteuid() == 0 { t.Fatal("run integration test as an unprivileged dedicated service UID") }
	pilotUID, err := strconv.Atoi(os.Getenv("PILOT_SERVICE_UID"))
	if err != nil || pilotUID <= 0 || pilotUID == os.Geteuid() { t.Fatal("set PILOT_SERVICE_UID to a valid UID distinct from the test service UID") }
	home, err := os.UserHomeDir(); if err != nil { t.Fatal(err) }
	privateDir, err := os.MkdirTemp(home, ".tailnet-bridge-test-"); if err != nil { t.Fatal(err) }
	defer os.RemoveAll(privateDir)
	if err := os.Chmod(privateDir, 0700); err != nil { t.Fatal(err) }
	socketPath := filepath.Join(privateDir, "core.sock")

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader); if err != nil { t.Fatal(err) }
	privatePath := filepath.Join(privateDir, "assertion.key")
	if err := os.WriteFile(privatePath, privateKey, 0600); err != nil { t.Fatal(err) }
	der, err := x509.MarshalPKIXPublicKey(publicKey); if err != nil { t.Fatal(err) }
	publicPath := filepath.Join(privateDir, "assertion.pub")
	if err := os.WriteFile(publicPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}), 0600); err != nil { t.Fatal(err) }

	var observedPath string
	var observedHeaders http.Header
	var observedMu sync.Mutex
	preview := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			conn, rw, err := w.(http.Hijacker).Hijack()
			if err != nil { return }
			_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n")
			_ = rw.Flush()
			_, _ = io.Copy(conn, conn)
			_ = conn.Close()
			return
		}
		observedMu.Lock(); observedPath = r.URL.RequestURI(); observedHeaders = r.Header.Clone(); observedMu.Unlock()
		w.Write([]byte("preview-http"))
	}))
	defer preview.Close()
	previewPort, err := strconv.Atoi(strings.Split(preview.Listener.Addr().String(), ":")[1]); if err != nil { t.Fatal(err) }

	command := exec.Command("node", "private-server.js")
	command.Dir = filepath.Join("..", "gateway")
	command.Env = []string{
		"PATH="+os.Getenv("PATH"),
		"HOME="+home,
		"PREVIEW_CORE_SOCKET="+socketPath,
		"INGRESS_ASSERTION_PUBLIC_KEY_FILE="+publicPath,
		"GATEWAY_SERVICE_UID="+strconv.Itoa(os.Geteuid()),
		"PILOT_SERVICE_UID="+strconv.Itoa(pilotUID),
		"TAILNET_OWNER_LOGIN="+integrationOwner,
		"TAILNET_ALLOWED_REMOTE_NODE_IDS=approved-node",
		"TAILNET_GATEWAY_NODE_ID=gateway-node",
		"TAILNET_HOST_NODE_ID=host-node",
		"PREVIEW_CONTROL_HOST=control.example.com",
		"PREVIEW_DOMAIN=preview.example.net",
		"DASHBOARD_ORIGIN=https://dashboard.example.org",
		"PREVIEW_PRIVATE_IPV4=127.0.0.1",
		"PREVIEW_ALLOWED_PORTS="+strconv.Itoa(previewPort),
	}
	command.Stdout = io.Discard; command.Stderr = os.Stderr
	if err := command.Start(); err != nil { t.Fatal(err) }
	processDone := make(chan error, 1)
	go func() { processDone <- command.Wait() }()
	defer func() { _ = command.Process.Kill() }()
	deadline := time.Now().Add(10*time.Second)
	for time.Now().Before(deadline) {
		if info, err := os.Lstat(socketPath); err == nil && info.Mode()&os.ModeSocket != 0 { break }
		select { case err := <-processDone: t.Fatalf("Node core exited before socket ready: %v", err); default: }
		time.Sleep(20*time.Millisecond)
	}
	if _, err := os.Lstat(socketPath); err != nil { t.Fatalf("Node private socket not ready: %v", err) }

	key, err := PrivateAssertionKey(privatePath, os.Geteuid(), pilotUID); if err != nil { t.Fatal(err) }
	handler, err := UnixForwarder(socketPath, key, os.Geteuid(), pilotUID); if err != nil { t.Fatal(err) }
	policy := Policy{OwnerLogin: integrationOwner, AllowedNodeIDs: map[string]struct{}{"approved-node": {}}, GatewayNodeID: "gateway-node", HostNodeID: "host-node"}
	ingress := httptest.NewServer(Protect(handler, integrationWhoIs{}, policy))
	defer ingress.Close()
	client := ingress.Client()

	management, err := http.NewRequest(http.MethodPost, ingress.URL+"/__gateway/routes", strings.NewReader(fmt.Sprintf(`{"port":%d}`, previewPort)))
	if err != nil { t.Fatal(err) }
	management.Host = "control.example.com"
	management.Header.Set("Origin", "https://control.example.com")
	management.Header.Set("Content-Type", "application/json")
	management.Header.Set("X-Gateway-CSRF", "same-origin")
	createdResponse, err := client.Do(management); if err != nil { t.Fatal(err) }
	var route struct { Host string `json:"host"`; Origin string `json:"origin"` }
	if createdResponse.StatusCode != http.StatusCreated { body, _ := io.ReadAll(createdResponse.Body); createdResponse.Body.Close(); t.Fatalf("route creation status %d: %s", createdResponse.StatusCode, body) }
	if err := json.NewDecoder(createdResponse.Body).Decode(&route); err != nil { t.Fatal(err) }; createdResponse.Body.Close()

	rawPath := "/%E2%9C%93/%2F?query=a%2Fb&reserved=%25"
	request, _ := http.NewRequest(http.MethodGet, ingress.URL+rawPath, nil)
	request.Host = route.Host
	request.Header.Set("Origin", route.Origin)
	request.Header.Set("Forwarded", "for=192.0.2.1;proto=https")
	request.Header.Set("Tailscale-User-Login", "forged@example.test")
	request.Header.Set("X-Tailscale-User-Login", "forged@example.test")
	request.Header.Set("X-Auth-Request-User", "forged@example.test")
	request.Header.Set("X-Forwarded-For", "192.0.2.2")
	response, err := client.Do(request); if err != nil { t.Fatal(err) }
	body, _ := io.ReadAll(response.Body); response.Body.Close()
	if response.StatusCode != http.StatusOK || string(body) != "preview-http" { t.Fatalf("preview HTTP status=%d body=%q", response.StatusCode, body) }
	observedMu.Lock()
	gotPath := observedPath
	gotHeaders := observedHeaders.Clone()
	observedMu.Unlock()
	if gotPath != rawPath { t.Fatalf("escaped path/query changed: got %q want %q", gotPath, rawPath) }
	for _, name := range []string{"Forwarded", "Tailscale-User-Login", "X-Tailscale-User-Login", "X-Auth-Request-User", "X-Forwarded-For", assertionHeader} {
		if gotHeaders.Get(name) != "" { t.Errorf("untrusted header reached preview upstream: %s=%q", name, gotHeaders.Get(name)) }
	}

	if err := responseUpgradeTest(ingress.Listener.Addr().String(), route.Host, route.Origin); err != nil { t.Fatal(err) }
}

func responseUpgradeTest(ingressAddr, host, origin string) error {
	conn, err := net.Dial("tcp", ingressAddr); if err != nil { return err }; defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5*time.Second))
	_, err = fmt.Fprintf(conn, "GET /hmr?ws=%%2F HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nForwarded: for=192.0.2.3\r\nTailscale-User-Login: forged\r\n\r\n", host, origin)
	if err != nil { return err }
	reader := bufio.NewReader(conn)
	status, err := reader.ReadString('\n'); if err != nil { return err }
	if !strings.Contains(status, "101 Switching Protocols") { return fmt.Errorf("WebSocket upgrade failed: %s", strings.TrimSpace(status)) }
	for { line, err := reader.ReadString('\n'); if err != nil { return err }; if line == "\r\n" { break } }
	probe := []byte("tcp-upgrade-echo")
	if _, err := conn.Write(probe); err != nil { return err }
	echo := make([]byte, len(probe))
	if _, err := io.ReadFull(reader, echo); err != nil { return err }
	if string(echo) != string(probe) { return fmt.Errorf("WebSocket tunneled data mismatch: %q", echo) }
	return nil
}
