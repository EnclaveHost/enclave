package wg

import (
	"bytes"
	"context"
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// a loopback UDP echo standing in for the host's route-dns role; it reports how many datagrams it saw
func udpEcho(t *testing.T) (*net.UDPConn, chan int) {
	t.Helper()
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	seen := make(chan int, 64)
	go func() {
		b := make([]byte, 65536)
		for {
			n, from, err := c.ReadFromUDP(b)
			if err != nil {
				return
			}
			seen <- n
			c.WriteToUDP(append([]byte("echo:"), b[:n]...), from)
		}
	}()
	return c, seen
}

func exchange(t *testing.T, prov *Device, to string, msg []byte, wait time.Duration) ([]byte, error) {
	t.Helper()
	c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort(to))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(wait))
	if _, err := c.Write(msg); err != nil {
		return nil, err
	}
	b := make([]byte, 65536)
	n, err := c.Read(b)
	if err != nil {
		return nil, err
	}
	return b[:n], nil
}

// DNS the exit forwards as packets reaches the loopback role and its answer returns to the sender, through the tunnel.
func TestUDPIngressRelaysToTheLoopbackRole(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	echo, seen := udpEcho(t)
	var f Forwards
	var in, out atomic.Int64
	f.Count = func(i, o int64) { in.Add(i); out.Add(o) }
	defer f.Close()
	if err := f.UDPIngress(host, 53, echo.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	got, err := exchange(t, prov, "10.77.0.2:53", []byte("query-1"), 5*time.Second)
	if err != nil || !bytes.Equal(got, []byte("echo:query-1")) {
		t.Fatalf("answer %q %v", got, err)
	}
	if <-seen != 7 {
		t.Fatal("the role did not see the query as sent")
	}
	// a datagram over the bound is dropped, not relayed
	big := bytes.Repeat([]byte{'x'}, UDPMaxDatagram+1)
	if _, err := exchange(t, prov, "10.77.0.2:53", big, 700*time.Millisecond); err == nil {
		t.Fatal("an oversize datagram was relayed")
	}
	select {
	case n := <-seen:
		t.Fatalf("the role saw a %d-byte oversize datagram", n)
	default:
	}
	if in.Load() < 7 || out.Load() < 12 {
		t.Fatalf("meter in=%d out=%d", in.Load(), out.Load())
	}
}

// Only loopback targets; a closed Forwards stops relaying.
func TestUDPIngressRefusesNonLoopbackAndCloses(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	var f Forwards
	for _, to := range []string{"10.77.0.1:53", "44.0.0.1:53", "nonsense"} {
		if err := f.UDPIngress(host, 53, to); err == nil {
			t.Fatalf("udp ingress accepted target %s", to)
		}
	}
	echo, _ := udpEcho(t)
	if err := f.UDPIngress(host, 53, echo.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	if f.udpListeners() != 1 {
		t.Fatal("listener not tracked")
	}
	f.Close()
	if f.udpListeners() != 0 {
		t.Fatal("close kept a udp listener")
	}
	if _, err := exchange(t, prov, "10.77.0.2:53", []byte("after-close"), 700*time.Millisecond); err == nil {
		t.Fatal("relayed after close")
	}
	if err := f.UDPIngress(host, 53, echo.LocalAddr().String()); err == nil {
		t.Fatal("a closed Forwards opened a new udp ingress")
	}
}

// At most UDPMaxFlows senders at once; an idle flow is closed and its slot reused.
func TestUDPIngressBoundsFlows(t *testing.T) {
	maxFlows, idle := UDPMaxFlows, UDPIdle
	UDPMaxFlows, UDPIdle = 2, 600*time.Millisecond
	defer func() { UDPMaxFlows, UDPIdle = maxFlows, idle }()
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	echo, _ := udpEcho(t)
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, echo.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	open := func() net.Conn {
		t.Helper()
		c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort("10.77.0.2:53"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { c.Close() })
		return c
	}
	ask := func(c net.Conn, wait time.Duration) bool {
		c.SetDeadline(time.Now().Add(wait))
		if _, err := c.Write([]byte("q")); err != nil {
			return false
		}
		b := make([]byte, 64)
		_, err := c.Read(b)
		return err == nil
	}
	a, b, c := open(), open(), open()
	if !ask(a, 3*time.Second) || !ask(b, 3*time.Second) {
		t.Fatal("two flows within the bound were not relayed")
	}
	if ask(c, 300*time.Millisecond) {
		t.Fatal("a third sender was relayed over a bound of two")
	}
	// both flows go idle and are reaped; the third sender then gets a slot
	for ctx.Err() == nil {
		time.Sleep(200 * time.Millisecond)
		if ask(c, 300*time.Millisecond) {
			return
		}
	}
	t.Fatal("an idle flow's slot was never reused")
}
