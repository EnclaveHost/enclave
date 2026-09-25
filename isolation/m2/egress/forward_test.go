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
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/netip"
	"regexp"
	"sort"
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
	fwd      *Forwarder
	hostAddr string
	mu       sync.Mutex
	log      bytes.Buffer
	looked   []string // names the host resolved: the synthetic observer of which destination was chosen
	dialed   []string // addresses the host dialed
}

func (r *rig) logs() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.log.String()
}

func (r *rig) observed() (looked, dialed []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.looked...), append([]string(nil), r.dialed...)
}

// observingResolver records every name the host resolves, then answers from the fake zone
type observingResolver struct {
	r   *rig
	dns fakeResolver
}

func (o observingResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	o.r.mu.Lock()
	o.r.looked = append(o.r.looked, host)
	o.r.mu.Unlock()
	return o.dns.LookupNetIP(ctx, network, host)
}

// A guest forwarder, a host egress server and "internet" servers, all on loopback; TCP stands in for vsock.
// `route` sends a judged public address to the local server that should answer for it (a DNS record, in effect); an
// address with no route fails the way a real connect does, with an error naming the address.
func newRig(t *testing.T, origins []string, route map[string]net.Listener, dns fakeResolver) *rig {
	t.Helper()
	r := &rig{}
	d := &Dialer{Resolver: observingResolver{r, dns}, Own: func() []netip.Addr { return nil }}
	d.dial = func(ctx context.Context, addr string) (net.Conn, error) {
		r.mu.Lock()
		r.dialed = append(r.dialed, addr)
		r.mu.Unlock()
		srv, ok := route[addr]
		if !ok {
			return nil, fmt.Errorf("dial tcp %s: connect: connection refused", addr)
		}
		c, err := net.Dial("tcp", srv.Addr().String())
		if err != nil {
			return nil, err
		}
		return fakeConn{c, net.TCPAddrFromAddrPort(netip.MustParseAddrPort(addr))}, nil // the peer the dialer judged
	}
	srv := &Server{Dialer: d, CIDOf: func(net.Conn) uint32 { return 42 },
		Log: log.New(writerFunc(func(p []byte) (int, error) { r.mu.Lock(); defer r.mu.Unlock(); return r.log.Write(p) }), "", 0)}
	hl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	r.hostAddr = hl.Addr().String()
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
	r.fwd = &Forwarder{Policy: &Policy{Origins: os}, Port: port, Upstream: func() (net.Conn, error) { return net.Dial("tcp", r.hostAddr) }}
	if err := r.fwd.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return r
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
	if _, dialed := r.observed(); strings.Join(dialed, ",") != "93.184.216.34:443,93.184.216.35:443" {
		t.Fatalf("the host dialed %v", dialed)
	}
	if got := r.logs(); got != "guest 42 egress open\nguest 42 egress open\n" {
		t.Fatalf("host log: %q", got)
	}
}

// (e) the forwarded target comes from the LISTENER: a tenant that writes a header of its own is only sending payload
func TestTheTenantCannotChooseTheTarget(t *testing.T) {
	ca := newCA(t)
	a := ca.server(t, "images.example", "A")
	r := newRig(t, []string{"images.example"}, map[string]net.Listener{"93.184.216.34:443": a},
		fakeResolver{"images.example": {"93.184.216.34"}, "evil.example": {"93.184.216.66"}})
	tenantGet(t, r, ca, "images.example", []byte("egress-v1 evil.example 443\n")) // the TLS handshake then fails: fine
	if looked, dialed := r.observed(); strings.Join(looked, ",") != "images.example" || strings.Join(dialed, ",") != "93.184.216.34:443" {
		t.Fatalf("the tenant's bytes chose a target: resolved %v, dialed %v", looked, dialed)
	}
}

