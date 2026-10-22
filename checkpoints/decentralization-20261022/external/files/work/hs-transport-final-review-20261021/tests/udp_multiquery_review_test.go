package wg

// Reviewer counterexample (NOT RUN: Go needs the 1024 lane, which this review was not given). Drop into a scratch copy of
// network/wg beside udpforward_test.go and run `go test -run TestUDPIngressTwoQueriesInFlightFromOneSender`.
// udpforward.go ends a flow at its FIRST answer. One sender with two queries in flight on the same source port (a stub
// sending A and AAAA back to back, or a forwarder pipelining) gets the first answer only: the second answer reaches a
// closed loopback socket. Expected: both answers are relayed.

import (
	"net"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

func TestUDPIngressTwoQueriesInFlightFromOneSender(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	// a role that reads BOTH queries before answering either (as a resolver working on two questions at once)
	role, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { role.Close() })
	go func() {
		b := make([]byte, 4096)
		var got [][]byte
		var from *net.UDPAddr
		for len(got) < 2 {
			n, f, err := role.ReadFromUDP(b)
			if err != nil {
				return
			}
			got, from = append(got, append([]byte(nil), b[:n]...)), f
		}
		time.Sleep(100 * time.Millisecond)
		for _, q := range got {
			role.WriteToUDP(append([]byte("ans:"), q...), from)
		}
	}()
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role.LocalAddr().String()); err != nil {
		t.Fatal(err)
	}
	c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort("10.77.0.2:53"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte("q-A"))
	c.Write([]byte("q-AAAA"))
	c.SetDeadline(time.Now().Add(3 * time.Second))
	seen := map[string]bool{}
	b := make([]byte, 4096)
	for len(seen) < 2 {
		n, err := c.Read(b)
		if err != nil {
			t.Fatalf("answers received %v, then %v: a second in-flight query from one sender lost its answer", seen, err)
		}
		seen[string(b[:n])] = true
	}
}
