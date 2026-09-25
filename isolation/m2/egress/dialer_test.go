package egress

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
)

type fakeResolver map[string][]string

func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	ips, ok := f[host]
	if !ok {
		return nil, errors.New("no such host")
	}
	var out []netip.Addr
	for _, s := range ips {
		out = append(out, netip.MustParseAddr(s))
	}
	return out, nil
}

type fakeConn struct {
	net.Conn
	remote net.Addr
}

func (c fakeConn) RemoteAddr() net.Addr { return c.remote }

// a dialer whose "network" connects to exactly the address asked, unless `lands` redirects it (a rebinding the
// socket-level check must catch)
func testDialer(res fakeResolver, lands map[string]string) (*Dialer, *[]string) {
	var dialed []string
	d := &Dialer{Resolver: res, Own: func() []netip.Addr { return []netip.Addr{netip.MustParseAddr("203.0.113.9")} }}
	d.dial = func(_ context.Context, addr string) (net.Conn, error) {
		dialed = append(dialed, addr)
		to := addr
		if l, ok := lands[addr]; ok {
			to = l
		}
		a, p := net.Pipe()
		go p.Close()
		return fakeConn{a, net.TCPAddrFromAddrPort(netip.MustParseAddrPort(to))}, nil
	}
	return d, &dialed
}

func TestDialsAPublicNameByItsJudgedAddress(t *testing.T) {
	d, dialed := testDialer(fakeResolver{"images.example": {"93.184.216.34"}}, nil)
	c, release, err := d.Dial(context.Background(), 7, "images.example", 443)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
	release()
	if len(*dialed) != 1 || (*dialed)[0] != "93.184.216.34:443" {
		t.Fatalf("dialed %v: the judged ADDRESS must be dialed, never the name again", *dialed)
	}
}

// enclave-99's host-dialer negatives: the refusal is made on the FINAL address, whatever the name.
func TestRefusesNonPublicDestinations(t *testing.T) {
	res := fakeResolver{
		"cname-to-private.example": {"10.0.0.5"}, // a CNAME chain's final answer is what the resolver returns
		"metadata.example":         {"169.254.169.254"},
		"loop.example":             {"127.0.0.1"},
		"mapped.example":           {"::ffff:127.0.0.1"},
		"zero.example":             {"0.0.0.0"},
		"unspec6.example":          {"::"},
		"cgnat.example":            {"100.64.1.1"},
		"ula.example":              {"fd00::1"},
		"linklocal6.example":       {"fe80::1"},
		"nat64.example":            {"64:ff9b::7f00:1"},
		"own.example":              {"203.0.113.9"},
		"mixed.example":            {"93.184.216.34", "192.168.1.1"}, // a rebinding setup mixes public and private
		"teredo.example":           {"2001:0:4136:e378:8000:63bf:3fff:fdd2"},
		"nat64local.example":       {"64:ff9b:1::7f00:1"},
		"doc6.example":             {"2001:db8::1"},
		"testnet.example":          {"198.51.100.7"},
	}
	d, dialed := testDialer(res, nil)
	for host := range res {
		if _, _, err := d.Dial(context.Background(), 1, host, 443); !errors.Is(err, ErrRefused) {
			t.Fatalf("%s: %v", host, err)
		}
	}
	if len(*dialed) != 0 {
		t.Fatalf("a refused destination was dialed: %v", *dialed)
	}
}

func TestRefusesByNameShape(t *testing.T) {
	d, _ := testDialer(fakeResolver{"images.example": {"93.184.216.34"}}, nil)
	for _, c := range []struct {
		host string
		port int
	}{{"images.example", 80}, {"images.example", 8443}, {"93.184.216.34", 443}, {"localhost", 443}, {"[::1]", 443}, {"unknown.example", 443}} {
		if _, _, err := d.Dial(context.Background(), 1, c.host, c.port); err == nil {
			t.Fatalf("%s:%d dialed", c.host, c.port)
		}
	}
}

func TestTheSocketsActualPeerIsJudgedToo(t *testing.T) {
	d, _ := testDialer(fakeResolver{"images.example": {"93.184.216.34"}}, map[string]string{"93.184.216.34:443": "127.0.0.1:443"})
	if _, _, err := d.Dial(context.Background(), 1, "images.example", 443); !errors.Is(err, ErrRefused) {
		t.Fatalf("a connection that landed on loopback was accepted: %v", err)
	}
}

func TestPerGuestCaps(t *testing.T) {
	d, _ := testDialer(fakeResolver{"images.example": {"93.184.216.34"}}, nil)
	d.MaxConcurrent = 2
	var releases []func()
	for i := 0; i < 2; i++ {
		_, r, err := d.Dial(context.Background(), 5, "images.example", 443)
		if err != nil {
			t.Fatal(err)
		}
		releases = append(releases, r)
	}
	if _, _, err := d.Dial(context.Background(), 5, "images.example", 443); err == nil || !strings.Contains(err.Error(), "connection limit") {
		t.Fatalf("a third concurrent connection for guest 5: %v", err)
	}
	if _, r, err := d.Dial(context.Background(), 6, "images.example", 443); err != nil {
		t.Fatalf("another guest was limited by guest 5: %v", err)
	} else {
		r()
	}
	releases[0]()
	releases[0]() // a double release frees ONE slot, not two
	// one slot is free again: take it and HOLD it, so the guest is back at its limit (releases[1] + this one)
	if _, _, err := d.Dial(context.Background(), 5, "images.example", 443); err != nil {
		t.Fatalf("after a release: %v", err)
	}
	if _, _, err := d.Dial(context.Background(), 5, "images.example", 443); err == nil {
		t.Fatal("a double release freed two slots")
	}

	d2, _ := testDialer(fakeResolver{"images.example": {"93.184.216.34"}}, nil)
	d2.MaxPerMinute = 3
	for i := 0; i < 3; i++ {
		_, r, err := d2.Dial(context.Background(), 9, "images.example", 443)
		if err != nil {
			t.Fatal(err)
		}
		r()
	}
	if _, _, err := d2.Dial(context.Background(), 9, "images.example", 443); err == nil || !strings.Contains(err.Error(), "rate") {
		t.Fatalf("a fourth dial within the minute: %v", err)
	}
}

func TestARefusedDialFreesItsSlot(t *testing.T) {
	d, _ := testDialer(fakeResolver{"loop.example": {"127.0.0.1"}, "images.example": {"93.184.216.34"}}, nil)
	d.MaxConcurrent = 1
	for i := 0; i < 3; i++ {
		d.Dial(context.Background(), 3, "loop.example", 443) // refused: must not hold the guest's only slot
	}
	if _, r, err := d.Dial(context.Background(), 3, "images.example", 443); err != nil {
		t.Fatalf("refused dials leaked the slot: %v", err)
	} else {
		r()
	}
}
