package wg

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/conn"
)

// a DNS query for name (id from the name's length, so tests can tell answers apart)
func dnsQuery(t *testing.T, name string, id uint16) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, RecursionDesired: false})
	b.StartQuestions()
	if err := b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET}); err != nil {
		t.Fatal(err)
	}
	q, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// a loopback TCP-ONLY DNS role (RFC 1035 framing), like route-dns's TCP listener. answer(q) -> nil means: never answer.
// There is no UDP socket on its port: the relay must use TCP.
func tcpRole(t *testing.T, answer func(q []byte) []byte) (string, *atomic.Int64) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	var seen atomic.Int64
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				for {
					var n [2]byte
					if _, err := io.ReadFull(c, n[:]); err != nil {
						return
					}
					q := make([]byte, binary.BigEndian.Uint16(n[:]))
					if _, err := io.ReadFull(c, q); err != nil {
						return
					}
					seen.Add(1)
					a := answer(q)
					if a == nil {
						continue
					}
					out := make([]byte, 2+len(a))
					binary.BigEndian.PutUint16(out, uint16(len(a)))
					copy(out[2:], a)
					c.Write(out)
				}
			}(c)
		}
	}()
	return l.Addr().String(), &seen
}

// an authoritative answer with `records` A records for the question (records large enough makes it > UDPMaxReply)
func aAnswer(q []byte, records int) []byte {
	var p dnsmessage.Parser
	h, err := p.Start(q)
	if err != nil {
		return nil
	}
	qq, err := p.Question()
	if err != nil {
		return nil
	}
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: h.ID, Response: true, Authoritative: true})
	b.StartQuestions()
	b.Question(qq)
	b.StartAnswers()
	for i := 0; i < records; i++ {
		b.AResource(dnsmessage.ResourceHeader{Name: qq.Name, Class: dnsmessage.ClassINET, TTL: 60}, dnsmessage.AResource{A: [4]byte{192, 0, 2, byte(i)}})
	}
	out, _ := b.Finish()
	return out
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

// DNS the exit forwards as packets reaches the loopback role over TCP and its answer returns to the sender as a datagram.
func TestUDPIngressRelaysToTheLoopbackRoleOverTCP(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	role, seen := tcpRole(t, func(q []byte) []byte { return aAnswer(q, 1) })
	var f Forwards
	var in, out atomic.Int64
	f.Count = func(i, o int64) { in.Add(i); out.Add(o) }
	defer f.Close()
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	q := dnsQuery(t, "dir-x.app.example.", 0x1234)
	got, err := exchange(t, prov, "10.77.0.2:53", q, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, aAnswer(q, 1)) {
		t.Fatalf("answer changed in transit: %x", got)
	}
	if seen.Load() != 1 {
		t.Fatal("the role did not see exactly one framed query")
	}
	// a datagram over the bound, or too short to be DNS, is dropped, not relayed
	for _, bad := range [][]byte{bytes.Repeat([]byte{'x'}, UDPMaxDatagram+1), []byte("short")} {
		if _, err := exchange(t, prov, "10.77.0.2:53", bad, 700*time.Millisecond); err == nil {
			t.Fatalf("a %d-byte datagram was relayed", len(bad))
		}
	}
	if seen.Load() != 1 {
		t.Fatal("the role saw a datagram that should have been dropped")
	}
	if in.Load() < int64(len(q)) || out.Load() < int64(len(got)) {
		t.Fatalf("meter in=%d out=%d", in.Load(), out.Load())
	}
}

