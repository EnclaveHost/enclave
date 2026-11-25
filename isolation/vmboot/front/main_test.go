package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/tunnel"
)

const deployment = "9a28642b" + "11111111111111111111111111111111111111111111111111111111"

// A report as the AMD-SP lays it out, as far as the front reads it: report_data at 0x50, measurement at 0x90,
// HOST_DATA at 0xc0. The test source keeps the real SEV-SNP field readers.
type fakeSNP struct {
	snpSource
	hostData string
}

func (s *fakeSNP) Report(rd []byte) ([]byte, error) {
	rep := make([]byte, 0x4a0)
	copy(rep[0x50:], rd)
	for i := 0x90; i < 0xc0; i++ {
		rep[i] = 0xab
	}
	hd, _ := hex.DecodeString(s.hostData)
	copy(rep[0xc0:], hd)
	return rep, checkSNP(rep, rd)
}
func fakeReporter(hostData string) source { return &fakeSNP{hostData: hostData} }

// A platform whose report has no deployment field: the launcher names it, as on an Enclave Shield host.
type fakeShield struct{ deployment string }

func (fakeShield) Platform() string                 { return "shield" }
func (fakeShield) Format() string                   { return "shield-vm-v1" }
func (fakeShield) Report(rd []byte) ([]byte, error) { return append([]byte("HCLA"), rd...), nil }
func (fakeShield) Measurement([]byte) string        { return "" }
func (s fakeShield) Deployment([]byte) string       { return s.deployment }

type ca struct {
	key  *ecdsa.PrivateKey
	cert *x509.Certificate
}

func newCA(t *testing.T) ca {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test root"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, _ := x509.ParseCertificate(der)
	return ca{key, cert}
}

func (c ca) issue(t *testing.T, name string, pub any, notAfter time.Time) []byte {
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, c.cert, pub, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func testFront(t *testing.T, hostData string, root ca, app http.Handler) (*front, *httptest.Server) {
	roots := x509.NewCertPool()
	roots.AddCert(root.cert)
	f, err := newFront(fakeReporter(hostData), "console=ttyS0 enclave.roothash="+strings.Repeat("5a", 32)+" enclave.root=2:00", "enclave-rpc", "app.enclave.host", roots, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	up := httptest.NewServer(app)
	t.Cleanup(up.Close)
	f.upstream, f.proxy = strings.TrimPrefix(up.URL, "http://"), newProxy(strings.TrimPrefix(up.URL, "http://"))
	f.tunnels, _ = tunnel.Load("/nonexistent/app.ports", 8000)
	s := httptest.NewUnstartedServer(f)
	s.TLS = &tls.Config{GetCertificate: f.certificate, NextProtos: []string{"http/1.1"}}
	s.StartTLS()
	t.Cleanup(s.Close)
	return f, s
}

func get(t *testing.T, s *httptest.Server, sni, path string) (int, []byte, *x509.Certificate) {
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true, ServerName: sni}}}
	r, err := c.Get(s.URL + path)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	return r.StatusCode, b, r.TLS.PeerCertificates[0]
}

func TestBootDocumentBindsTheServedKey(t *testing.T) {
	f, s := testFront(t, deployment, newCA(t), http.NotFoundHandler())
	code, body, peer := get(t, s, "enclave-rpc", "/.well-known/enclave-attestation")
	var doc map[string]string
	if code != 200 || json.Unmarshal(body, &doc) != nil {
		t.Fatalf("boot document: %d %s", code, body)
	}
	rep, _ := base64.StdEncoding.DecodeString(doc["report"])
	spki, _ := x509.MarshalPKIXPublicKey(peer.PublicKey)
	want := sha256.Sum256(spki)
	if !bytes.Equal(rep[0x50:0x70], want[:]) || !bytes.Equal(rep[0x70:0x90], make([]byte, 32)) {
		t.Fatal("report_data is not sha256(served SPKI) then zeros")
	}
	b, _ := pem.Decode([]byte(doc["certificate"]))
	if !bytes.Equal(b.Bytes, peer.Raw) {
		t.Fatal("the document's certificate is not the served one")
	}
	if f.appName != "9a28642b.app.enclave.host" {
		t.Fatalf("app name %q", f.appName)
	}
}

