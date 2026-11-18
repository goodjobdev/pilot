//go:build linux

package ingress

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func syntheticCertificate(t *testing.T, domain string, notBefore, notAfter time.Time) ([]byte, []byte, *x509.CertPool) {
	t.Helper()
	rootKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil { t.Fatal(err) }
	rootTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Synthetic Test CA"},
		NotBefore: notBefore.Add(-time.Hour), NotAfter: notAfter.Add(time.Hour), IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
	if err != nil { t.Fatal(err) }
	root, err := x509.ParseCertificate(rootDER)
	if err != nil { t.Fatal(err) }
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil { t.Fatal(err) }
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "Not used for hostname validation"},
		DNSNames: []string{"*." + domain, "additional.synthetic.example"},
		NotBefore: notBefore, NotAfter: notAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, root, &leafKey.PublicKey, rootKey)
	if err != nil { t.Fatal(err) }
	certPEM := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: rootDER})...)
	keyDER, err := x509.MarshalPKCS8PrivateKey(leafKey)
	if err != nil { t.Fatal(err) }
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	roots := x509.NewCertPool()
	roots.AddCert(root)
	return certPEM, keyPEM, roots
}

func TestCertificateSelectorSeparatesTailnetAndSingleLabelPreviewNames(t *testing.T) {
	control := &tls.Certificate{Certificate: [][]byte{[]byte("tailnet-cert")}}
	preview := &tls.Certificate{Certificate: [][]byte{[]byte("owner-cert")}}
	var controlCalls, previewCalls int
	selector, err := NewCertificateSelector([]string{"node.tailnet.example.test", "alias.tailnet.example.test"}, "preview.example.test",
		func(*tls.ClientHelloInfo) (*tls.Certificate, error) { controlCalls++; return control, nil },
		func(name string) (*tls.Certificate, error) { previewCalls++; if name != "route-1.preview.example.test" { t.Fatalf("preview name=%q", name) }; return preview, nil })
	if err != nil { t.Fatal(err) }
	got, err := selector.GetCertificate(&tls.ClientHelloInfo{ServerName: "NODE.TAILNET.EXAMPLE.TEST"})
	if err != nil || got != control { t.Fatalf("control selection got=%p err=%v", got, err) }
	got, err = selector.GetCertificate(&tls.ClientHelloInfo{ServerName: "route-1.preview.example.test"})
	if err != nil || got != preview { t.Fatalf("preview selection got=%p err=%v", got, err) }
	for _, sni := range []string{"", "unknown.example.test", "nested.route-1.preview.example.test", "bad..preview.example.test", "route-1.preview.example.test."} {
		if _, err := selector.GetCertificate(&tls.ClientHelloInfo{ServerName: sni}); err == nil { t.Errorf("accepted SNI %q", sni) }
	}
	if controlCalls != 1 || previewCalls != 1 { t.Fatalf("callback counts control=%d preview=%d", controlCalls, previewCalls) }
}

func TestPreviewCertificateRequiresPubliclyTrustedMatchingCurrentWildcard(t *testing.T) {
	now := time.Now().UTC()
	certPEM, keyPEM, roots := syntheticCertificate(t, "preview.example.test", now.Add(-time.Hour), now.Add(time.Hour))
	cert, err := validatePreviewCertificate(certPEM, keyPEM, "preview.example.test", roots, now)
	if err != nil { t.Fatalf("valid synthetic trusted multi-SAN certificate rejected: %v", err) }
	if len(cert.Leaf.DNSNames) != 2 { t.Fatalf("SAN count=%d, want multiple SAN coverage", len(cert.Leaf.DNSNames)) }
	if _, err := validatePreviewCertificate(certPEM, keyPEM, "other.example.test", roots, now); err == nil { t.Fatal("certificate for another preview domain accepted") }
	if _, err := validatePreviewCertificate(certPEM, keyPEM, "preview.example.test", nil, now); err == nil { t.Fatal("synthetic-only CA accepted by system public trust roots") }
	expiredCert, expiredKey, expiredRoots := syntheticCertificate(t, "preview.example.test", now.Add(-2*time.Hour), now.Add(-time.Hour))
	if _, err := validatePreviewCertificate(expiredCert, expiredKey, "preview.example.test", expiredRoots, now); err == nil { t.Fatal("expired certificate accepted") }
	_, mismatchedKey, _ := syntheticCertificate(t, "preview.example.test", now.Add(-time.Hour), now.Add(time.Hour))
	if _, err := validatePreviewCertificate(certPEM, mismatchedKey, "preview.example.test", roots, now); err == nil { t.Fatal("mismatched certificate/key pair accepted") }
}

