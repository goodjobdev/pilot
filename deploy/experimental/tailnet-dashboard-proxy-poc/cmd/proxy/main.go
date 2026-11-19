// POC process; it is intentionally opt-in and must run under a dedicated UID.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	gateway "pilot-tailnet-dashboard-proxy"
	"pilot-tailnet-dashboard-proxy/ingress"
	"tailscale.com/tsnet"
)

func required(k string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		panic("missing required " + k)
	}
	return v
}

func validServiceUID(serviceUID, pilotUID int) bool {
	return serviceUID > 0 && pilotUID >= 0 && serviceUID != pilotUID
}

func protectedPath(path string, wantDir bool, uid int) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return fmt.Errorf("protected path must be a canonical absolute path")
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	if resolved != path {
		return fmt.Errorf("protected path traverses a symlink")
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("protected path must not be a symlink")
	}
	if wantDir && !info.IsDir() {
		return fmt.Errorf("state path is not a directory")
	}
	if !wantDir && !info.Mode().IsRegular() {
		return fmt.Errorf("key path is not a regular file")
	}
	if wantDir && info.Mode().Perm()&0700 != 0700 {
		return fmt.Errorf("state directory must be owner-readable, writable and searchable")
	}
	if !wantDir && info.Mode().Perm()&0400 == 0 {
		return fmt.Errorf("key file must be owner-readable")
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("protected path is accessible to group/other")
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(st.Uid) != uid {
		return fmt.Errorf("protected path is not owned by service UID")
	}
	return nil
}

func main() {
	if os.Getenv("PILOT_TAILNET_DASHBOARD_PROXY") != "1" {
		panic("set PILOT_TAILNET_DASHBOARD_PROXY=1 to opt in")
	}
	serviceUID := os.Geteuid()
	pilotUID, err := strconv.Atoi(required("PILOT_SERVICE_UID"))
	if err != nil || !validServiceUID(serviceUID, pilotUID) {
		panic("gateway must run as a non-root UID distinct from PILOT_SERVICE_UID")
	}
	state := required("TSNET_STATE_DIR")
	if err := protectedPath(state, true, serviceUID); err != nil {
		panic("unsafe tsnet state path: " + err.Error())
	}
	owner := required("TAILNET_OWNER_LOGIN")
	ids := strings.Split(required("TAILNET_ALLOWED_REMOTE_NODE_IDS"), ",")
	allowed := map[string]struct{}{}
	for _, id := range ids {
		id = strings.TrimSpace(id)
		if id == "" {
			panic("empty approved stable node ID")
		}
		allowed[id] = struct{}{}
	}
	policy := ingress.Policy{OwnerLogin: owner, AllowedNodeIDs: allowed, GatewayNodeID: required("TAILNET_GATEWAY_NODE_ID"), HostNodeID: required("TAILNET_HOST_NODE_ID")}
	dest, err := netip.ParseAddrPort(required("DASHBOARD_PRIVATE_ADDRPORT"))
	if err != nil {
		panic(err)
	}
	keyPath := required("GATEWAY_ED25519_PRIVATE_KEY_FILE")
	if err := protectedPath(keyPath, false, serviceUID); err != nil {
		panic("unsafe signing key path: " + err.Error())
	}
	raw, err := os.ReadFile(keyPath)
	if err != nil {
		panic(err)
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		panic("invalid signing key PEM")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		panic(err)
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok {
		panic("signing key must be Ed25519")
	}

	node := &tsnet.Server{Dir: state, Hostname: required("TSNET_HOSTNAME")}
	if err := node.Start(); err != nil {
		panic(err)
	}
	defer node.Close()
	client, err := node.LocalClient()
	if err != nil {
		panic(err)
	}
	lookup, err := gateway.NewTsnetWhoIs(client)
	if err != nil {
		panic(err)
	}
	g, err := gateway.New(gateway.Config{Lookup: lookup, Policy: policy, Destination: dest, DashboardHost: required("DASHBOARD_PRIVATE_HOST"), DashboardOrigin: required("DASHBOARD_ORIGIN"), Issuer: required("TAILNET_GATEWAY_ISSUER"), Audience: required("TAILNET_GATEWAY_AUD"), Owner: owner, SigningKey: key})
	if err != nil {
		panic(err)
	}
	defer g.Close()
	ln, err := node.ListenTLS("tcp", ":443")
	if err != nil {
		panic(err)
	}
	server := &http.Server{Handler: g.Handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 32 << 10}
	done := make(chan error, 1)
	go func() { done <- server.Serve(ln) }()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-done:
		if !errors.Is(err, http.ErrServerClosed) {
			panic(err)
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := server.Shutdown(shutdown)
		if err != nil {
			_ = server.Close()
		}
		_ = ln.Close()
		g.Close()
		if err != nil {
			panic(fmt.Errorf("shutdown: %w", err))
		}
	}
}