func TestFreshReportBindsTheNonce(t *testing.T) {
	f, s := testFront(t, deployment, newCA(t), http.NotFoundHandler())
	nonce := strings.Repeat("c3", 32)
	code, body, _ := get(t, s, "enclave-rpc", "/.well-known/enclave-attestation?nonce="+nonce)
	var doc map[string]string
	if code != 200 || json.Unmarshal(body, &doc) != nil {
		t.Fatalf("fresh: %d %s", code, body)
	}
	rep, _ := base64.StdEncoding.DecodeString(doc["report"])
	n, _ := hex.DecodeString(nonce)
	want := sha256.Sum256(append(append([]byte{}, f.spki...), n...))
	if doc["format"] != "sev-snp-vm-v1" || doc["platform"] != "sev-snp" || doc["nonce"] != nonce || doc["hostData"] != deployment || doc["appSha256"] != strings.Repeat("5a", 32) ||
		!bytes.Equal(rep[0x50:0x70], want[:]) {
		t.Fatalf("fresh document %v", doc)
	}
	for _, bad := range []string{"nonce=" + strings.ToUpper(nonce), "nonce=" + nonce[:62], "nonce=" + nonce + "&x=1", "x=1"} {
		if code, _, _ := get(t, s, "enclave-rpc", "/.well-known/enclave-attestation?"+bad); code != 400 {
			t.Fatalf("%s answered %d", bad, code)
		}
	}
}

func TestSmokeBootHasNoAppName(t *testing.T) {
	_, s := testFront(t, strings.Repeat("0", 64), newCA(t), http.NotFoundHandler())
	if code, _, _ := get(t, s, "enclave-rpc", "/.well-known/enclave-csr"); code != 404 {
		t.Fatalf("csr answered %d", code)
	}
}

func post(t *testing.T, s *httptest.Server, body []byte) (int, map[string]any) {
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	r, err := c.Post(s.URL+"/.well-known/enclave-cert", "application/x-pem-file", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	var out map[string]any
	json.NewDecoder(r.Body).Decode(&out)
	return r.StatusCode, out
}

func TestCertificateInstalledOnlyIfItVerifiesHere(t *testing.T) {
	root, other := newCA(t), newCA(t)
	f, s := testFront(t, deployment, root, http.NotFoundHandler())
	code, body, _ := get(t, s, "enclave-rpc", "/.well-known/enclave-csr")
	b, _ := pem.Decode(body)
	req, err := x509.ParseCertificateRequest(b.Bytes)
	if code != 200 || err != nil || req.CheckSignature() != nil || req.Subject.CommonName != f.appName || len(req.DNSNames) != 1 || req.DNSNames[0] != f.appName {
		t.Fatalf("csr: %d %v", code, err)
	}
	stranger, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	soon := time.Now().Add(time.Hour)
	for name, chain := range map[string][]byte{
		"another key":     root.issue(t, f.appName, &stranger.PublicKey, soon),
		"another name":    root.issue(t, "deadbeef.app.enclave.host", req.PublicKey, soon),
		"untrusted root":  other.issue(t, f.appName, req.PublicKey, soon),
		"expired":         root.issue(t, f.appName, req.PublicKey, time.Now().Add(-time.Minute)),
		"not a chain":     []byte("hello"),
		"trailing matter": append(root.issue(t, f.appName, req.PublicKey, soon), []byte("x")...),
	} {
		if code, out := post(t, s, chain); code != 422 || out["installed"] != false {
			t.Fatalf("%s: %d %v", name, code, out)
		}
	}
	if _, _, peer := get(t, s, f.appName, "/health"); peer.Subject.CommonName != "enclave-rpc" {
		t.Fatal("a refused chain changed what is served")
	}
	if code, out := post(t, s, root.issue(t, f.appName, req.PublicKey, soon)); code != 200 || out["installed"] != true {
		t.Fatalf("good chain: %d %v", code, out)
	}
	if _, _, peer := get(t, s, f.appName, "/health"); peer.Subject.CommonName != f.appName {
		t.Fatal("the app name is not served on the installed chain")
	}
	if _, _, peer := get(t, s, "enclave-rpc", "/health"); peer.Subject.CommonName != "enclave-rpc" {
		t.Fatal("the local name left the boot certificate")
	}
}

func TestAppGetsEverythingButThePlatformNamespace(t *testing.T) {
	var seen []string
	app := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.URL.Path+"|"+r.Header.Get("X-Forwarded-For")+"|"+r.Header.Get("X-Forwarded-Proto"))
		w.WriteHeader(401)
	})
	_, s := testFront(t, deployment, newCA(t), app)
	c := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	req, _ := http.NewRequest("GET", s.URL+"/desktop/api/state", nil)
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	r, err := c.Do(req)
	if err != nil || r.StatusCode != 401 {
		t.Fatalf("proxied: %v %v", r, err)
	}
	if code, _, _ := get(t, s, "", "/.well-known/enclave-secrets"); code != 404 {
		t.Fatalf("platform namespace answered %d", code)
	}
	if code, _, _ := get(t, s, "", "/.well-known/enclave-tunnel/tcp/47989"); code != 404 {
		t.Fatalf("undeclared tunnel answered %d", code)
	}
	if code, body, _ := get(t, s, "", "/health"); code != 200 || !strings.Contains(string(body), `"listening":true`) {
		t.Fatalf("health: %d %s", code, body)
	}
	if len(seen) != 1 || seen[0] != "/desktop/api/state||https" {
		t.Fatalf("the app saw %v", seen)
	}
}

