package wg

import (
	"bufio"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/conn"
)

func keypair(t *testing.T) (Key, Key) {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var priv, pub Key
	copy(priv[:], k.Bytes())
	copy(pub[:], k.PublicKey().Bytes())
	return priv, pub
}

func freeUDP(t *testing.T) uint16 {
	t.Helper()
	c, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	return uint16(c.LocalAddr().(*net.UDPAddr).Port)
}

// pair starts a listening "provider" device and a "host" device that connects to it over bind.
func pair(t *testing.T, providerAddr, hostAddr string, endpoint func(port uint16) netip.AddrPort, bind conn.Bind, dns []netip.Addr) (*Device, *Device) {
	t.Helper()
	ppriv, ppub := keypair(t)
	hpriv, hpub := keypair(t)
	port := freeUDP(t)
	prov, err := Up(Peer{PrivateKey: ppriv, PublicKey: hpub, Addresses: []netip.Addr{netip.MustParseAddr(providerAddr)}, ListenPort: port}, conn.NewDefaultBind(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(prov.Close)
	host, err := Up(Peer{PrivateKey: hpriv, PublicKey: ppub, Endpoint: endpoint(port), Addresses: []netip.Addr{netip.MustParseAddr(hostAddr)}, DNS: dns, Keepalive: 1}, bind, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(host.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := host.WaitHandshake(ctx); err != nil {
		t.Fatal(err)
	}
	return prov, host
}

func loopback(port uint16) netip.AddrPort { return netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port) }

// a public-looking address inside the provider's netstack stands in for "the internet"
const site = "44.0.0.1"

func serveHTTP(t *testing.T, d *Device, addr string, body string) {
	t.Helper()
	l, err := d.Net.ListenTCPAddrPort(netip.AddrPortFrom(netip.MustParseAddr(addr), 80))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, body) }))
}

func serveDNS(t *testing.T, d *Device, addr, name, answer string) {
	t.Helper()
	c, err := d.Net.ListenUDPAddrPort(netip.AddrPortFrom(netip.MustParseAddr(addr), 53))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	go func() {
		buf := make([]byte, 1500)
		for {
			n, from, err := c.ReadFrom(buf)
			if err != nil {
				return
			}
			var p dnsmessage.Parser
			h, err := p.Start(buf[:n])
			if err != nil {
				continue
			}
			q, err := p.Question()
			if err != nil {
				continue
			}
			b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true})
			b.EnableCompression()
			b.StartQuestions()
			b.Question(q)
			b.StartAnswers()
			if q.Type == dnsmessage.TypeA && strings.EqualFold(q.Name.String(), name+".") {
				b.AResource(dnsmessage.ResourceHeader{Name: q.Name, Class: dnsmessage.ClassINET, TTL: 60}, dnsmessage.AResource{A: netip.MustParseAddr(answer).As4()})
			}
			out, _ := b.Finish()
			c.WriteTo(out, from)
		}
	}()
}

// socksConnect speaks SOCKS5 with username/password; returns the reply code (0 = connected).
func socksConnect(t *testing.T, proxy, user, pass, host string, port int) (net.Conn, byte) {
	t.Helper()
	c, err := net.Dial("tcp", proxy)
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(20 * time.Second))
	c.Write([]byte{5, 1, 2})
	var m [2]byte
	if _, err := io.ReadFull(c, m[:]); err != nil || m[1] != 2 {
		t.Fatalf("method %v %v", m, err)
	}
	c.Write(append(append(append([]byte{1, byte(len(user))}, user...), byte(len(pass))), pass...))
	var a [2]byte
	if _, err := io.ReadFull(c, a[:]); err != nil {
		return nil, 0xff
	}
	if a[1] != 0 {
		c.Close()
		return nil, 0xfe
	}
	req := []byte{5, 1, 0}
	if ip, err := netip.ParseAddr(host); err == nil && ip.Is4() {
		b := ip.As4()
		req = append(append(req, 1), b[:]...)
	} else if err == nil {
		b := ip.As16()
		req = append(append(req, 4), b[:]...)
	} else {
		req = append(append(req, 3, byte(len(host))), host...)
	}
	req = binary.BigEndian.AppendUint16(req, uint16(port))
	c.Write(req)
	var r [10]byte
	if _, err := io.ReadFull(c, r[:]); err != nil {
		t.Fatal(err)
	}
	if r[1] != 0 {
		c.Close()
		return nil, r[1]
	}
	c.SetDeadline(time.Time{})
	return c, 0
}

