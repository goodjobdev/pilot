// Command ingress starts the independent tsnet node and authenticated private-core bridge.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"tailscale.com/tsnet"

	"pilot-tsnet-ingress"
)

func required(name string) string {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		log.Fatalf("required environment variable %s is unset", name)
	}
	return v
}

func main() {
	stateDir := required("TSNET_STATE_DIR")
	hostname := required("TSNET_HOSTNAME")
	owner := required("TAILNET_OWNER_LOGIN")
	gatewayID := required("TAILNET_GATEWAY_NODE_ID")
	hostID := required("TAILNET_HOST_NODE_ID")
	ids := strings.Split(required("TAILNET_ALLOWED_REMOTE_NODE_IDS"), ",")
	allowed := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			log.Fatal("empty remote node ID in allowlist")
		}
		allowed[id] = struct{}{}
	}
	policy := ingress.Policy{OwnerLogin: owner, AllowedNodeIDs: allowed, GatewayNodeID: gatewayID, HostNodeID: hostID}
	if !policyValid(policy) {
		log.Fatal("invalid identity policy; gateway/host IDs must be distinct and excluded from approved remote IDs")
	}
	serviceUID, err := strconv.Atoi(required("GATEWAY_SERVICE_UID"))
	if err != nil || serviceUID <= 0 || serviceUID != os.Geteuid() {
		log.Fatal("process must run as configured non-root gateway service UID")
	}
	pilotUID, err := strconv.Atoi(required("PILOT_SERVICE_UID"))
	if err != nil || pilotUID <= 0 || pilotUID == serviceUID {
		log.Fatal("Pilot UID must be valid and distinct from gateway service UID")
	}
	if err := ingress.ValidateTsnetStateDirectory(stateDir, serviceUID, pilotUID); err != nil {
		log.Fatalf("invalid tsnet state directory: %v", err)
	}
	keyPath := required("INGRESS_ASSERTION_KEY_FILE")
	socketPath := required("PREVIEW_CORE_SOCKET")
	key, err := ingress.PrivateAssertionKey(keyPath, serviceUID, pilotUID)
	if err != nil {
		log.Fatalf("invalid assertion key file: %v", err)
	}
	if err := ingress.ValidatePrivateSocketPath(socketPath, serviceUID, pilotUID); err != nil {
		log.Fatalf("invalid preview-core socket: %v", err)
	}
	// Previews are selected by port on the gateway node's own tailnet name: no
	// wildcard certificate, no owner DNS, no SNI dispatch beyond the exact name.
	expectedNode := required("PREVIEW_DOMAIN")
	ports, err := ingress.ParsePreviewPorts(required("PREVIEW_PORTS"), 0)
	if err != nil {
		log.Fatalf("invalid preview ports: %v", err)
	}

	ts := &tsnet.Server{Dir: stateDir, Hostname: hostname}
	if err := ts.Start(); err != nil {
		log.Fatal(err)
	}
	client, err := ts.LocalClient()
	if err != nil {
		log.Fatal(err)
	}
	status, err := client.Status(context.Background())
	if err != nil || status.Self == nil || status.Self.DNSName == "" {
		log.Fatal("cannot read the gateway's tailnet DNS name")
	}
	nodeName := strings.TrimSuffix(status.Self.DNSName, ".")
	if !strings.EqualFold(nodeName, expectedNode) {
		_ = ts.Close()
		log.Fatalf("gateway tailnet name %q does not match the reviewed PREVIEW_DOMAIN", nodeName)
	}
	nodeCertificate, err := ingress.NewNodeCertificate(nodeName, client.GetCertificate)
	if err != nil {
		log.Fatalf("invalid gateway node certificate configuration: %v", err)
	}
	lookup, err := ingress.NewTsnetWhoIs(client)
	if err != nil {
		log.Fatal(err)
	}
	app, err := ingress.UnixForwarder(socketPath, key, serviceUID, pilotUID)
	if err != nil {
		log.Fatalf("invalid preview core bridge: %v", err)
	}

	shutdownCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	ctx, cancel := context.WithCancel(shutdownCtx)
	defer cancel()

	var closeOnce sync.Once
	var closeErr error
	closeNode := func() error {
		closeOnce.Do(func() { closeErr = ts.Close() })
		return closeErr
	}
	defer func() { _ = closeNode() }()

	servers := make([]*http.Server, 0, len(ports))
	listeners := make([]net.Listener, 0, len(ports))
	for _, port := range ports {
		handler := ingress.RequireHostMatchesNode(app, nodeCertificate.Hostname(), port)
		handler = ingress.Protect(handler, lookup, policy)
		tailnetListener, listenErr := ts.Listen("tcp", fmt.Sprintf(":%d", port))
		if listenErr != nil {
			cancel()
			log.Fatalf("cannot listen on tailnet preview port %d: %v", port, listenErr)
		}
		servers = append(servers, &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			IdleTimeout:       60 * time.Second,
			MaxHeaderBytes:    32 << 10,
		})
		listeners = append(listeners, tls.NewListener(tailnetListener, &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: nodeCertificate.GetCertificate,
		}))
		log.Printf("tailnet preview listener ready on https://%s:%d", nodeCertificate.Hostname(), port)
	}

	log.Printf("%s on %d preview listeners", readyLine, len(servers))
	if err := serveAll(ctx, servers, listeners, 25*time.Second, closeNode); err != nil {
		log.Printf("tailnet preview listener stopped: %v", err)
		os.Exit(1)
	}
}

// Keep policy validation exposed only to this executable's startup path.
func policyValid(p ingress.Policy) bool {
	// Protect returns 503 for invalid policy; perform explicit startup validation.
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
