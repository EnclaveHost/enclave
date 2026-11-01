package egress

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func TestPublicHTTPSPolicy(t *testing.T) {
	relay := Origin{Host: "api.enclave.host"}
	p, err := derive(`{"egress":"public-https"}`, relay)
	if err != nil || !p.PublicHTTPS || !p.Allows("enclave.host") || p.Allows("127.0.0.1") {
		t.Fatalf("policy: %+v %v", p, err)
	}
	for _, cfg := range []string{`{}`, `{"tools":{"builtin":["request"]}}`, `{"egress":[]}`, `{"egress":["https://only.example"]}`, `{"other":"public-https"}`} {
		p, err = derive(cfg, relay)
		if err != nil || p.PublicHTTPS || p.Allows("enclave.host") {
			t.Fatalf("implicit expansion: %s %+v %v", cfg, p, err)
		}
	}
	for _, cfg := range []string{`{"egress":"*"}`, `{"egress":true}`, `{"egress":{}}`, `{"egress":"PUBLIC-HTTPS"}`} {
		if _, err = derive(cfg, relay); err == nil {
			t.Fatalf("accepted %s", cfg)
		}
	}
}

func publicForwarder(t *testing.T, r *rig) *Forwarder {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	f := &Forwarder{Policy: &Policy{PublicHTTPS: true}, PublicListen: "127.0.0.1:0", Upstream: func() (net.Conn, error) { return net.Dial("tcp", r.hostAddr) }}
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}

func socksRequest(t *testing.T, f *Forwarder, request []byte) (net.Conn, byte) {
	t.Helper()
	a, ok := f.PublicAddr()
	if !ok {
		t.Fatal("no SOCKS listener")
	}
	c, err := net.Dial("tcp", a.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(3 * time.Second))
	c.Write([]byte{5, 1, 2})
	var h [2]byte
	if _, err = io.ReadFull(c, h[:]); err != nil || h != [2]byte{5, 2} {
		t.Fatalf("greeting %v %v", h, err)
	}
	c.Write(append(append([]byte{1, 5}, []byte("guest")...), append([]byte{12}, []byte("public-https")...)...))
	// public-https has 12 bytes.
	if _, err = io.ReadFull(c, h[:]); err != nil || h != [2]byte{1, 0} {
		t.Fatalf("auth %v %v", h, err)
	}
	c.Write(request)
	var reply [10]byte
	if _, err = io.ReadFull(c, reply[:]); err != nil {
		t.Fatal(err)
	}
	return c, reply[1]
}
func connectName(name string, port uint16) []byte {
	return append(append([]byte{5, 1, 0, 3, byte(len(name))}, []byte(name)...), byte(port>>8), byte(port))
}

func TestPublicHTTPSConnectAndPrivateDNSRefusal(t *testing.T) {
	ca := newCA(t)
	srv := ca.server(t, "new.example", "unlisted page")
	r := newRig(t, nil, map[string]net.Listener{"93.184.216.34:443": srv}, fakeResolver{"new.example": {"93.184.216.34"}, "private.example": {"127.0.0.1"}, "mixed.example": {"93.184.216.34", "10.0.0.1"}})
	f := publicForwarder(t, r)
	c, code := socksRequest(t, f, connectName("new.example", 443))
	if code != 0 {
		t.Fatalf("public refused: %d", code)
	}
	tc := tls.Client(c, &tls.Config{ServerName: "new.example", RootCAs: ca.pool})
	b, err := io.ReadAll(tc)
	tc.Close()
	if err != nil || string(b) != "unlisted page" {
		t.Fatalf("TLS read: %q %v", b, err)
	}
	for _, name := range []string{"private.example", "mixed.example"} {
		c, code = socksRequest(t, f, connectName(name, 443))
		c.Close()
		if code == 0 {
			t.Fatalf("private DNS passed: %s", name)
		}
	}
	_, dialed := r.observed()
	if len(dialed) != 1 {
		t.Fatalf("private addresses reached dial: %v", dialed)
	}
	if strings.Contains(r.logs(), "new.example") || strings.Contains(r.logs(), "private.example") {
		t.Fatal("destination leaked to logs")
	}
}

func TestPublicHTTPSRejectsBeforeUpstream(t *testing.T) {
	r := newRig(t, nil, nil, nil)
	f := publicForwarder(t, r)
	for _, name := range []string{"127.0.0.1", "2130706433", "0x7f.1", "localhost", "[::1]", "ok.example/evil", "ok.example:443", "ok.example?x", "ok.example\nevil"} {
		c, code := socksRequest(t, f, connectName(name, 443))
		c.Close()
		if code == 0 {
			t.Fatalf("accepted %q", name)
		}
	}
	for _, port := range []uint16{0, 80, 1080, 8080, 65535} {
		c, code := socksRequest(t, f, connectName("new.example", port))
		c.Close()
		if code == 0 {
			t.Fatalf("accepted port %d", port)
		}
	}
	for _, hdr := range [][]byte{{5, 2, 0, 3}, {5, 3, 0, 3}, {5, 1, 1, 3}, {5, 1, 0, 1}, {5, 1, 0, 4}} {
		c, code := socksRequest(t, f, hdr)
		c.Close()
		if code == 0 {
			t.Fatalf("accepted command %v", hdr)
		}
	}
	looked, dialed := r.observed()
	if len(looked) != 0 || len(dialed) != 0 {
		t.Fatalf("refused input reached host: %v %v", looked, dialed)
	}
}

func TestPublicHTTPSKeepsTLSVerification(t *testing.T) {
	ca := newCA(t)
	srv := ca.server(t, "wrong.example", "must not be trusted")
	r := newRig(t, nil, map[string]net.Listener{"93.184.216.34:443": srv}, fakeResolver{"new.example": {"93.184.216.34"}})
	f := publicForwarder(t, r)
	c, code := socksRequest(t, f, connectName("new.example", 443))
	if code != 0 {
		t.Fatal(code)
	}
	tc := tls.Client(c, &tls.Config{ServerName: "new.example", RootCAs: ca.pool})
	defer tc.Close()
	if err := tc.Handshake(); err == nil {
		t.Fatal("wrong TLS identity trusted")
	}
}

func TestPublicHTTPSOffHasNoListener(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &Forwarder{Policy: &Policy{}, PublicListen: "127.0.0.1:0"}
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, ok := f.PublicAddr(); ok {
		t.Fatal("public listener enabled without owner opt-in")
	}
}
