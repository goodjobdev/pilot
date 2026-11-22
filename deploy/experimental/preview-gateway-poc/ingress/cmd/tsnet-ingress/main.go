// Command ingress starts the independent tsnet node and authenticated private-core bridge.
package main

import (
	"context"
	"crypto/tls"
	"errors"
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
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	if err := run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		log.Print(err)
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	if err := validateKeylessEnvironment(os.Environ()); err != nil {
		return err
	}
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
	if err := validateEnrolledState(stateDir, serviceUID); err != nil {
		return err
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

	readyCtx, cancelReady := context.WithTimeout(ctx, startupTimeout)
	defer cancelReady()
	if err := readyCtx.Err(); err != nil {
		return err
	}
	ts := &tsnet.Server{
		Dir: stateDir, Hostname: hostname,
		UserLogf: func(string, ...any) {}, // do not put potential login URLs in the service log
	}
	var closeOnce sync.Once
	var closeErr error
	closeNode := func() error {
		closeOnce.Do(func() { closeErr = ts.Close() })
		return closeErr
	}
	defer func() { _ = closeNode() }()

	// LocalClient starts tsnet synchronously; the outer supervisor also bounds
	// startup so a stuck library initialization cannot hang the container.
	client, err := ts.LocalClient()
	if err != nil {
		return errors.New("could not start pre-enrolled gateway node")
	}
	nodeName, err := waitForNode(readyCtx, client.StatusWithoutPeers, expectedNode, gatewayID, statusInterval)
	cancelReady()
	if err != nil {
		return fmt.Errorf("gateway startup: %w", err)
	}
	nodeCertificate, err := ingress.NewNodeCertificate(nodeName, client.GetCertificate)
	if err != nil {
		return fmt.Errorf("invalid gateway node certificate configuration: %w", err)
	}
	lookup, err := ingress.NewTsnetWhoIs(client)
	if err != nil {
		return err
	}
	app, err := ingress.UnixForwarder(socketPath, key, serviceUID, pilotUID)
	if err != nil {
		return fmt.Errorf("invalid preview core bridge: %w", err)
	}

	servers := make([]*http.Server, 0, len(ports))
	listeners := make([]net.Listener, 0, len(ports))
	defer func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}()
	for _, port := range ports {
		if err := ctx.Err(); err != nil {
			return err
		}
		handler := ingress.RequireHostMatchesNode(app, nodeCertificate.Hostname(), port)
		handler = ingress.Protect(handler, lookup, policy)
		tailnetListener, listenErr := ts.Listen("tcp", fmt.Sprintf(":%d", port))
		if listenErr != nil {
			return fmt.Errorf("cannot listen on tailnet preview port %d: %w", port, listenErr)
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

	if err := ctx.Err(); err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, readyLine) // exact supervisor protocol; diagnostics stay on stderr
	if err := serveAll(ctx, servers, listeners, 25*time.Second, closeNode); err != nil {
		return fmt.Errorf("tailnet preview listener stopped: %w", err)
	}
	return nil
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
