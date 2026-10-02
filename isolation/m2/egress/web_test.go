package egress

import (
	"context"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func webForwarder(t *testing.T, r *rig) *Forwarder {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	f := &Forwarder{Policy: &Policy{PublicHTTPS: true, PublicWeb: true}, PublicListen: "127.0.0.1:0", DNSListen: "127.0.0.1:0", Upstream: func() (net.Conn, error) { return net.Dial("tcp", r.hostAddr) }}
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return f
}
func dnsQuestion(name string, kind uint16) []byte {
	q := []byte{0x12, 0x34, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0}
	for _, s := range strings.Split(name, ".") {
		q = append(q, byte(len(s)))
		q = append(q, s...)
	}
	q = append(q, 0)
	q = binary.BigEndian.AppendUint16(q, kind)
	return append(q, 0, 1)
}
func TestPublicWebDNSAndHTTP(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
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
			go func() { defer c.Close(); io.WriteString(c, "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello") }()
		}
	}()
	r := newRig(t, nil, map[string]net.Listener{"93.184.216.34:80": l}, fakeResolver{"web.example": {"93.184.216.34", "2606:4700:4700::1111"}, "mixed.example": {"93.184.216.34", "10.0.0.1"}})
	f := webForwarder(t, r)
	if f.HostsFile() != "127.0.0.1 localhost\n" {
		t.Fatal("public names shadowed by loopback")
	}
	a, _ := f.DNSAddr()
	c, err := net.Dial("tcp", a.String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(3 * time.Second))
	for _, kind := range []uint16{1, 28} {
		q := dnsQuestion("web.example", kind)
		packet := binary.BigEndian.AppendUint16(nil, uint16(len(q)))
		c.Write(append(packet, q...))
		var n [2]byte
		if _, err := io.ReadFull(c, n[:]); err != nil {
			t.Fatal(err)
		}
		answer := make([]byte, binary.BigEndian.Uint16(n[:]))
		if _, err := io.ReadFull(c, answer); err != nil {
			t.Fatal(err)
		}
		if answer[3]&15 != 0 || binary.BigEndian.Uint16(answer[6:8]) != 1 {
			t.Fatalf("DNS response %x", answer)
		}
	}
	answer := f.answerPublicDNS(dnsQuestion("mixed.example", 1))
	if answer[3]&15 == 0 || binary.BigEndian.Uint16(answer[6:8]) != 0 {
		t.Fatal("mixed public/private DNS escaped")
	}
	for _, request := range [][]byte{connectName("web.example", 80), {5, 1, 0, 1, 93, 184, 216, 34, 0, 80}} {
		conn, code := socksRequest(t, f, request)
		if code != 0 {
			t.Fatalf("public HTTP refused: %d", code)
		}
		body, err := io.ReadAll(conn)
		if err != nil || !strings.HasSuffix(string(body), "hello") {
			t.Fatalf("HTTP bytes %q %v", body, err)
		}
	}
	for _, request := range [][]byte{connectName("mixed.example", 443), connectName("web.example", 22), {5, 1, 0, 1, 127, 0, 0, 1, 1, 187}, {5, 1, 0, 1, 169, 254, 169, 254, 0, 80}, {5, 1, 0, 1, 10, 0, 0, 1, 1, 187}} {
		_, code := socksRequest(t, f, request)
		if code == 0 {
			t.Fatalf("private/other-port request accepted: %x", request)
		}
	}
	if strings.Contains(r.logs(), "web.example") || strings.Contains(r.logs(), "93.184") {
		t.Fatal("destination leaked into host log")
	}
}
func TestPublicWebPolicyAndPrivateDial(t *testing.T) {
	for _, cfg := range []string{`{}`, `{"egress":"public-https"}`, `{"egress":["https://web.example"]}`} {
		p, err := derive(cfg, Origin{Host: "api.enclave.host"})
		if err != nil || p.PublicWeb {
			t.Fatalf("implicit web mode: %+v %v", p, err)
		}
	}
	p, err := derive(`{"egress":"public-web"}`, Origin{Host: "api.enclave.host"})
	if err != nil || !p.PublicWeb || !p.PublicHTTPS {
		t.Fatalf("opt-in %+v %v", p, err)
	}
	own := netip.MustParseAddr("93.184.216.34")
	d, dialed := testDialer(fakeResolver{"own.example": {"93.184.216.34"}}, nil)
	d.Own = func() []netip.Addr { return []netip.Addr{own} }
	for _, host := range []string{"own.example", "93.184.216.34", "127.0.0.1", "::ffff:127.0.0.1", "169.254.169.254", "10.0.0.1", "100.64.0.1", "[::1]", "x.example/path", "x.example\n"} {
		if c, rel, err := d.DialWeb(context.Background(), 7, host, 80); err == nil {
			c.Close()
			rel()
			t.Fatalf("accepted %q", host)
		}
	}
	if len(*dialed) != 0 {
		t.Fatal("dialed a refused destination")
	}
}
func TestPublicDNSMalformedAndNonAddressQuestions(t *testing.T) {
	f := &Forwarder{Upstream: func() (net.Conn, error) { t.Fatal("invalid DNS reached upstream"); return nil, nil }}
	for _, q := range [][]byte{nil, {0}, append(dnsQuestion("web.example", 1)[:12], 0xc0, 0x0c, 0, 1, 0, 1)} {
		if f.answerPublicDNS(q) != nil {
			t.Fatal("accepted malformed DNS")
		}
	}
	for _, name := range []string{"127.0.0.1", "localhost", "web.example/path"} {
		a := f.answerPublicDNS(dnsQuestion(name, 1))
		if a == nil || a[3]&15 == 0 {
			t.Fatal("accepted invalid DNS host")
		}
	}
	a := f.answerPublicDNS(dnsQuestion("web.example", 16))
	if a == nil || binary.BigEndian.Uint16(a[6:8]) != 0 {
		t.Fatal("non-address query")
	}
}

// Run in an isolated user/mount/network namespace; never edits the host resolver.
func TestPublicWebLibcResolver(t *testing.T) {
	if os.Getenv("EGRESS_TEST_ISOLATED_RESOLVER") != "1" {
		t.Skip("requires isolated mount/network namespace")
	}
	r := newRig(t, nil, nil, fakeResolver{"browser.example": {"93.184.216.34"}, "private.example": {"10.0.0.1"}})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	f := &Forwarder{Policy: &Policy{PublicWeb: true, PublicHTTPS: true}, PublicListen: "127.0.0.2:1080", DNSListen: PublicDNSAddress, Upstream: func() (net.Conn, error) { return net.Dial("tcp", r.hostAddr) }}
	if err := f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, data := range map[string]string{"resolv.conf": "nameserver 127.0.0.2\noptions use-vc timeout:2 attempts:1\n", "nsswitch.conf": "hosts: dns\n"} {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Mount(p, "/etc/"+name, "", syscall.MS_BIND, ""); err != nil {
			t.Fatal(err)
		}
	}
	out, err := exec.Command("python3", "-c", "import socket; print(socket.getaddrinfo('browser.example',443,socket.AF_INET,socket.SOCK_STREAM))").CombinedOutput()
	if err != nil || !strings.Contains(string(out), "93.184.216.34") {
		t.Fatalf("glibc resolver: %q %v", out, err)
	}
	if out, err := exec.Command("python3", "-c", "import socket; print(socket.getaddrinfo('private.example',443,socket.AF_INET,socket.SOCK_STREAM))").CombinedOutput(); err == nil {
		t.Fatalf("private resolver succeeded: %q", out)
	}
}
