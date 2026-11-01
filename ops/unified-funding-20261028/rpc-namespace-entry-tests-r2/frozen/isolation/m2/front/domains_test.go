package main

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestCustomDomainAuthorizationAndRemoval(t *testing.T) {
	c := newCertState(t, "12345678.app.enclave.host")
	id := "0x1234"
	c.setDomains(map[string]string{"eyesoff.ai": id, "other.example": "0x5678", "87654321.app.enclave.host": id, "evil.example/path": id}, id, time.Now().Add(time.Minute))
	for _, name := range []string{"other.example", "87654321.app.enclave.host", "evil.example/path"} {
		if c.forName(name) != nil {
			t.Fatalf("unauthorized %s", name)
		}
	}
	a := c.forName("eyesoff.ai")
	if a == nil {
		t.Fatal("missing authorized domain")
	}
	b, err := a.csr()
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(b)
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || len(csr.DNSNames) != 1 || csr.DNSNames[0] != "eyesoff.ai" || csr.CheckSignature() != nil {
		t.Fatal("incorrect custom CSR")
	}
	ca := newTestCA(t)
	chain := ca.issue(t, c.key.Public(), "eyesoff.ai", time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if _, err := a.install(chain, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, _ := c.getCertificate(&tls.ClientHelloInfo{ServerName: "eyesoff.ai"})
	if got == c.self {
		t.Fatal("custom cert not served")
	}
	c.setDomains(map[string]string{"eyesoff.ai": id}, id, time.Now().Add(time.Minute))
	if c.forName("eyesoff.ai") != a {
		t.Fatal("refresh discarded certificate")
	}
	c.setDomains(map[string]string{}, id, time.Now().Add(time.Minute))
	got, _ = c.getCertificate(&tls.ClientHelloInfo{ServerName: "eyesoff.ai"})
	if got != c.self {
		t.Fatal("removed domain still served")
	}
	c.setDomains(map[string]string{"eyesoff.ai": id}, id, time.Now().Add(-time.Second))
	if c.forName("eyesoff.ai") != nil {
		t.Fatal("expired authorization remains")
	}
}

func TestCustomCSRRequiresAuthorization(t *testing.T) {
	c := newCertState(t, "12345678.app.enclave.host")
	w := httptest.NewRecorder()
	c.serveCSR(w, httptest.NewRequest(http.MethodGet, csrPath+"?name=attacker.example", nil))
	if w.Code != http.StatusForbidden {
		t.Fatal(w.Code)
	}
	w = httptest.NewRecorder()
	c.serveCSR(w, httptest.NewRequest(http.MethodGet, csrPath, nil))
	if w.Code != http.StatusOK {
		t.Fatal("canonical compatibility", w.Code)
	}
}