func startSocks(t *testing.T, s *Socks) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close(); s.CloseAll() })
	go s.Serve(l)
	return l.Addr().String()
}

func get(t *testing.T, c net.Conn, host string) string {
	t.Helper()
	fmt.Fprintf(c, "GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", host)
	r, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	return string(b)
}

const user, pass = "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"

func TestEgressThroughTunnelAndPolicy(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), []netip.Addr{netip.MustParseAddr(site)})
	serveHTTP(t, prov, site, "from the exit")
	serveDNS(t, prov, site, "app.example", site)
	var up, down int64
	s := &Socks{User: user, Pass: pass, Tunnel: host, Policy: Policy{NoIPv6: true, Own: []netip.Addr{netip.MustParseAddr("44.0.0.9")}},
		Count: func(u, d int64) { up += u; down += d }}
	proxy := startSocks(t, s)

	c, code := socksConnect(t, proxy, user, pass, site, 80)
	if code != 0 {
		t.Fatalf("connect: reply %d", code)
	}
	if got := get(t, c, site); got != "from the exit" {
		t.Fatalf("body %q", got)
	}
	c.Close()

	// a name resolves through the tunnel's resolver (the host cannot resolve app.example at all)
	c, code = socksConnect(t, proxy, user, pass, "app.example", 80)
	if code != 0 {
		t.Fatalf("connect by name: reply %d", code)
	}
	if got := get(t, c, "app.example"); got != "from the exit" {
		t.Fatalf("body %q", got)
	}
	c.Close()
	if up == 0 || down == 0 {
		t.Fatalf("meter saw up %d down %d", up, down)
	}

	// refused, never dialed: private, metadata, CGNAT, loopback, own address, SMTP, IPv6 without an IPv6 route
	for _, d := range []struct {
		host string
		port int
	}{{"10.0.0.1", 443}, {"169.254.169.254", 80}, {"100.64.0.1", 443}, {"127.0.0.1", 80}, {"44.0.0.9", 443}, {site, 25}, {"2606:4700::1111", 443}, {"fd00::1", 443}} {
		if _, code := socksConnect(t, proxy, user, pass, d.host, d.port); code != repNotAllowed {
			t.Fatalf("%s:%d: reply %d, want %d (not allowed)", d.host, d.port, code, repNotAllowed)
		}
	}
	// wrong credentials are refused
	if _, code := socksConnect(t, proxy, user, "wrong-password-wrong-password!!", site, 80); code != 0xfe {
		t.Fatalf("bad credentials: %d", code)
	}
}