func TestPreviewCertificateReloadFailsClosedAndRecoversOnlyWithValidPair(t *testing.T) {
	now := time.Now().UTC()
	certPEM, keyPEM, roots := syntheticCertificate(t, "preview.example.test", now.Add(-time.Hour), now.Add(time.Hour))
	dir := privateTestDir(t)
	certPath, keyPath := filepath.Join(dir, "owner.crt.pem"), filepath.Join(dir, "owner.key.pem")
	write := func(path string, value []byte) { t.Helper(); if err := os.WriteFile(path, value, 0600); err != nil { t.Fatal(err) } }
	write(certPath, certPEM); write(keyPath, keyPEM)
	uid := os.Geteuid()
	store, err := NewPreviewCertificateStore(certPath, keyPath, uid, uid+1, "preview.example.test", roots)
	if err != nil { t.Fatal(err) }
	if _, err := store.GetCertificate("route-1.preview.example.test"); err != nil { t.Fatalf("loaded preview cert unavailable: %v", err) }
	certLink := filepath.Join(dir, "owner-cert-link.pem")
	if err := os.Symlink(certPath, certLink); err != nil { t.Fatal(err) }
	if _, _, err := ReadOwnerTLSMaterial(certLink, keyPath, uid, uid+1); err == nil { t.Fatal("symlinked owner certificate accepted") }
	if _, _, err := ReadOwnerTLSMaterial(strings.Join([]string{dir, "unused", "..", "owner.crt.pem"}, string(os.PathSeparator)), keyPath, uid, uid+1); err == nil { t.Fatal("noncanonical TLS file path accepted") }
	keyLink := filepath.Join(dir, "owner-key-link.pem")
	if err := os.Symlink(keyPath, keyLink); err != nil { t.Fatal(err) }
	if _, _, err := ReadOwnerTLSMaterial(certPath, keyLink, uid, uid+1); err == nil { t.Fatal("symlinked owner private key accepted") }
	if err := os.Chmod(keyPath, 0644); err != nil { t.Fatal(err) }
	if _, _, err := ReadOwnerTLSMaterial(certPath, keyPath, uid, uid+1); err == nil { t.Fatal("group/world-readable owner private key accepted") }
	if err := os.Chmod(keyPath, 0600); err != nil { t.Fatal(err) }
	_, badKey, _ := syntheticCertificate(t, "preview.example.test", now.Add(-time.Hour), now.Add(time.Hour))
	write(keyPath, badKey)
	if err := store.Reload(); err == nil { t.Fatal("mismatched key reload succeeded") }
	if _, err := store.GetCertificate("route-1.preview.example.test"); err == nil { t.Fatal("failed reload silently retained the previous certificate") }
	write(keyPath, keyPEM)
	if err := store.Reload(); err != nil { t.Fatalf("valid pair reload failed: %v", err) }
	if _, err := store.GetCertificate("route-1.preview.example.test"); err != nil { t.Fatalf("reloaded preview cert unavailable: %v", err) }
	store.now = func() time.Time { return now.Add(2 * time.Hour) }
	if _, err := store.GetCertificate("route-1.preview.example.test"); err == nil { t.Fatal("expired active certificate was served") }
}

func TestRequireHostMatchesSNIForHTTPAndWebSocketRequests(t *testing.T) {
	for _, tc := range []struct { name, sni, host string; want int }{
		{"matching HTTP", "route.preview.example.test", "route.preview.example.test", http.StatusNoContent},
		{"matching WebSocket authority with default port", "route.preview.example.test", "route.preview.example.test:443", http.StatusNoContent},
		{"case-insensitive DNS authority", "route.preview.example.test", "ROUTE.PREVIEW.EXAMPLE.TEST", http.StatusNoContent},
		{"domain fronting", "route.preview.example.test", "control.tailnet.example.test", http.StatusMisdirectedRequest},
		{"non-default port", "route.preview.example.test", "route.preview.example.test:8443", http.StatusMisdirectedRequest},
		{"missing SNI", "", "route.preview.example.test", http.StatusMisdirectedRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			called := false
			handler := RequireHostMatchesSNI(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") && r.Host != tc.host { t.Errorf("WebSocket Host changed: %q", r.Host) }
				w.WriteHeader(http.StatusNoContent)
			}))
			r := httptest.NewRequest(http.MethodGet, "https://placeholder.invalid/", nil)
			r.Host = tc.host
			r.TLS = &tls.ConnectionState{ServerName: tc.sni}
			if tc.name == "matching WebSocket authority with default port" { r.Header.Set("Connection", "Upgrade"); r.Header.Set("Upgrade", "websocket") }
			w := httptest.NewRecorder(); handler.ServeHTTP(w, r)
			if w.Code != tc.want || called != (tc.want == http.StatusNoContent) { t.Fatalf("status=%d called=%v, want status=%d", w.Code, called, tc.want) }
		})
	}
}

func TestProtectResolvesWhoIsForRequestsRejectedForHostMismatch(t *testing.T) {
	who := &fakeWhoIs{peer: Peer{Login: "owner@example.test", NodeID: "remote-approved"}}
	inner := RequireHostMatchesSNI(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	handler := Protect(inner, who, policy())
	for _, tc := range []struct { host string; upgrade bool; want int }{
		{"fronted.example.test", false, http.StatusMisdirectedRequest},
		{"route.preview.example.test", true, http.StatusNoContent},
	} {
		r := httptest.NewRequest(http.MethodGet, "https://placeholder.invalid/", nil)
		r.RemoteAddr = "100.80.0.7:4321"
		r.Host = tc.host
		r.TLS = &tls.ConnectionState{ServerName: "route.preview.example.test"}
		if tc.upgrade { r.Header.Set("Connection", "Upgrade"); r.Header.Set("Upgrade", "websocket") }
		w := httptest.NewRecorder(); handler.ServeHTTP(w, r)
		if w.Code != tc.want { t.Fatalf("host=%q status=%d, want=%d", tc.host, w.Code, tc.want) }
	}
	if who.calls != 2 { t.Fatalf("WhoIs calls=%d, want a fresh lookup for each HTTP/WS request", who.calls) }
}
