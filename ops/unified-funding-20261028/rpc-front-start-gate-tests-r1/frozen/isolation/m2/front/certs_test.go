package main

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/domtls"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
}

func newTestCA(t *testing.T) *testCA {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &testCA{cert: c, key: k}
}

// issue returns leaf+CA as PEM for pub/name, valid nb..na.
func (ca *testCA) issue(t *testing.T, pub any, name string, nb, na time.Time) []byte {
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: nb, NotAfter: na, KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, pub, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw})...)
}

func newCertState(t *testing.T, name string) *certState {
	cert, spki, err := domtls.Mint("enclave-domain")
	if err != nil {
		t.Fatal(err)
	}
	return &certState{name: name, key: cert.PrivateKey.(crypto.Signer), spki: spki, self: &cert}
}

func TestTheNameComesFromHostData(t *testing.T) {
	hd := bytes.Repeat([]byte{0x4e}, 32)
	hd[1], hd[2], hd[3] = 0x62, 0xe6, 0x0d
	if got := nameFromHostData(hd, "app.enclave.host"); got != "4e62e60d.app.enclave.host" {
		t.Fatalf("got %q", got)
	}
	for what, n := range map[string]string{
		"all-zero HOST_DATA": nameFromHostData(make([]byte, 32), "app.enclave.host"),
		"no zone":            nameFromHostData(hd, ""),
		"short HOST_DATA":    nameFromHostData(hd[:31], "app.enclave.host"),
	} {
		if n != "" {
			t.Errorf("%s named %q", what, n)
		}
	}
}

func TestTheCSRIsForThisKeyAndThisNameOnly(t *testing.T) {
	c := newCertState(t, "4e62e60d.app.enclave.host")
	p, err := c.csr()
	if err != nil {
		t.Fatal(err)
	}
	b, _ := pem.Decode(p)
	req, err := x509.ParseCertificateRequest(b.Bytes)
	if err != nil || req.CheckSignature() != nil {
		t.Fatalf("the CSR does not parse or verify: %v", err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(req.PublicKey)
	if !bytes.Equal(spki, c.spki) || req.Subject.CommonName != c.name || len(req.DNSNames) != 1 || req.DNSNames[0] != c.name {
		t.Fatalf("the CSR is not exactly {CN=%s, SAN=[%s]} on this key: CN=%q SAN=%v", c.name, c.name, req.Subject.CommonName, req.DNSNames)
	}
	if _, err := newCertState(t, "").csr(); err == nil {
		t.Fatal("a domain with no deployment bound produced a CSR")
	}
}

func TestInstallTakesOnlyThisKeyForThisNameValidNow(t *testing.T) {
	ca := newTestCA(t)
	name := "4e62e60d.app.enclave.host"
	c := newCertState(t, name)
	now := time.Now()
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub := c.key.Public()
	good := ca.issue(t, pub, name, now.Add(-time.Minute), now.Add(90*24*time.Hour))
	refusals := map[string][]byte{
		"another key":         ca.issue(t, &other.PublicKey, name, now.Add(-time.Minute), now.Add(time.Hour)),
		"another name":        ca.issue(t, pub, "395bed3e.app.enclave.host", now.Add(-time.Minute), now.Add(time.Hour)),
		"expired":             ca.issue(t, pub, name, now.Add(-48*time.Hour), now.Add(-time.Hour)),
		"not yet valid":       ca.issue(t, pub, name, now.Add(time.Hour), now.Add(48*time.Hour)),
		"garbage":             []byte("not a certificate"),
		"a private key block": append(good, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: []byte{1}})...),
		"trailing bytes":      append(append([]byte{}, good...), []byte("junk")...),
		"nine certificates":   bytes.Repeat(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: ca.cert.Raw}), 9),
	}
	for what, chain := range refusals {
		if _, err := c.install(chain, now); err == nil {
			t.Errorf("%s was installed", what)
		}
	}
	if c.installed != nil {
		t.Fatal("a refused chain left something installed")
	}
	leaf, err := c.install(good, now)
	if err != nil {
		t.Fatalf("a good chain was refused: %v", err)
	}
	// the right name gets the CA chain on the SAME key; any other name (or none) the self-signed carrier
	got, _ := c.getCertificate(&tls.ClientHelloInfo{ServerName: name})
	if got.Leaf != leaf {
		t.Fatal("the installed certificate is not served for the name")
	}
	for _, sni := range []string{"", "395bed3e.app.enclave.host", "127.0.0.1"} {
		if got, _ := c.getCertificate(&tls.ClientHelloInfo{ServerName: sni}); got != c.self {
			t.Errorf("SNI %q got the CA certificate", sni)
		}
	}
	// rotation: a later certificate for the same key and name replaces it; the key never changes
	next := ca.issue(t, pub, name, now.Add(-time.Minute), now.Add(120*24*time.Hour))
	leaf2, err := c.install(next, now)
	if err != nil || leaf2.NotAfter.Equal(leaf.NotAfter) {
		t.Fatalf("rotation: %v", err)
	}
	if got, _ := c.getCertificate(&tls.ClientHelloInfo{ServerName: strings.ToUpper(name)}); got.Leaf != leaf2 {
		t.Fatal("the rotated certificate is not the one served")
	}
	if got, _ := c.getCertificate(&tls.ClientHelloInfo{ServerName: name}); got.PrivateKey != c.key {
		t.Fatal("the served certificate does not carry this domain's own key")
	}
	if _, err := newCertState(t, "").install(good, now); err == nil {
		t.Fatal("a domain with no name installed a certificate")
	}
}
