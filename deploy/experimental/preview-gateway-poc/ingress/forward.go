package ingress

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"
)

const assertionHeader = "X-Pilot-Ingress-Assertion"

type assertion struct {
	IAT    int64  `json:"iat"`
	EXP    int64  `json:"exp"`
	JTI    string `json:"jti"`
	Login  string `json:"login"`
	NodeID string `json:"nodeId"`
	Method string `json:"method"`
	RawURL string `json:"rawUrl"`
	Host   string `json:"host"`
}

// PrivateAssertionKey reads exactly one service-owned Ed25519 private key using
// Linux O_NOFOLLOW and fstat; unsupported platforms fail closed.
func PrivateAssertionKey(path string, serviceUID, pilotUID int) (ed25519.PrivateKey, error) {
	key, err := readPrivateKey(path, serviceUID, pilotUID)
	if err != nil { return nil, err }
	if len(key) != ed25519.PrivateKeySize { return nil, fmt.Errorf("assertion key must contain exactly 64 raw bytes") }
	return ed25519.PrivateKey(append([]byte(nil), key...)), nil
}

// ValidatePrivateSocketPath enforces UID ownership, mode, parent path and
// platform support before tsnet starts accepting tailnet requests.
func ValidatePrivateSocketPath(path string, serviceUID, pilotUID int) error {
	return validateSocketPath(path, serviceUID, pilotUID)
}

// UnixForwarder signs the WhoIs identity for each request and forwards solely
// to the private Node Unix socket. ReverseProxy carries HTTP upgrades through.
func UnixForwarder(socketPath string, key ed25519.PrivateKey, serviceUID, pilotUID int) (http.Handler, error) {
	if socketPath == "" || len(key) != ed25519.PrivateKeySize || serviceUID == pilotUID { return nil, fmt.Errorf("invalid private bridge configuration") }
	if err := validateSocketPath(socketPath, serviceUID, pilotUID); err != nil { return nil, err }
	target, _ := url.Parse("http://preview-core.invalid")
	transport := &http.Transport{DialContext: unixDial(socketPath, serviceUID, pilotUID), DisableKeepAlives: true, ResponseHeaderTimeout: 10 * time.Second}
	proxy := &httputil.ReverseProxy{Transport: transport, Rewrite: func(pr *httputil.ProxyRequest) {
		r := pr.In
		pr.SetURL(target)
		pr.Out.Host = r.Host
		// Keep ReverseProxy's prepared headers: Rewrite runs after hop-by-hop
		// filtering and Go restores Connection: Upgrade for protocol upgrades.
		for name := range pr.Out.Header {
			lower := strings.ToLower(name)
			if untrustedIdentityHeader(lower) { pr.Out.Header.Del(name) }
		}
		identity, ok := PeerFromContext(r.Context())
		if !ok { return }
		now := time.Now()
		jti := make([]byte, 24)
		if _, err := rand.Read(jti); err != nil { return }
		claim := assertion{IAT: now.UnixMilli(), EXP: now.Add(5*time.Second).UnixMilli(), JTI: base64.RawURLEncoding.EncodeToString(jti), Login: identity.Login, NodeID: identity.NodeID, Method: r.Method, RawURL: r.URL.RequestURI(), Host: r.Host}
		payload, err := json.Marshal(claim)
		if err != nil { return }
		token := base64.RawURLEncoding.EncodeToString(payload) + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, payload))
		pr.Out.Header.Set(assertionHeader, token)
	}, ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) { http.Error(w, "preview core unavailable", http.StatusBadGateway) }}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := PeerFromContext(r.Context()); !ok { http.Error(w, "forbidden", http.StatusForbidden); return }
		proxy.ServeHTTP(w, r)
	}), nil
}

func untrustedIdentityHeader(name string) bool {
	name = strings.ToLower(name)
	return name == "forwarded" || name == "authorization" || name == "proxy-authorization" ||
		strings.HasPrefix(name, "forwarded-") || strings.HasPrefix(name, "x-forwarded-") ||
		strings.HasPrefix(name, "tailscale-") || strings.HasPrefix(name, "x-tailscale-") ||
		strings.HasPrefix(name, "ts-") || strings.HasPrefix(name, "x-pilot-") ||
		strings.HasPrefix(name, "x-auth-") || strings.HasPrefix(name, "x-user-") ||
		strings.HasPrefix(name, "x-remote-") || strings.HasPrefix(name, "remote-")
}

func unixDial(path string, serviceUID, pilotUID int) func(context.Context, string, string) (net.Conn, error) {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		if err := validateSocketPath(path, serviceUID, pilotUID); err != nil { return nil, err }
		conn, err := (&net.Dialer{}).DialContext(ctx, "unix", path)
		if err != nil { return nil, err }
		if err := verifySocketPeer(conn, serviceUID); err != nil { conn.Close(); return nil, err }
		return conn, nil
	}
}
