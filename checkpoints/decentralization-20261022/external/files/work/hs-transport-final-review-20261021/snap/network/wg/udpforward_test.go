package wg

import (
	"bytes"
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

// a loopback "route-dns" that answers only queries starting with "legit" (a flood it never answers keeps its flows open)
func udpSelective(t *testing.T) *net.UDPConn {
	t.Helper()
	c, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	go func() {
		b := make([]byte, 65536)
		for {
			n, from, err := c.ReadFromUDP(b)
			if err != nil {
				return
			}
			if bytes.HasPrefix(b[:n], []byte("legit")) {
				c.WriteToUDP(append([]byte("answer:"), b[:n]...), from)
			}
		}
	}()
	return c
}

// A flow is one exchange: it closes once its answer is relayed; an unanswered flow closes after UDPIdle.
func TestUDPIngressFlowEndsWithItsAnswer(t *testing.T) {
	idle := UDPIdle
	UDPIdle = 600 * time.Millisecond
	defer func() { UDPIdle = idle }()
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	role := udpSelective(t)
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if got, err := exchange(t, prov, "10.77.0.2:53", []byte("legit-"+string(rune('a'+i))), 3*time.Second); err != nil || !bytes.HasPrefix(got, []byte("answer:legit")) {
			t.Fatalf("query %d: %q %v", i, got, err)
		}
	}
	// well inside UDPIdle: answered flows close on their answer, not by idle expiry
	deadline := time.Now().Add(300 * time.Millisecond)
	for f.udpFlows() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := f.udpFlows(); n != 0 {
		t.Fatalf("%d answered flows still open", n)
	}
	exchange(t, prov, "10.77.0.2:53", []byte("flood"), 200*time.Millisecond)
	if f.udpFlows() != 1 {
		t.Fatal("an unanswered query should hold its flow for a while")
	}
	time.Sleep(UDPIdle + 700*time.Millisecond)
	if n := f.udpFlows(); n != 0 {
		t.Fatalf("an unanswered flow outlived UDPIdle (%d open)", n)
	}
}

// Review B4 counterexample, at the REAL bound: more distinct source ports than UDPMaxFlows, each one unanswered query
// (the exit masquerades, so every resolver query is a new sender); a legitimate query a second later is still answered.
func TestUDPIngressFloodOfSendersCannotLockOutAQuery(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	role := udpSelective(t)
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	flood := UDPMaxFlows + 76
	conns := make([]net.Conn, 0, flood)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	for i := 0; i < flood; i++ {
		c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort("10.77.0.2:53"))
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		c.Write([]byte("flood"))
	}
	deadline := time.Now().Add(5 * time.Second)
	for f.udpFlows() < UDPMaxFlows && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := f.udpFlows(); n > UDPMaxFlows {
		t.Fatalf("%d flows open over the bound %d", n, UDPMaxFlows)
	}
	time.Sleep(time.Second)
	got, err := exchange(t, prov, "10.77.0.2:53", []byte("legit-after-flood"), 3*time.Second)
	if err != nil || !bytes.HasPrefix(got, []byte("answer:legit-after-flood")) {
		t.Fatalf("a legitimate query after a flood of %d senders was not answered: %q %v (flows %d)", flood, got, err, f.udpFlows())
	}
}
