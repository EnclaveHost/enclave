package egress

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"log"
	"math/big"
	"net"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newCA(t *testing.T) *testCA {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test CA"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	p := x509.NewCertPool()
	p.AddCert(c)
	return &testCA{c, k, p}
}

// a TLS "internet" server holding a certificate for exactly `name`, answering every connection with `body`
func (ca *testCA) server(t *testing.T, name, body string) net.Listener {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, ca.cert, &k.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: k}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.WriteString(c, body) }()
		}
	}()
	return l
}

type rig struct {
	fwd     *Forwarder
	hostLog *bytes.Buffer
	ca      *testCA
}

// A guest forwarder, a host egress server and two "internet" servers, all on loopback; TCP stands in for vsock.
// `route` sends a judged public address to the local server that should answer for it (a DNS record, in effect).
func newRig(t *testing.T, origins []string, route map[string]net.Listener, dns fakeResolver) *rig {
	t.Helper()
	d := &Dialer{Resolver: dns, Own: func() []netip.Addr { return nil }}
	d.dial = func(ctx context.Context, addr string) (net.Conn, error) {
		srv, ok := route[addr]
		if !ok {
			return nil, io.EOF
		}
		c, err := net.Dial("tcp", srv.Addr().String())
		if err != nil {
			return nil, err
		}
		return fakeConn{c, net.TCPAddrFromAddrPort(netip.MustParseAddrPort(addr))}, nil // the peer the dialer judged
	}
	var buf bytes.Buffer
	var mu sync.Mutex
	srv := &Server{Dialer: d, CIDOf: func(net.Conn) uint32 { return 42 }, Log: log.New(writerFunc(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return buf.Write(p) }), "", 0)}
	hl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.Serve(ctx, hl)

	var os []Origin
	for _, h := range origins {
		os = append(os, Origin{Host: h})
	}
	pl, _ := net.Listen("tcp", "127.0.0.1:0") // a free port number for the guest listeners
	port := pl.Addr().(*net.TCPAddr).Port
	pl.Close()
	f := &Forwarder{Policy: &Policy{Origins: os}, Port: port, Upstream: func() (net.Conn, error) { return net.Dial("tcp", hl.Addr().String()) }}
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return &rig{fwd: f, hostLog: &buf, ca: nil}
}

type writerFunc func([]byte) (int, error)

func (w writerFunc) Write(p []byte) (int, error) { return w(p) }

// the tenant: a TLS client that validates `name` against the test CA (wasmtime's rustls does this for a real app)
func tenantGet(t *testing.T, r *rig, ca *testCA, name string, preface []byte) (string, error) {
	t.Helper()
	ap, ok := r.fwd.Addr(name)
	if !ok {
		t.Fatalf("no listener for %s", name)
	}
	c, err := net.DialTimeout("tcp", ap.String(), 5*time.Second)
	if err != nil {
		return "", err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if preface != nil {
		c.Write(preface)
	}
	tc := tls.Client(c, &tls.Config{ServerName: name, RootCAs: ca.pool})
	if err := tc.Handshake(); err != nil {
		return "", err
	}
	b, err := io.ReadAll(tc)
	return string(b), err
}

func TestTheTenantReachesAnAllowedOriginWithTLSEndToEnd(t *testing.T) {
	ca := newCA(t)
	a, b := ca.server(t, "images.example", "A"), ca.server(t, "other.example", "B")
	r := newRig(t, []string{"images.example", "other.example"},
		map[string]net.Listener{"93.184.216.34:443": a, "93.184.216.35:443": b},
		fakeResolver{"images.example": {"93.184.216.34"}, "other.example": {"93.184.216.35"}})
	if got, err := tenantGet(t, r, ca, "images.example", nil); err != nil || got != "A" {
		t.Fatalf("images.example: %q %v", got, err)
	}
	if got, err := tenantGet(t, r, ca, "other.example", nil); err != nil || got != "B" {
		t.Fatalf("other.example: %q %v", got, err)
	}
	if !strings.Contains(r.hostLog.String(), "-> images.example:443 open") {
		t.Fatalf("host log: %s", r.hostLog)
	}
}

// (e) the forwarded target comes from the LISTENER: a tenant that writes a header of its own is only sending payload
func TestTheTenantCannotChooseTheTarget(t *testing.T) {
	ca := newCA(t)
	a := ca.server(t, "images.example", "A")
	r := newRig(t, []string{"images.example"}, map[string]net.Listener{"93.184.216.34:443": a},
		fakeResolver{"images.example": {"93.184.216.34"}, "evil.example": {"93.184.216.66"}})
	tenantGet(t, r, ca, "images.example", []byte("egress-v1 evil.example 443\n")) // the TLS handshake then fails: fine
	time.Sleep(100 * time.Millisecond)
	logs := r.hostLog.String()
	if strings.Contains(logs, "evil.example") || !strings.Contains(logs, "images.example:443 open") {
		t.Fatalf("the tenant's bytes chose a target: %s", logs)
	}
}

func TestAGuestAllowedNameThatResolvesPrivateIsRefusedByTheHost(t *testing.T) {
	ca := newCA(t)
	r := newRig(t, []string{"loop.example"}, map[string]net.Listener{}, fakeResolver{"loop.example": {"127.0.0.1"}})
	if _, err := tenantGet(t, r, ca, "loop.example", nil); err == nil {
		t.Fatal("a private destination was reached")
	}
	time.Sleep(50 * time.Millisecond)
	if !strings.Contains(r.hostLog.String(), "loop.example:443 refused") {
		t.Fatalf("host log: %s", r.hostLog)
	}
}

// (f) a certificate valid for ANOTHER allowlisted host does not pass for this one: DNS sends images.example to the
// server that holds other.example's certificate, and the tenant's TLS refuses it
func TestACertificateForAnotherAllowedHostIsRefused(t *testing.T) {
	ca := newCA(t)
	b := ca.server(t, "other.example", "B")
	r := newRig(t, []string{"images.example", "other.example"},
		map[string]net.Listener{"93.184.216.34:443": b, "93.184.216.35:443": b},
		fakeResolver{"images.example": {"93.184.216.34"}, "other.example": {"93.184.216.35"}})
	if got, err := tenantGet(t, r, ca, "images.example", nil); err == nil {
		t.Fatalf("images.example accepted other.example's certificate: %q", got)
	}
	if got, err := tenantGet(t, r, ca, "other.example", nil); err != nil || got != "B" {
		t.Fatalf("other.example itself: %q %v", got, err)
	}
}

func TestTheServerRefusesToStartWithoutCIDOf(t *testing.T) {
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l.Close()
	if err := (&Server{Dialer: &Dialer{}}).Serve(context.Background(), l); err == nil || !strings.Contains(err.Error(), "CIDOf") {
		t.Fatalf("a server with no CIDOf started: %v", err)
	}
}

func TestHostsFileNamesOnlyTheAllowedOrigins(t *testing.T) {
	f := &Forwarder{Policy: &Policy{Origins: []Origin{{"api.enclave.host"}, {"images.example"}}}}
	h := f.HostsFile()
	for _, want := range []string{"127.0.0.1 localhost", "127.64.0.2 api.enclave.host", "127.64.0.3 images.example"} {
		if !strings.Contains(h, want+"\n") {
			t.Fatalf("hosts file lacks %q:\n%s", want, h)
		}
	}
	if strings.Count(h, "\n") != 3 {
		t.Fatalf("hosts file names more than the allowed origins:\n%s", h)
	}
}
