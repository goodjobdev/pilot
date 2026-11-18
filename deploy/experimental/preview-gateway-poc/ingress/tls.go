package ingress

import (
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// NodeCertificate serves exactly one tailnet name: the gateway node's own
// MagicDNS FQDN. Previews are distinguished by port, not by hostname, so there
// is no wildcard certificate, no owner-supplied PEM, and no SNI dispatch beyond
// an exact name match. The certificate always comes from Tailscale for that
// node, so trust is the tailnet's own.
type NodeCertificate struct {
	hostname string
	get      func(*tls.ClientHelloInfo) (*tls.Certificate, error)
	now      func() time.Time
}

// NewNodeCertificate validates the node FQDN and requires a certificate source.
func NewNodeCertificate(hostname string, get func(*tls.ClientHelloInfo) (*tls.Certificate, error)) (*NodeCertificate, error) {
	name, err := normalizeDNSName(hostname)
	if err != nil {
		return nil, fmt.Errorf("invalid gateway node name")
	}
	if !strings.HasSuffix(name, ".ts.net") {
		return nil, fmt.Errorf("gateway node name must be a tailnet ts.net name")
	}
	if get == nil {
		return nil, fmt.Errorf("missing node certificate source")
	}
	return &NodeCertificate{hostname: name, get: get, now: time.Now}, nil
}

// Hostname is the exact name every preview Host and TLS SNI must carry.
func (n *NodeCertificate) Hostname() string { return n.hostname }

// GetCertificate is suitable for tls.Config.GetCertificate. Only the exact node
// name is accepted, and the returned certificate is re-validated per handshake.
func (n *NodeCertificate) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if hello == nil {
		return nil, fmt.Errorf("missing TLS ClientHello")
	}
	name, err := normalizeDNSName(hello.ServerName)
	if err != nil {
		return nil, fmt.Errorf("missing or malformed TLS SNI")
	}
	if name != n.hostname {
		return nil, fmt.Errorf("unrecognized TLS SNI")
	}
	cert, err := n.get(hello)
	if err != nil {
		return nil, err
	}
	if cert == nil || len(cert.Certificate) == 0 {
		return nil, fmt.Errorf("tailscale returned no certificate for the gateway node")
	}
	leaf := cert.Leaf
	if leaf == nil {
		return nil, fmt.Errorf("gateway certificate has no parsed leaf")
	}
	now := n.now()
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) {
		return nil, fmt.Errorf("gateway certificate is outside its validity period")
	}
	if err := leaf.VerifyHostname(n.hostname); err != nil {
		return nil, fmt.Errorf("gateway certificate does not cover the node name")
	}
	return cert, nil
}

// ParsePreviewPorts validates the comma-separated listener set. Ports are the
// only preview selector, so the set is explicit, bounded, and free of privileged
// or otherwise reserved ports.
func ParsePreviewPorts(value string, reserved ...int) ([]int, error) {
	if strings.TrimSpace(value) == "" {
		return nil, fmt.Errorf("at least one preview port is required")
	}
	blocked := map[int]struct{}{443: {}, 22: {}, 4319: {}}
	for _, port := range reserved {
		blocked[port] = struct{}{}
	}
	seen := map[int]struct{}{}
	ports := make([]int, 0, 8)
	for _, field := range strings.Split(value, ",") {
		field = strings.TrimSpace(field)
		if field == "" {
			return nil, fmt.Errorf("empty preview port entry")
		}
		port, err := strconv.Atoi(field)
		if err != nil || port < 1024 || port > 65535 {
			return nil, fmt.Errorf("preview port must be an unprivileged TCP port")
		}
		if _, ok := blocked[port]; ok {
			return nil, fmt.Errorf("preview port is reserved")
		}
		if _, ok := seen[port]; ok {
			return nil, fmt.Errorf("duplicate preview port")
		}
		seen[port] = struct{}{}
		ports = append(ports, port)
	}
	if len(ports) > 32 {
		return nil, fmt.Errorf("too many preview ports")
	}
	return ports, nil
}

// RequireHostMatchesNode rejects domain fronting for every downstream request,
// including WebSocket upgrades: the Host must be the gateway node name, and the
// only accepted port is the listener's own port. TLS SNI must equal the node name.
func RequireHostMatchesNode(next http.Handler, hostname string, port int) http.Handler {
	name, err := normalizeDNSName(hostname)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.TLS.ServerName == "" {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		sni, err := normalizeDNSName(r.TLS.ServerName)
		if err != nil || sni != name {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		host := r.Host
		if strings.Contains(host, ":") {
			hostname, hostPort, err := net.SplitHostPort(host)
			if err != nil {
				http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
				return
			}
			host = hostname
			parsed, err := strconv.Atoi(hostPort)
			if err != nil || parsed != port {
				http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
				return
			}
		} else if port != 443 {
			// A non-default port must be explicit in Host.
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		normalizedHost, err := normalizeDNSName(host)
		if err != nil || normalizedHost != name {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func normalizeDNSName(name string) (string, error) {
	if name == "" || len(name) > 253 || strings.TrimSpace(name) != name || strings.HasSuffix(name, ".") || net.ParseIP(name) != nil {
		return "", fmt.Errorf("invalid DNS name")
	}
	name = strings.ToLower(name)
	for _, label := range strings.Split(name, ".") {
		if !validDNSLabel(label) {
			return "", fmt.Errorf("invalid DNS name")
		}
	}
	return name, nil
}

func validDNSLabel(label string) bool {
	if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	for _, c := range []byte(label) {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}