// An answer longer than one datagram goes back as its header (TC set, no records) and question: the client retries over
// TCP 53 (which the exit forwards too).
func TestUDPIngressTruncatesLongAnswers(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	role, _ := tcpRole(t, func(q []byte) []byte { return aAnswer(q, 120) })
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	q := dnsQuery(t, "boot-x.app.example.", 0x0bad)
	if len(aAnswer(q, 120)) <= UDPMaxReply {
		t.Fatal("fixture answer must exceed UDPMaxReply")
	}
	got, err := exchange(t, prov, "10.77.0.2:53", q, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var p dnsmessage.Parser
	h, err := p.Start(got)
	if err != nil || len(got) > UDPPlainReply || !h.Truncated || !h.Response || h.ID != 0x0bad {
		t.Fatalf("not a truncated answer: %d bytes, %+v, %v", len(got), h, err)
	}
	qq, err := p.Question()
	if err != nil || !strings.EqualFold(qq.Name.String(), "boot-x.app.example.") {
		t.Fatalf("question not echoed: %v %v", qq, err)
	}
	if binary.BigEndian.Uint16(got[6:]) != 0 || binary.BigEndian.Uint16(got[8:]) != 0 || binary.BigEndian.Uint16(got[10:]) != 0 {
		t.Fatal("a truncated answer must carry no records")
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
	role, _ := tcpRole(t, func(q []byte) []byte { return aAnswer(q, 1) })
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	if f.udpListeners() != 1 {
		t.Fatal("listener not tracked")
	}
	f.Close()
	if f.udpListeners() != 0 {
		t.Fatal("close kept a udp listener")
	}
	if _, err := exchange(t, prov, "10.77.0.2:53", dnsQuery(t, "a.example.", 1), 700*time.Millisecond); err == nil {
		t.Fatal("relayed after close")
	}
	if err := f.UDPIngress(host, 53, role); err == nil {
		t.Fatal("a closed Forwards opened a new udp ingress")
	}
}

// a role that answers only names starting with "legit" (a flood it never answers keeps its flows open)
func selective(q []byte) []byte {
	var p dnsmessage.Parser
	if _, err := p.Start(q); err != nil {
		return nil
	}
	qq, err := p.Question()
	if err != nil || !strings.HasPrefix(qq.Name.String(), "legit") {
		return nil
	}
	return aAnswer(q, 1)
}

// A flow is one exchange: it closes once its answer is relayed; an unanswered flow closes after UDPIdle.
func TestUDPIngressFlowEndsWithItsAnswer(t *testing.T) {
	idle := UDPIdle
	UDPIdle = 600 * time.Millisecond
	defer func() { UDPIdle = idle }()
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	role, _ := tcpRole(t, selective)
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if got, err := exchange(t, prov, "10.77.0.2:53", dnsQuery(t, "legit.app.example.", uint16(i)), 3*time.Second); err != nil || binary.BigEndian.Uint16(got) != uint16(i) {
			t.Fatalf("query %d: %x %v", i, got, err)
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
	exchange(t, prov, "10.77.0.2:53", dnsQuery(t, "flood.app.example.", 99), 200*time.Millisecond)
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
	role, _ := tcpRole(t, selective)
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	flood := UDPMaxFlows + 76
	conns := make([]net.Conn, 0, flood)
	defer func() {
		for _, c := range conns {
			c.Close()
		}
	}()
	fq := dnsQuery(t, "flood.app.example.", 7)
	for i := 0; i < flood; i++ {
		c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort("10.77.0.2:53"))
		if err != nil {
			t.Fatal(err)
		}
		conns = append(conns, c)
		c.Write(fq)
	}
	deadline := time.Now().Add(5 * time.Second)
	for f.udpFlows() < UDPMaxFlows && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := f.udpFlows(); n > UDPMaxFlows {
		t.Fatalf("%d flows open over the bound %d", n, UDPMaxFlows)
	}
	time.Sleep(time.Second)
	q := dnsQuery(t, "legit-after-flood.app.example.", 0x4242)
	got, err := exchange(t, prov, "10.77.0.2:53", q, 3*time.Second)
	if err != nil || !bytes.Equal(got, aAnswer(q, 1)) {
		t.Fatalf("a legitimate query after a flood of %d senders was not answered: %x %v (flows %d)", flood, got, err, f.udpFlows())
	}
}

// Final review N1 counterexample (the reviewer's tests/udp_multiquery_review_test.go, on this relay's TCP framing): one
// sender with TWO queries in flight on one source port (a stub's A and AAAA), and a role that answers only after it has
// read both. Both answers must come back.
func TestUDPIngressTwoQueriesInFlightFromOneSender(t *testing.T) {
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		c, err := l.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		var qs [][]byte
		for len(qs) < 2 {
			var n [2]byte
			if _, err := io.ReadFull(c, n[:]); err != nil {
				return
			}
			q := make([]byte, binary.BigEndian.Uint16(n[:]))
			if _, err := io.ReadFull(c, q); err != nil {
				return
			}
			qs = append(qs, q)
		}
		time.Sleep(100 * time.Millisecond)
		for _, q := range qs {
			a := aAnswer(q, 1)
			out := make([]byte, 2+len(a))
			binary.BigEndian.PutUint16(out, uint16(len(a)))
			copy(out[2:], a)
			c.Write(out)
		}
		time.Sleep(time.Second)
	}()
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, l.Addr().String()); err != nil {
		t.Fatal(err)
	}
	c, err := prov.Net.DialUDPAddrPort(netip.AddrPort{}, netip.MustParseAddrPort("10.77.0.2:53"))
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write(dnsQuery(t, "a.app.example.", 0xa))
	c.Write(dnsQuery(t, "aaaa.app.example.", 0xaaaa))
	c.SetDeadline(time.Now().Add(3 * time.Second))
	seen := map[uint16]bool{}
	b := make([]byte, 4096)
	for len(seen) < 2 {
		n, err := c.Read(b)
		if err != nil {
			t.Fatalf("answers received %v, then %v: a second in-flight query from one sender lost its answer", seen, err)
		}
		if n >= 2 {
			seen[binary.BigEndian.Uint16(b)] = true
		}
	}
	if !seen[0xa] || !seen[0xaaaa] {
		t.Fatalf("wrong answers %v", seen)
	}
}