func TestAGuestAllowedNameThatResolvesPrivateIsRefusedByTheHost(t *testing.T) {
	ca := newCA(t)
	r := newRig(t, []string{"loop.example"}, map[string]net.Listener{}, fakeResolver{"loop.example": {"127.0.0.1"}})
	if _, err := tenantGet(t, r, ca, "loop.example", nil); err == nil {
		t.Fatal("a private destination was reached")
	}
	if _, dialed := r.observed(); len(dialed) != 0 {
		t.Fatalf("a private answer was dialed: %v", dialed)
	}
	if got := r.logs(); got != "guest 42 egress refused:non-public-answer\n" {
		t.Fatalf("host log: %q", got)
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

// Codex's review of f109bf8d: a destination can come from a SECRET, so the host's log records the guest and a bounded
// outcome code only, never a hostname, an address or a raw network error - on success and on every failure. The names
// here stand in for secret-derived endpoints; the dialer's raw connect error names the address, and must be dropped.
func TestTheHostLogNeverRecordsADestinationOrARawError(t *testing.T) {
	ca := newCA(t)
	ok := ca.server(t, "tok-5ecret-a1.example", "A")
	r := newRig(t, []string{"tok-5ecret-a1.example", "tok-5ecret-b2.example", "tok-5ecret-c3.example", "tok-5ecret-d4.example"},
		map[string]net.Listener{"93.184.216.71:443": ok},
		fakeResolver{
			"tok-5ecret-a1.example": {"93.184.216.71"}, // success
			// b2 does not resolve
			"tok-5ecret-c3.example": {"93.184.216.73"}, // resolves, but nothing accepts: the raw error names the address
			"tok-5ecret-d4.example": {"10.9.8.7"},      // a private answer
		})
	if got, err := tenantGet(t, r, ca, "tok-5ecret-a1.example", nil); err != nil || got != "A" {
		t.Fatalf("the reachable origin: %q %v", got, err)
	}
	for _, h := range []string{"tok-5ecret-b2.example", "tok-5ecret-c3.example", "tok-5ecret-d4.example"} {
		if _, err := tenantGet(t, r, ca, h, nil); err == nil {
			t.Fatalf("%s was reached", h)
		}
	}
	// a header the guest's forwarder never sends (a port other than 443, and garbage), straight to the host
	for _, hdr := range []string{"egress-v1 tok-5ecret-e5.example 80\n", "tok-5ecret-f6.example\n"} {
		c, err := net.Dial("tcp", r.hostAddr)
		if err != nil {
			t.Fatal(err)
		}
		c.SetDeadline(time.Now().Add(5 * time.Second))
		io.WriteString(c, hdr)
		if b, _ := io.ReadAll(c); string(b) != "refused\n" {
			t.Fatalf("%q: %q", hdr, b)
		}
		c.Close()
	}
	// the destinations WERE chosen (the observer saw them), and the log still names none of them
	if looked, _ := r.observed(); len(looked) != 4 {
		t.Fatalf("the host resolved %v", looked)
	}
	logs := r.logs()
	line := regexp.MustCompile(`^guest 42 egress (open|refused:[a-z-]+)$`)
	var codes []string
	for _, l := range strings.Split(strings.TrimSuffix(logs, "\n"), "\n") {
		if !line.MatchString(l) {
			t.Fatalf("a host log line outside the bounded form: %q", l)
		}
		codes = append(codes, strings.TrimPrefix(l, "guest 42 egress "))
	}
	sort.Strings(codes)
	want := "open,refused:connect,refused:header,refused:header,refused:non-public-answer,refused:resolve"
	if strings.Join(codes, ",") != want {
		t.Fatalf("outcomes %v, want %s", codes, want)
	}
	for _, leak := range []string{"5ecret", ".example", "93.184.216", "10.9.8.7", "connection refused", "dial tcp", ":443", ":80"} {
		if strings.Contains(logs, leak) {
			t.Fatalf("the host log records %q:\n%s", leak, logs)
		}
	}
}