func TestSameEndpointsOnAnotherPlatform(t *testing.T) {
	roots := x509.NewCertPool()
	f, err := newFront(fakeShield{deployment: deployment}, "enclave.roothash="+strings.Repeat("5a", 32), "enclave-rpc", "app.enclave.host", roots, time.Now)
	if err != nil {
		t.Fatal(err)
	}
	if f.appName != "9a28642b.app.enclave.host" || len(f.csr) == 0 {
		t.Fatalf("app name %q", f.appName)
	}
	nonce := strings.Repeat("0f", 32)
	body, busy, err := f.fresh(nonce)
	var doc map[string]string
	if err != nil || busy || json.Unmarshal(body, &doc) != nil {
		t.Fatal(err, busy)
	}
	rep, _ := base64.StdEncoding.DecodeString(doc["report"])
	n, _ := hex.DecodeString(nonce)
	want := sha256.Sum256(append(append([]byte{}, f.spki...), n...))
	if doc["format"] != "shield-vm-v1" || doc["platform"] != "shield" || doc["appSha256"] != strings.Repeat("5a", 32) ||
		doc["hostData"] != deployment || !bytes.Equal(rep[4:36], want[:]) {
		t.Fatalf("document %v", doc)
	}
	var boot map[string]string
	if json.Unmarshal(f.bootDoc, &boot) != nil || boot["platform"] != "shield" {
		t.Fatalf("boot document %v", boot)
	}
}

func TestSourceIsChosenOrRefused(t *testing.T) {
	dir := t.TempDir()
	if s, err := pickSource("auto", dir, dir+"/no-tpm", dir+"/none"); err != nil || s.Platform() != "sev-snp" {
		t.Fatalf("auto with a report interface: %v %v", s, err)
	}
	if _, err := pickSource("auto", dir+"/absent", dir+"/no-tpm", dir+"/none"); err == nil {
		t.Fatal("a boot with no report source was accepted")
	}
	if _, err := pickSource("tdx", dir, dir, dir); err == nil {
		t.Fatal("an unknown source was accepted")
	}
}
