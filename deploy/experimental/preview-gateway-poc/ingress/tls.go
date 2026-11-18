package ingress

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// PreviewCertificateStore atomically publishes only a validated, publicly trusted
// certificate/key pair. A failed reload clears the active certificate, so a
// partial or mismatched replacement fails closed instead of falling back to
// stale material.
type PreviewCertificateStore struct {
	certPath string
	keyPath string
	serviceUID int
	pilotUID int
	previewDomain string
	roots *x509.CertPool
	now func() time.Time
	activeMu sync.RWMutex
	active *tls.Certificate
}

// NewPreviewCertificateStore validates protected PEM paths and loads a trusted
// wildcard certificate for exactly one label below previewDomain. A nil roots
// pool means the platform's system trust roots.
func NewPreviewCertificateStore(certPath, keyPath string, serviceUID, pilotUID int, previewDomain string, roots *x509.CertPool) (*PreviewCertificateStore, error) {
	domain, err := normalizeDNSName(previewDomain)
	if err != nil { return nil, fmt.Errorf("invalid preview domain") }
	store := &PreviewCertificateStore{certPath: certPath, keyPath: keyPath, serviceUID: serviceUID, pilotUID: pilotUID, previewDomain: domain, roots: roots, now: time.Now}
	if err := store.Reload(); err != nil { return nil, err }
	return store, nil
}

// Reload immediately removes the currently served certificate, reads the pair
// without following symlinks, validates it, then atomically publishes it. If any
// step fails, preview TLS remains unavailable until a later successful reload.
func (s *PreviewCertificateStore) Reload() error {
	s.activeMu.Lock()
	defer s.activeMu.Unlock()
	s.active = nil
	certPEM, keyPEM, err := ReadOwnerTLSMaterial(s.certPath, s.keyPath, s.serviceUID, s.pilotUID)
	if err != nil { return fmt.Errorf("cannot read protected preview TLS material") }
	cert, err := validatePreviewCertificate(certPEM, keyPEM, s.previewDomain, s.roots, s.now())
	if err != nil { return err }
	s.active = cert
	return nil
}

// GetCertificate is suitable for tls.Config.GetCertificate. Validity and the
// exact requested hostname are rechecked for every new TLS handshake.
func (s *PreviewCertificateStore) GetCertificate(serverName string) (*tls.Certificate, error) {
	name, err := normalizeDNSName(serverName)
	if err != nil || !isSingleLabelPreviewName(name, s.previewDomain) {
		return nil, fmt.Errorf("unrecognized preview SNI")
	}
	s.activeMu.RLock()
	defer s.activeMu.RUnlock()
	cert := s.active
	if cert == nil || cert.Leaf == nil { return nil, fmt.Errorf("preview TLS certificate is unavailable") }
	now := s.now()
	if now.Before(cert.Leaf.NotBefore) || !now.Before(cert.Leaf.NotAfter) { return nil, fmt.Errorf("preview TLS certificate is outside its validity period") }
	if err := cert.Leaf.VerifyHostname(name); err != nil { return nil, fmt.Errorf("preview TLS certificate does not cover requested name") }
	return cert, nil
}

func validatePreviewCertificate(certPEM, keyPEM []byte, domain string, roots *x509.CertPool, now time.Time) (*tls.Certificate, error) {
	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil { return nil, fmt.Errorf("invalid preview TLS certificate/key pair") }
	if len(pair.Certificate) == 0 { return nil, fmt.Errorf("preview TLS certificate chain is empty") }
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil { return nil, fmt.Errorf("invalid preview TLS leaf certificate") }
	if now.Before(leaf.NotBefore) || !now.Before(leaf.NotAfter) { return nil, fmt.Errorf("preview TLS certificate is outside its validity period") }
	wildcard := "*." + domain
	foundWildcard := false
	for _, name := range leaf.DNSNames {
		if strings.EqualFold(name, wildcard) { foundWildcard = true; break }
	}
	if !foundWildcard { return nil, fmt.Errorf("preview TLS certificate lacks the configured wildcard DNS SAN") }
	validationName := "pilot-preview-validation." + domain
	if err := leaf.VerifyHostname(validationName); err != nil { return nil, fmt.Errorf("preview TLS wildcard does not cover configured domain") }
	intermediates := x509.NewCertPool()
	for _, der := range pair.Certificate[1:] {
		cert, err := x509.ParseCertificate(der)
		if err != nil { return nil, fmt.Errorf("invalid preview TLS certificate chain") }
		intermediates.AddCert(cert)
	}
	trustRoots := roots
	if trustRoots == nil {
		trustRoots, err = x509.SystemCertPool()
		if err != nil || trustRoots == nil { return nil, fmt.Errorf("system public trust roots are unavailable") }
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: trustRoots, Intermediates: intermediates, DNSName: validationName, CurrentTime: now, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return nil, fmt.Errorf("preview TLS certificate is not publicly trusted for the configured wildcard")
	}
	pair.Leaf = leaf
	return &pair, nil
}

