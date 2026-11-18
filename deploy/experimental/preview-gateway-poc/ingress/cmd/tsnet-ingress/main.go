// Command ingress starts the independent tsnet node and authenticated private-core bridge.
package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"log"
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
	if err != nil || serviceUID <= 0 || serviceUID != os.Geteuid() { log.Fatal("process must run as configured non-root gateway service UID") }
	pilotUID, err := strconv.Atoi(required("PILOT_SERVICE_UID"))
	if err != nil || pilotUID <= 0 || pilotUID == serviceUID { log.Fatal("Pilot UID must be valid and distinct from gateway service UID") }
	if err := ingress.ValidateTsnetStateDirectory(stateDir, serviceUID, pilotUID); err != nil { log.Fatalf("invalid tsnet state directory: %v", err) }
	keyPath := required("INGRESS_ASSERTION_KEY_FILE")
	socketPath := required("PREVIEW_CORE_SOCKET")
	key, err := ingress.PrivateAssertionKey(keyPath, serviceUID, pilotUID)
	if err != nil { log.Fatalf("invalid assertion key file: %v", err) }
	if err := ingress.ValidatePrivateSocketPath(socketPath, serviceUID, pilotUID); err != nil { log.Fatalf("invalid preview-core socket: %v", err) }
	previewDomain := required("PREVIEW_DOMAIN")
	previewCertificates, err := ingress.NewPreviewCertificateStore(
		required("PREVIEW_TLS_CERT_FILE"), required("PREVIEW_TLS_KEY_FILE"), serviceUID, pilotUID, previewDomain, nil,
	)
	if err != nil { log.Fatalf("invalid owner preview certificate configuration: %v", err) }

	ts := &tsnet.Server{Dir: stateDir, Hostname: hostname}
	if err := ts.Start(); err != nil {
		log.Fatal(err)
	}
	client, err := ts.LocalClient()
	if err != nil {
		log.Fatal(err)
	}
	lookup, err := ingress.NewTsnetWhoIs(client)
	if err != nil {
		log.Fatal(err)
	}
	app, err := ingress.UnixForwarder(socketPath, key, serviceUID, pilotUID)
	if err != nil { log.Fatalf("invalid preview core bridge: %v", err) }
	handler := ingress.RequireHostMatchesSNI(app)
	handler = ingress.Protect(handler, lookup, policy)
	selector, err := ingress.NewCertificateSelector(ts.CertDomains(), previewDomain,
		func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) { return client.GetCertificate(hello) },
		previewCertificates.GetCertificate,
	)
	if err != nil { log.Fatalf("invalid TLS certificate selector configuration: %v", err) }
	tailnetListener, err := ts.Listen("tcp", ":443")
	if err != nil { log.Fatal(err) }
	tlsListener := tls.NewListener(tailnetListener, &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: selector.GetCertificate,
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	reload := make(chan os.Signal, 1)
	signal.Notify(reload, syscall.SIGHUP)
	defer signal.Stop(reload)
	shutdownCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	go func() {
		for range reload {
			if err := previewCertificates.Reload(); err != nil {
				log.Printf("owner preview TLS reload failed; preview certificate is unavailable until a valid pair is loaded")
			} else {
				log.Printf("owner preview TLS certificate reloaded")
			}
		}
	}()
	log.Printf("tsnet HTTPS ingress ready on %s; preview forwarding uses protected Unix socket", fmt.Sprintf("https://%s", hostname))
	var closeOnce sync.Once
	var closeErr error
	closeNode := func() error {
		closeOnce.Do(func() { closeErr = ts.Close() })
		return closeErr
	}
	defer func() { _ = closeNode() }()
	if err := serveHTTPS(shutdownCtx, server, tlsListener, 25*time.Second, closeNode); err != nil {
		log.Printf("tsnet HTTPS ingress stopped: %v", err)
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
