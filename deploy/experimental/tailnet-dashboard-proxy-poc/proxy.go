// Package dashboardproxy is Pilot's opt-in, fixed-destination tailnet dashboard gateway.
package dashboardproxy

import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httputil"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"pilot-tailnet-dashboard-proxy/ingress"
)

const assertionHeader = "X-Pilot-Gateway-Assertion"

// Config accepts only a pinned IP:port and fixed dashboard authority values; it
// deliberately has no URL/host routing API.
type Config struct {
	Lookup          ingress.WhoIs
	Policy          ingress.Policy
	Destination     netip.AddrPort
	DashboardHost   string
	DashboardOrigin string
	Issuer          string
	Audience        string
	Owner           string
	SigningKey      ed25519.PrivateKey
	Now             func() time.Time
}

type claims struct {
	Issuer   string `json:"iss"`
	Audience string `json:"aud"`
	Subject  string `json:"sub"`
	Owner    string `json:"owner"`
	IssuedAt int64  `json:"iat"`
	Expires  int64  `json:"exp"`
	ID       string `json:"jti"`
}

func (c Config) validate() error {
	if c.Lookup == nil || c.Owner == "" || c.Policy.OwnerLogin != c.Owner || c.Issuer == "" || c.Audience == "" || len(c.SigningKey) != ed25519.PrivateKeySize {
		return errors.New("incomplete gateway authentication configuration")
	}
	if c.Destination.Port() == 0 || !c.Destination.Addr().IsValid() || !(c.Destination.Addr().IsPrivate() || c.Destination.Addr().IsLoopback()) || c.Destination.Addr().IsUnspecified() {
		return errors.New("dashboard destination must be a fixed private IP address and port")
	}
	if c.DashboardHost == "" || strings.ContainsAny(c.DashboardHost, " /\\\r\n\t") {
		return errors.New("invalid configured dashboard Host")
	}
	u, err := url.Parse(c.DashboardOrigin)
	if err != nil || u.String() != c.DashboardOrigin || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("dashboard Origin must be an exact HTTPS origin")
	}
	if c.DashboardHost != u.Host {
		return errors.New("dashboard Host must exactly match the configured Origin host")
	}
	if !policyValid(c.Policy) {
		return errors.New("invalid owner/stable-node policy")
	}
	return nil
}

// New builds the only handler: every path is forwarded to one pinned dashboard.
type Gateway struct {
	Handler   http.Handler
	transport *http.Transport
	mu        sync.Mutex
	upgrades  map[net.Conn]struct{}
}
type trackingWriter struct {
	http.ResponseWriter
	gateway *Gateway
}
type trackedConn struct {
	net.Conn
	gateway *Gateway
}

func (w trackingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not support hijacking")
	}
	conn, rw, err := h.Hijack()
	if err != nil {
		return nil, nil, err
	}
	tracked := &trackedConn{Conn: conn, gateway: w.gateway}
	w.gateway.mu.Lock()
	w.gateway.upgrades[tracked] = struct{}{}
	w.gateway.mu.Unlock()
	return tracked, rw, nil
}
func (w trackingWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
func (w trackingWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (c *trackedConn) Close() error {
	err := c.Conn.Close()
	c.gateway.mu.Lock()
	delete(c.gateway.upgrades, c)
	c.gateway.mu.Unlock()
	return err
}

func New(c Config) (*Gateway, error) {
	if err := c.validate(); err != nil {
		return nil, err
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, "tcp", net.JoinHostPort(c.Destination.Addr().String(), strconv.Itoa(int(c.Destination.Port()))))
		},
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 15 * time.Second,
		MaxIdleConns: 16, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second,
	}
	type assertionContextKey struct{}
	proxy := &httputil.ReverseProxy{
		Transport:     transport,
		FlushInterval: -1,
		Director: func(r *http.Request) {
			// Delete inherited and client-supplied identity assertions before creating ours.
			for name := range r.Header {
				if identityHeader(name) {
					delete(r.Header, name)
				}
			}
			stripForwarding(r.Header)
			// A present nil slice suppresses ReverseProxy's automatic client-IP append.
			r.Header["X-Forwarded-For"] = nil
			r.URL.Scheme, r.URL.Host = "http", c.Destination.String()
			r.Host = c.DashboardHost
			token, _ := r.Context().Value(assertionContextKey{}).(string)
			r.Header.Set(assertionHeader, token)
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "dashboard unavailable", http.StatusBadGateway)
		},
	}
	gateway := &Gateway{transport: transport, upgrades: make(map[net.Conn]struct{})}
	gateway.Handler = ingress.Protect(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.ContentLength > 16<<20 {
			http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
			return
		}
		if r.Host != c.DashboardHost {
			http.Error(w, "untrusted Host", http.StatusForbidden)
			return
		}
		origins := r.Header.Values("Origin")
		websocket := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if len(origins) > 1 || (len(origins) == 1 && origins[0] != c.DashboardOrigin) || (len(origins) == 0 && (websocket || (r.Method != http.MethodGet && r.Method != http.MethodHead))) {
			http.Error(w, "untrusted Origin", http.StatusForbidden)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
		token, err := sign(c, c.Now())
		if err != nil {
			http.Error(w, "gateway unavailable", http.StatusServiceUnavailable)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), assertionContextKey{}, token))
		proxy.ServeHTTP(trackingWriter{ResponseWriter: w, gateway: gateway}, r)
	}), c.Lookup, c.Policy)
	return gateway, nil
}

func (g *Gateway) Close() {
	if g == nil {
		return
	}
	if g.transport != nil {
		g.transport.CloseIdleConnections()
	}
	g.mu.Lock()
	conns := make([]net.Conn, 0, len(g.upgrades))
	for conn := range g.upgrades {
		conns = append(conns, conn)
	}
	g.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func sign(c Config, now time.Time) (string, error) {
	n := now.Unix()
	id := make([]byte, 24)
	if _, err := rand.Read(id); err != nil {
		return "", err
	}
	payload, err := json.Marshal(claims{Issuer: c.Issuer, Audience: c.Audience, Subject: c.Owner, Owner: c.Owner, IssuedAt: n, Expires: n + 30, ID: base64.RawURLEncoding.EncodeToString(id)})
	if err != nil {
		return "", err
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA","typ":"JWT"}`))
	body := header + "." + base64.RawURLEncoding.EncodeToString(payload)
	return body + "." + base64.RawURLEncoding.EncodeToString(ed25519.Sign(c.SigningKey, []byte(body))), nil
}

func identityHeader(name string) bool {
	n := strings.ToLower(name)
	return strings.HasPrefix(n, "cf-") || strings.HasPrefix(n, "tailscale-") || strings.HasPrefix(n, "x-tailscale-") || strings.HasPrefix(n, "x-pilot-") || n == "authorization"
}
func stripForwarding(h http.Header) {
	for name := range h {
		n := strings.ToLower(name)
		if strings.HasPrefix(n, "x-forwarded-") || n == "forwarded" || n == "x-real-ip" || n == "via" {
			delete(h, name)
		}
	}
}

func policyValid(p ingress.Policy) bool {
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
