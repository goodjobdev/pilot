// Disposable harness: the real gateway handler (injected WhoIs) against the real dashboard bundle.
package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"strings"
	"time"

	gateway "pilot-tailnet-dashboard-proxy"
	"pilot-tailnet-dashboard-proxy/ingress"
)

type who struct{ peer ingress.Peer }

func (w who) WhoIs(context.Context, string) (ingress.Peer, error) { return w.peer, nil }

func token(key ed25519.PrivateKey, iss, aud, sub, owner string, iat, exp int64, jti string) string {
	payload, _ := json.Marshal(map[string]any{"iss": iss, "aud": aud, "sub": sub, "owner": owner, "iat": iat, "exp": exp, "jti": jti})
	head := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	body := head + "." + base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, []byte(body)))
}

func main() {
	dashboard := flag.String("dashboard", "127.0.0.1:4319", "dashboard loopback address")
	serverCmd := flag.String("server", "", "dashboard server bundle")
	stateDir := flag.String("state", "", "dashboard data directory")
	flag.Parse()

	dir, _ := os.MkdirTemp("", "gwk-")
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKCS8PrivateKey(key)
	os.WriteFile(dir+"/assertion.key", pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}), 0o600)
	pubDER, _ := x509.MarshalPKIXPublicKey(key.Public())
	pubPEM := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER})

	manifest := dir + "/release.json"
	os.WriteFile(manifest, []byte(`{"version":"0.1.0","releaseId":"e2e-20261119","schemaId":"pilot-state-1","createdAt":"2026-11-19T00:00:00Z"}`), 0o444)
	server := exec.Command("node", *serverCmd)
	server.Env = append(os.Environ(),
		"DASHBOARD_MODE=hosted", "DASHBOARD_EXPOSURE=container-private-interface",
		"DASHBOARD_BIND=0.0.0.0", "PORT=4319", "DASHBOARD_DATA="+*stateDir,
		"DASHBOARD_ORIGIN=https://dashboard.example.test", "DASHBOARD_OWNER=owner@example.test",
		"DASHBOARD_RELEASE_MANIFEST="+manifest,
		"DASHBOARD_IDENTITY_PROVIDER=tailnet-gateway",
		"TAILNET_GATEWAY_ISSUER=https://gateway.example.test",
		"TAILNET_GATEWAY_AUD=pilot-dashboard",
		"TAILNET_GATEWAY_PUBLIC_KEY="+string(pubPEM),
	)
	server.Stdout, server.Stderr = os.Stdout, os.Stderr
	if err := server.Start(); err != nil { panic(err) }
	defer server.Process.Kill()
	time.Sleep(2 * time.Second)

	base := gateway.Config{
		Lookup: who{ingress.Peer{Login: "owner@example.test", NodeID: "approved"}},
		Policy: ingress.Policy{OwnerLogin: "owner@example.test", AllowedNodeIDs: map[string]struct{}{"approved": {}}, GatewayNodeID: "gateway", HostNodeID: "host"},
		Destination: netip.MustParseAddrPort(*dashboard), DashboardHost: "dashboard.example.test",
		DashboardOrigin: "https://dashboard.example.test", Issuer: "https://gateway.example.test",
		Audience: "pilot-dashboard", Owner: "owner@example.test", SigningKey: key,
	}
	serve := func(addr string, cfg gateway.Config) *gateway.Gateway {
		g, err := gateway.New(cfg)
		if err != nil { panic(err) }
		s := &http.Server{Addr: addr, Handler: g.Handler}
		go s.ListenAndServe()
		time.Sleep(250 * time.Millisecond)
		return g
	}
	g := serve("127.0.0.1:4318", base)
	defer g.Close()

	client := &http.Client{Timeout: 10 * time.Second}
	hit := func(url, host string, headers map[string]string) int {
		req, _ := http.NewRequest("GET", url, nil)
		req.Host = host
		for k, v := range headers { req.Header.Set(k, v) }
		res, err := client.Do(req)
		if err != nil { return 0 }
		defer res.Body.Close()
		return res.StatusCode
	}
	fail := 0
	check := func(name string, got, want int) {
		status := "PASS"
		if got != want { status = "FAIL"; fail++ }
		fmt.Printf("%s %-58s got=%d want=%d\n", status, name, got, want)
	}

	now := time.Now().Unix()
	good := token(key, base.Issuer, base.Audience, base.Owner, base.Owner, now, now+30, strings.Repeat("a", 24))

	check("proxy GET /api/projects (owner assertion)", hit("http://127.0.0.1:4318/api/projects", "dashboard.example.test", nil), 200)
	check("proxy strips a client Cloudflare assertion", hit("http://127.0.0.1:4318/api/projects", "dashboard.example.test", map[string]string{"CF-Access-Jwt-Assertion": "forged"}), 200)
	check("proxy strips a client gateway assertion", hit("http://127.0.0.1:4318/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": "forged"}), 200)
	check("proxy GET /healthz stays public", hit("http://127.0.0.1:4318/healthz", "dashboard.example.test", nil), 200)
	check("proxy rejects a foreign Host", hit("http://127.0.0.1:4318/healthz", "attacker.example", nil), 403)
	check("dashboard direct, no assertion", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", nil), 401)
	check("dashboard rejects a Cloudflare assertion in this mode", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"CF-Access-Jwt-Assertion": "x"}), 401)
	check("dashboard accepts a direct valid assertion", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": good}), 200)
	check("dashboard refuses a replayed assertion", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": good}), 401)
	otherPub, otherKey, _ := ed25519.GenerateKey(rand.Reader)
	_ = otherPub
	forged := token(otherKey, base.Issuer, base.Audience, base.Owner, base.Owner, now, now+30, strings.Repeat("b", 24))
	check("dashboard refuses an assertion signed by another key", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": forged}), 401)
	expired := token(key, base.Issuer, base.Audience, base.Owner, base.Owner, now-120, now-60, strings.Repeat("c", 24))
	check("dashboard refuses an expired assertion", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": expired}), 401)
	wrongAud := token(key, base.Issuer, "other-audience", base.Owner, base.Owner, now, now+30, strings.Repeat("d", 24))
	check("dashboard refuses a wrong audience", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": wrongAud}), 401)
	notOwner := token(key, base.Issuer, base.Audience, "someone@example.test", "someone@example.test", now, now+30, strings.Repeat("e", 24))
	check("dashboard refuses a non-owner subject", hit("http://127.0.0.1:4319/api/projects", "dashboard.example.test", map[string]string{"X-Pilot-Gateway-Assertion": notOwner}), 403)

	denied := base
	denied.Lookup = who{ingress.Peer{Login: "owner@example.test", NodeID: "other"}}
	dg := serve("127.0.0.1:4316", denied); defer dg.Close()
	check("unapproved node refused before the dashboard", hit("http://127.0.0.1:4316/healthz", "dashboard.example.test", nil), 403)
	tagged := base
	tagged.Lookup = who{ingress.Peer{Login: "owner@example.test", NodeID: "approved", Tags: []string{"tag:server"}}}
	tg := serve("127.0.0.1:4315", tagged); defer tg.Close()
	check("tagged peer refused before the dashboard", hit("http://127.0.0.1:4315/healthz", "dashboard.example.test", nil), 403)
	wrongLogin := base
	wrongLogin.Lookup = who{ingress.Peer{Login: "intruder@example.test", NodeID: "approved"}}
	wg := serve("127.0.0.1:4314", wrongLogin); defer wg.Close()
	check("different tailnet login refused", hit("http://127.0.0.1:4314/healthz", "dashboard.example.test", nil), 403)

	if fail != 0 { fmt.Printf("e2e failures: %d\n", fail); os.Exit(1) }
	fmt.Println("e2e passed")
}