// a query advertising an EDNS UDP payload size (0 = no OPT record)
func ednsQuery(t *testing.T, name string, id uint16, size uint16) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id})
	b.StartQuestions()
	b.Question(dnsmessage.Question{Name: dnsmessage.MustNewName(name), Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET})
	if size > 0 {
		b.StartAdditionals()
		var rh dnsmessage.ResourceHeader
		if err := rh.SetEDNS0(int(size), dnsmessage.RCodeSuccess, false); err != nil {
			t.Fatal(err)
		}
		b.OPTResource(rh, dnsmessage.OPTResource{})
	}
	q, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return q
}

// Reviewer P4: the answer datagram honours the CLIENT's limit - 512 without EDNS (RFC 1035), else its OPT payload size
// clamped to [512, UDPMaxReply]. A longer answer is truncated (TC), and the client retries on TCP.
func TestUDPIngressHonoursTheClientPayloadSize(t *testing.T) {
	if queryLimit(ednsQuery(t, "a.example.", 1, 0), 1232) != 512 || queryLimit(ednsQuery(t, "a.example.", 1, 4096), 1232) != 1232 ||
		queryLimit(ednsQuery(t, "a.example.", 1, 800), 1232) != 800 || queryLimit(ednsQuery(t, "a.example.", 1, 100), 1232) != 512 || queryLimit([]byte("short"), 1232) != 512 {
		t.Fatal("queryLimit")
	}
	prov, host := pair(t, site, "10.77.0.2", loopback, conn.NewDefaultBind(), nil)
	records := 0
	role, _ := tcpRole(t, func(q []byte) []byte { return aAnswer(q, records) })
	var f Forwards
	defer f.Close()
	if err := f.UDPIngress(host, 53, role); err != nil {
		t.Fatal(err)
	}
	ask := func(size uint16, n int) (int, bool) {
		t.Helper()
		records = n
		q := ednsQuery(t, "dir-payload.app.example.", uint16(n), size)
		got, err := exchange(t, prov, "10.77.0.2:53", q, 3*time.Second)
		if err != nil {
			t.Fatalf("size %d, %d records: %v", size, n, err)
		}
		return len(got), got[2]&0x02 != 0
	}
	full := func(n int) int { return len(aAnswer(ednsQuery(t, "dir-payload.app.example.", 1, 0), n)) }
	mid := 0
	for full(mid) <= 700 {
		mid++
	} // an answer between 700 and ~740 bytes: over 512, under 800
	if l, tc := ask(0, mid); !tc || l > 512 {
		t.Fatalf("no EDNS: a %d-byte answer came back as %d bytes (TC %v); must be truncated to <= 512", full(mid), l, tc)
	}
	if l, tc := ask(4096, mid); tc || l != full(mid) {
		t.Fatalf("EDNS 4096: a %d-byte answer must pass whole, got %d (TC %v)", full(mid), l, tc)
	}
	if l, tc := ask(800, mid); tc || l != full(mid) {
		t.Fatalf("EDNS 800: a %d-byte answer must pass whole, got %d (TC %v)", full(mid), l, tc)
	}
	big := mid
	for full(big) <= 1300 {
		big++
	}
	if l, tc := ask(4096, big); !tc || l > UDPMaxReply {
		t.Fatalf("EDNS 4096 is clamped to %d: a %d-byte answer came back %d bytes (TC %v)", UDPMaxReply, full(big), l, tc)
	}
	if l, tc := ask(800, big); !tc || l > 800 {
		t.Fatalf("EDNS 800: a %d-byte answer came back %d bytes (TC %v)", full(big), l, tc)
	}
}
