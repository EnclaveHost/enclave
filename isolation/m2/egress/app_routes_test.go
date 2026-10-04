package egress

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAppRoutesAreBoundExpiringAndNeverShared(t *testing.T) {
	file := filepath.Join(t.TempDir(), "routes.json")
	id := "0x" + strings.Repeat("1", 64)
	other := "0x" + strings.Repeat("2", 64)
	r := AppRoute{Proxies: []string{"127.0.0.1:14567"}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}
	doc := AppRouteFile{Version: 1, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Apps: map[string]AppRoute{id: r}}
	write := func() {
		b, _ := json.Marshal(doc)
		if e := os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	if _, e := ReadAppRoute(file, id); e != nil {
		t.Fatal(e)
	}
	if _, e := ReadAppRoute(file, other); e == nil {
		t.Fatal("another app used a route")
	}
	doc.Apps[other] = r
	write()
	if _, e := ReadAppRoute(file, id); e == nil {
		t.Fatal("shared proxy accepted")
	}
	delete(doc.Apps, other)
	doc.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	write()
	if _, e := ReadAppRoute(file, id); e == nil {
		t.Fatal("expired route accepted")
	}
}
func TestAppRouteFailureNeverUsesLegacyResolverOrProxy(t *testing.T) {
	d := Dialer{Resolver: panicResolver{}, SOCKSProxy: "127.0.0.1:30489", RouteFor: func(cid uint32) (AppRoute, error) { return AppRoute{}, os.ErrNotExist }}
	if _, _, e := d.Dial(context.Background(), 12, "service.example", 443); ReasonOf(e) != ReasonAdmit {
		t.Fatalf("missing app route: %v", e)
	}
}

type panicResolver struct{}

func (panicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	panic("app egress attempted host DNS")
}

func TestAppRoutesCoverBrowserDNSAndBothWebPorts(t *testing.T) {
	d := Dialer{Resolver: panicResolver{}, SOCKSProxy: "127.0.0.1:30489", RouteFor: func(cid uint32) (AppRoute, error) { return AppRoute{}, os.ErrNotExist }}
	if _, e := d.ResolvePublic(context.Background(), 12, "service.example"); ReasonOf(e) != ReasonAdmit {
		t.Fatalf("DNS escaped missing route: %v", e)
	}
	for _, port := range []int{80, 443} {
		if _, _, e := d.DialWeb(context.Background(), 12, "93.184.216.34", port); ReasonOf(e) != ReasonAdmit {
			t.Fatalf("web escaped missing route: %v", e)
		}
	}
	d.RouteFor = func(uint32) (AppRoute, error) {
		return AppRoute{Proxies: []string{"127.0.0.1:1", "127.0.0.1:2"}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}, nil
	}
	if _, e := d.ResolvePublic(context.Background(), 12, "service.example"); ReasonOf(e) != ReasonResolve {
		t.Fatalf("DNS escaped failed routes: %v", e)
	}
	for _, port := range []int{80, 443} {
		if _, _, e := d.DialWeb(context.Background(), 12, "93.184.216.34", port); ReasonOf(e) != ReasonConnect {
			t.Fatalf("web escaped failed routes: %v", e)
		}
	}
	if d.active[12] != 0 {
		t.Fatal("failure leaked guest slot")
	}
}

func TestAppWebLiteralUsesItsSecondProxyWithoutDNS(t *testing.T) {
	for _, port := range []int{80, 443} {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		got := make(chan []byte, 1)
		go func() {
			c, e := ln.Accept()
			if e != nil {
				return
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(2 * time.Second))
			hello := make([]byte, 3)
			if _, e = io.ReadFull(c, hello); e != nil {
				return
			}
			c.Write([]byte{5, 0})
			req := make([]byte, 10)
			if _, e = io.ReadFull(c, req); e != nil {
				return
			}
			got <- req
			c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
			io.Copy(c, c)
		}()
		d := Dialer{Resolver: panicResolver{}, RouteFor: func(cid uint32) (AppRoute, error) {
			if cid != 73 {
				return AppRoute{}, os.ErrNotExist
			}
			return AppRoute{Proxies: []string{"127.0.0.1:1", ln.Addr().String()}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "unused.example", Path: "/dns-query"}}}, nil
		}}
		c, release, e := d.DialWeb(context.Background(), 73, "93.184.216.34", port)
		if e != nil {
			ln.Close()
			t.Fatal(e)
		}
		request := <-got
		if !bytes.Equal(request, []byte{5, 1, 0, 1, 93, 184, 216, 34, byte(port >> 8), byte(port)}) {
			t.Fatalf("wrong proxy target: %x", request)
		}
		c.SetDeadline(time.Now().Add(time.Second))
		c.Write([]byte("hello"))
		reply := make([]byte, 5)
		if _, e = io.ReadFull(c, reply); e != nil || string(reply) != "hello" {
			t.Fatalf("TCP not forwarded: %q %v", reply, e)
		}
		c.Close()
		release()
		ln.Close()
		if _, _, e = d.DialWeb(context.Background(), 74, "93.184.216.34", port); ReasonOf(e) != ReasonAdmit {
			t.Fatal("another guest used the proxy")
		}
	}
}