// CertificateSelector dispatches exact tailnet certificate names to Tailscale
// and exactly one preview label under previewDomain to the owner certificate.
type CertificateSelector struct {
	controlDomains map[string]struct{}
	previewDomain string
	controlCertificate func(*tls.ClientHelloInfo) (*tls.Certificate, error)
	previewCertificate func(string) (*tls.Certificate, error)
}

func NewCertificateSelector(controlDomains []string, previewDomain string, controlCertificate func(*tls.ClientHelloInfo) (*tls.Certificate, error), previewCertificate func(string) (*tls.Certificate, error)) (*CertificateSelector, error) {
	domain, err := normalizeDNSName(previewDomain)
	if err != nil || len(controlDomains) == 0 || controlCertificate == nil || previewCertificate == nil {
		return nil, fmt.Errorf("invalid TLS certificate selector configuration")
	}
	allowed := make(map[string]struct{}, len(controlDomains))
	for _, name := range controlDomains {
		normalized, err := normalizeDNSName(name)
		if err != nil { return nil, fmt.Errorf("invalid Tailscale certificate domain") }
		allowed[normalized] = struct{}{}
	}
	return &CertificateSelector{controlDomains: allowed, previewDomain: domain, controlCertificate: controlCertificate, previewCertificate: previewCertificate}, nil
}

func (s *CertificateSelector) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	if hello == nil { return nil, fmt.Errorf("missing TLS ClientHello") }
	name, err := normalizeDNSName(hello.ServerName)
	if err != nil { return nil, fmt.Errorf("missing or malformed TLS SNI") }
	if _, ok := s.controlDomains[name]; ok {
		cert, err := s.controlCertificate(hello)
		if err != nil { return nil, err }
		if cert == nil { return nil, fmt.Errorf("Tailscale returned no certificate for approved control SNI") }
		return cert, nil
	}
	if isSingleLabelPreviewName(name, s.previewDomain) {
		cert, err := s.previewCertificate(name)
		if err != nil { return nil, err }
		if cert == nil { return nil, fmt.Errorf("owner preview certificate is unavailable") }
		return cert, nil
	}
	return nil, fmt.Errorf("unrecognized TLS SNI")
}

func isSingleLabelPreviewName(name, domain string) bool {
	suffix := "." + domain
	if !strings.HasSuffix(name, suffix) { return false }
	label := strings.TrimSuffix(name, suffix)
	return validDNSLabel(label)
}

func normalizeDNSName(name string) (string, error) {
	if name == "" || len(name) > 253 || strings.TrimSpace(name) != name || strings.HasSuffix(name, ".") || net.ParseIP(name) != nil {
		return "", fmt.Errorf("invalid DNS name")
	}
	name = strings.ToLower(name)
	for _, label := range strings.Split(name, ".") {
		if !validDNSLabel(label) { return "", fmt.Errorf("invalid DNS name") }
	}
	return name, nil
}

func validDNSLabel(label string) bool {
	if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' { return false }
	for _, c := range []byte(label) {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') { return false }
	}
	return true
}

// RequireHostMatchesSNI rejects domain fronting for all downstream HTTP
// requests, including WebSocket upgrades. Only the default HTTPS port may be
// present in Host; the DNS name itself must exactly match the TLS SNI.
func RequireHostMatchesSNI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.TLS == nil || r.TLS.ServerName == "" {
			http.Error(w, "misdirected request", http.StatusMisdirectedRequest)
			return
		}
		sni, err := normalizeDNSName(r.TLS.ServerName)
		if err != nil { http.Error(w, "misdirected request", http.StatusMisdirectedRequest); return }
		host := r.Host
		if strings.Contains(host, ":") {
			hostname, port, err := net.SplitHostPort(host)
			if err != nil || port != "443" { http.Error(w, "misdirected request", http.StatusMisdirectedRequest); return }
			host = hostname
		}
		normalizedHost, err := normalizeDNSName(host)
		if err != nil || normalizedHost != sni { http.Error(w, "misdirected request", http.StatusMisdirectedRequest); return }
		next.ServeHTTP(w, r)
	})
}