func TestIngressReachesTheLocalWorker(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	worker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer worker.Close()
	go func() {
		for {
			c, err := worker.Accept()
			if err != nil {
				return
			}
			go func() { io.Copy(c, c); c.Close() }() // echo, like ciphertext passing through
		}
	}()
	var f Forwards
	var in int64
	f.Count = func(i, o int64) { in += i }
	defer f.Close()
	if err := f.Ingress(host, 443, worker.Addr().String()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := prov.DialTCP(ctx, netip.MustParseAddrPort("10.77.0.2:443"))
	if err != nil {
		t.Fatal(err)
	}
	msg := make([]byte, 1<<20)
	rand.Read(msg)
	go c.Write(msg)
	back := make([]byte, len(msg))
	if _, err := io.ReadFull(c, back); err != nil {
		t.Fatal(err)
	}
	if string(back) != string(msg) {
		t.Fatal("payload changed in transit")
	}
	c.Close()
	if in < int64(len(msg)) {
		t.Fatalf("ingress meter saw %d", in)
	}
}

// The guard hop: the inner tunnel to the exit runs inside the outer tunnel to the guard. A UDP relay in the guard's
// netstack stands in for the guard provider's forwarding; the exit sees only the relay as its peer's address.
func TestInnerTunnelThroughGuard(t *testing.T) {
	guard, outer := pair(t, "44.0.0.50", "10.78.0.2", loopback, conn.NewDefaultBind(), nil)
	// the exit listens on a real UDP port; the guard relays its tunnel address :51820 to it
	epriv, epub := keypair(t)
	hpriv, hpub := keypair(t)
	exitPort := freeUDP(t)
	exit, err := Up(Peer{PrivateKey: epriv, PublicKey: hpub, Addresses: []netip.Addr{netip.MustParseAddr(site)}, ListenPort: exitPort}, conn.NewDefaultBind(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer exit.Close()
	serveHTTP(t, exit, site, "through the guard")
	relayIn, err := guard.Net.ListenUDPAddrPort(netip.MustParseAddrPort("44.0.0.50:51820"))
	if err != nil {
		t.Fatal(err)
	}
	defer relayIn.Close()
	relayOut, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer relayOut.Close()
	var hostSide net.Addr
	exitAddr := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: int(exitPort)}
	go func() {
		b := make([]byte, 2000)
		for {
			n, from, err := relayIn.ReadFrom(b)
			if err != nil {
				return
			}
			hostSide = from
			relayOut.WriteTo(b[:n], exitAddr)
		}
	}()
	go func() {
		b := make([]byte, 2000)
		for {
			n, _, err := relayOut.ReadFrom(b)
			if err != nil {
				return
			}
			if hostSide != nil {
				relayIn.WriteTo(b[:n], hostSide)
			}
		}
	}()
	local, _ := outer.Local(false)
	bind := &NetstackBind{Net: outer.Net, Local: local, Peer: netip.MustParseAddrPort("44.0.0.50:51820")}
	inner, err := Up(Peer{PrivateKey: hpriv, PublicKey: epub, Endpoint: netip.MustParseAddrPort("44.0.0.50:51820"), Addresses: []netip.Addr{netip.MustParseAddr("10.77.0.2")}, MTU: 1340, Keepalive: 1}, bind, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer inner.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := inner.WaitHandshake(ctx); err != nil {
		t.Fatal(err)
	}
	proxy := startSocks(t, &Socks{User: user, Pass: pass, Tunnel: inner, Policy: Policy{NoIPv6: true}})
	c, code := socksConnect(t, proxy, user, pass, site, 80)
	if code != 0 {
		t.Fatalf("reply %d", code)
	}
	if got := get(t, c, site); got != "through the guard" {
		t.Fatalf("body %q", got)
	}
	// the exit's view of its peer is the relay's socket, never the host's
	cfg, _ := exit.dev.IpcGet()
	if !strings.Contains(cfg, "endpoint=127.0.0.1:"+fmt.Sprint(relayOut.LocalAddr().(*net.UDPAddr).Port)) {
		t.Fatalf("exit sees %q", cfg)
	}
}

func TestDialRefusedWhenTunnelPeerIsGone(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	serveHTTP(t, prov, site, "x")
	prov.Close() // the exit disappears: nothing may fall back to the host's own network
	proxy := startSocks(t, &Socks{User: user, Pass: pass, Tunnel: host, Policy: Policy{NoIPv6: true}})
	start := time.Now()
	if _, code := socksConnect(t, proxy, user, pass, site, 80); code == 0 {
		t.Fatal("connected with the exit gone")
	}
	if time.Since(start) > 19*time.Second {
		t.Fatal("refusal took too long")
	}
}

func TestPeerValidation(t *testing.T) {
	priv, pub := keypair(t)
	ok := Peer{PrivateKey: priv, PublicKey: pub, Endpoint: netip.MustParseAddrPort("44.0.0.1:51820"), Addresses: []netip.Addr{netip.MustParseAddr("10.77.0.2")}}
	if err := ok.Validate(); err != nil {
		t.Fatal(err)
	}
	for name, p := range map[string]Peer{
		"no key":       {PublicKey: pub, Endpoint: ok.Endpoint, Addresses: ok.Addresses},
		"no endpoint":  {PrivateKey: priv, PublicKey: pub, Addresses: ok.Addresses},
		"two v4":       {PrivateKey: priv, PublicKey: pub, Endpoint: ok.Endpoint, Addresses: []netip.Addr{netip.MustParseAddr("10.0.0.1"), netip.MustParseAddr("10.0.0.2")}},
		"mtu":          {PrivateKey: priv, PublicKey: pub, Endpoint: ok.Endpoint, Addresses: ok.Addresses, MTU: 9000},
		"no addresses": {PrivateKey: priv, PublicKey: pub, Endpoint: ok.Endpoint},
	} {
		if p.Validate() == nil {
			t.Fatalf("%s accepted", name)
		}
	}
}