func TestBootstrapIsOnlyRawTLSAndNeverDirect(t *testing.T) {
	calls := 0
	d := Dialer{Resolver: panicResolver{}, SOCKSProxy: "127.0.0.1:1", RouteFor: func(uint32) (AppRoute, error) { return AppRoute{}, os.ErrNotExist }, BootstrapRouteFor: func(cid uint32, host string, port int) (AppRoute, error) {
		calls++
		return AppRoute{}, os.ErrPermission
	}}
	if _, _, err := d.Dial(context.Background(), 12, "api.enclave.host", 443); ReasonOf(err) != ReasonAdmit || calls != 1 {
		t.Fatalf("bootstrap denial: %v calls=%d", err, calls)
	}
	for _, port := range []int{80, 443} {
		d.DialWeb(context.Background(), 12, "api.enclave.host", port)
	}
	d.ResolvePublic(context.Background(), 12, "api.enclave.host")
	d.Dial(context.Background(), 12, "1.1.1.1", 443)
	d.Dial(context.Background(), 12, "api.enclave.host", 80)
	if calls != 1 {
		t.Fatal("web, DNS, IP or non-TLS request used bootstrap")
	}
	d.RouteFor = func(uint32) (AppRoute, error) {
		return AppRoute{Proxies: []string{"127.0.0.1:1"}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}, nil
	}
	d.Dial(context.Background(), 12, "api.enclave.host", 443)
	if calls != 1 {
		t.Fatal("existing app route failed over to bootstrap")
	}
	if d.active[12] != 0 {
		t.Fatal("bootstrap failure leaked a slot")
	}
}

func TestBootstrapUsesGuardedDNSAndSOCKS(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, e := ln.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(2 * time.Second))
		b := make([]byte, 3)
		if _, e = io.ReadFull(c, b); e != nil {
			return
		}
		c.Write([]byte{5, 0})
		b = make([]byte, 10)
		if _, e = io.ReadFull(c, b); e != nil {
			return
		}
		c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
		io.Copy(c, c)
	}()
	old := dnsQuery
	defer func() { dnsQuery = old }()
	dnsQuery = func(ctx context.Context, proxy string, server DNSEndpoint, host string, kind int) ([]netip.Addr, uint32, error) {
		if proxy != ln.Addr().String() || host != "api.enclave.host" {
			return nil, 0, os.ErrPermission
		}
		if kind == 28 {
			return nil, 60, nil
		}
		return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, 60, nil
	}
	d := Dialer{Resolver: panicResolver{}, RouteFor: func(uint32) (AppRoute, error) { return AppRoute{}, os.ErrNotExist }, BootstrapRouteFor: func(uint32, string, int) (AppRoute, error) {
		return AppRoute{Proxies: []string{ln.Addr().String()}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}, nil
	}}
	c, done, err := d.Dial(context.Background(), 12, "api.enclave.host", 443)
	if err != nil {
		t.Fatal(err)
	}
	defer done()
	defer c.Close()
	c.SetDeadline(time.Now().Add(time.Second))
	c.Write([]byte("test"))
	b := make([]byte, 4)
	if _, err = io.ReadFull(c, b); err != nil || string(b) != "test" {
		t.Fatalf("guarded stream: %v", err)
	}
}
