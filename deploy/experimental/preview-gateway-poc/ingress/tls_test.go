package ingress

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func selfSignedNodeCertificate(t *testing.T, name string) *tls.Certificate {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil { t.Fatal(err) }
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		DNSNames:     []string{name},
		NotBefore:    time.Unix(1_600_000_000, 0),
		NotAfter:     time.Unix(1_900_000_000, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil { t.Fatal(err) }
	leaf, err := x509.ParseCertificate(der)
	if err != nil { t.Fatal(err) }
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}
}

func TestNodeCertificateAcceptsOnlyTheExactNodeName(t *testing.T) {
	name := "pilot-preview.tailnet-example.ts.net"
	cert := selfSignedNodeCertificate(t, name)
	node, err := NewNodeCertificate(name, func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return cert, nil })
	if err != nil { t.Fatal(err) }
	node.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	got, err := node.GetCertificate(&tls.ClientHelloInfo{ServerName: name})
	if err != nil || got != cert { t.Fatalf("exact node name refused: %v", err) }
	for _, rejected := range []string{"", "other.tailnet-example.ts.net", "pilot-preview.tailnet-example.ts.net.evil.test"} {
		if _, err := node.GetCertificate(&tls.ClientHelloInfo{ServerName: rejected}); err == nil {
			t.Fatalf("SNI %q accepted", rejected)
		}
	}
}

func TestNodeCertificateRefusesNonTailnetAndExpiredNames(t *testing.T) {
	if _, err := NewNodeCertificate("preview.example.net", func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return nil, nil }); err == nil {
		t.Fatal("public name accepted")
	}
	if _, err := NewNodeCertificate("bad name.ts.net", func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return nil, nil }); err == nil {
		t.Fatal("malformed name accepted")
	}
	if _, err := NewNodeCertificate("node.ts.net", nil); err == nil { t.Fatal("missing source accepted") }
	name := "node.tailnet.ts.net"
	cert := selfSignedNodeCertificate(t, name)
	node, err := NewNodeCertificate(name, func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return cert, nil })
	if err != nil { t.Fatal(err) }
	node.now = func() time.Time { return time.Unix(2_000_000_000, 0) }
	if _, err := node.GetCertificate(&tls.ClientHelloInfo{ServerName: name}); err == nil {
		t.Fatal("expired certificate accepted")
	}
}

func TestNodeCertificateRefusesCertificateForAnotherName(t *testing.T) {
	name := "node.tailnet.ts.net"
	cert := selfSignedNodeCertificate(t, "other.tailnet.ts.net")
	node, err := NewNodeCertificate(name, func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return cert, nil })
	if err != nil { t.Fatal(err) }
	node.now = func() time.Time { return time.Unix(1_700_000_000, 0) }
	if _, err := node.GetCertificate(&tls.ClientHelloInfo{ServerName: name}); err == nil {
		t.Fatal("mismatched certificate accepted")
	}
}

func TestParsePreviewPorts(t *testing.T) {
	ports, err := ParsePreviewPorts("4301, 4302,65535")
	if err != nil || len(ports) != 3 || ports[0] != 4301 || ports[2] != 65535 {
		t.Fatalf("valid set refused: %v %v", ports, err)
	}
	for _, bad := range []string{"", "443", "22", "4319", "80", "70000", "4301,4301", "4301,,4302", "abc"} {
		if _, err := ParsePreviewPorts(bad); err == nil { t.Fatalf("invalid set %q accepted", bad) }
	}
	many := make([]string, 0, 33)
	for port := 5000; port < 5033; port++ { many = append(many, strconv.Itoa(port)) }
	if _, err := ParsePreviewPorts(strings.Join(many, ",")); err == nil { t.Fatal("oversized set accepted") }
}

func TestRequireHostMatchesNodeRejectsFrontingAndWrongPorts(t *testing.T) {
	name := "node.tailnet.ts.net"
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	handler := RequireHostMatchesNode(inner, name, 4301)
	request := func(host, sni string) int {
		r := httptest.NewRequest("GET", "https://"+name+":4301/", nil)
		r.Host = host
		r.TLS = &tls.ConnectionState{ServerName: sni}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w.Code
	}
	if code := request(name+":4301", name); code != http.StatusNoContent {
		t.Fatalf("valid request refused: %d", code)
	}
	for _, pair := range [][2]string{
		{name, name}, {name + ":4302", name}, {name + ":4301", "other.tailnet.ts.net"},
		{"other.tailnet.ts.net:4301", name}, {"node.tailnet.ts.net.evil:4301", name},
	} {
		if code := request(pair[0], pair[1]); code != http.StatusMisdirectedRequest {
			t.Fatalf("host %q sni %q accepted with %d", pair[0], pair[1], code)
		}
	}
	r := httptest.NewRequest("GET", "https://"+name+"/", nil)
	r.Host = name
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMisdirectedRequest { t.Fatalf("missing TLS accepted: %d", w.Code) }
}
