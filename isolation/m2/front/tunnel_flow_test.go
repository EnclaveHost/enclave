package main

import (
	"bufio"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const testFlow = "00112233445566778899aabbccddeeff"

// an app on a UDP port: what it receives goes to `got` with the sender, and `say` sends to the last sender
type flowApp struct {
	u    *net.UDPConn
	got  chan string
	from chan *net.UDPAddr
}

func newFlowApp(t *testing.T) (*flowApp, int) {
	t.Helper()
	u, e := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { u.Close() })
	a := &flowApp{u: u, got: make(chan string, 4096), from: make(chan *net.UDPAddr, 4096)}
	go func() {
		b := make([]byte, 65535)
		for {
			n, addr, e := u.ReadFromUDP(b)
			if e != nil {
				return
			}
			a.got <- string(b[:n])
			a.from <- addr
		}
	}()
	return a, u.LocalAddr().(*net.UDPAddr).Port
}

type flowClient struct {
	t      *testing.T
	c      net.Conn
	r      *bufio.Reader
	n      uint64   // data frames received
	repair uint32   // the repair time the front last told, in ms
	parity [][]byte // parity frames: first sequence number, count, XOR
}

func flowUpgrade(t *testing.T, s *httptest.Server, proto string, port int, headers string) (*flowClient, *http.Response) {
	t.Helper()
	c, e := tls.Dial("tcp", s.Listener.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { c.Close() })
	c.SetDeadline(time.Now().Add(5 * time.Second))
	fmt.Fprintf(c, "GET %s%s/%d HTTP/1.1\r\nHost: guest\r\nConnection: Upgrade\r\nUpgrade: %s\r\n%s\r\n", tunnelPrefix, proto, port, tunnelProtocol, headers)
	r := bufio.NewReader(c)
	res, e := http.ReadResponse(r, nil)
	if e != nil {
		t.Fatal(e)
	}
	return &flowClient{t: t, c: c, r: r}, res
}
func openLane(t *testing.T, s *httptest.Server, port int) *flowClient {
	t.Helper()
	l, res := flowUpgrade(t, s, "udp", port, flowHeader+": "+testFlow+"\r\n")
	if res.StatusCode != 101 || res.Header.Get(flowHeader) != "1" {
		t.Fatal("flow not accepted", res.StatusCode, res.Header)
	}
	return l
}
func (l *flowClient) send(payload string) {
	b := make([]byte, 2+len(payload))
	binary.BigEndian.PutUint16(b, uint16(len(payload)))
	copy(b[2:], payload)
	l.c.Write(b)
}
func (l *flowClient) report() { l.c.Write(flowReport(l.n)) }

// next data frame: its sequence number and datagram (reports from the front are skipped)
func (l *flowClient) recv() (uint32, string, error) {
	for {
		var h [2]byte
		if _, e := io.ReadFull(l.r, h[:]); e != nil {
			return 0, "", e
		}
		n := int(binary.BigEndian.Uint16(h[:]))
		if n == flowReportSize {
			var c [8]byte
			if _, e := io.ReadFull(l.r, c[:]); e != nil {
				return 0, "", e
			}
			continue
		}
		if n == flowRepairSize {
			var c [4]byte
			if _, e := io.ReadFull(l.r, c[:]); e != nil {
				return 0, "", e
			}
			l.repair = binary.BigEndian.Uint32(c[:])
			continue
		}
		if n == flowParitySize {
			if _, e := io.ReadFull(l.r, h[:]); e != nil {
				return 0, "", e
			}
			b := make([]byte, binary.BigEndian.Uint16(h[:]))
			if _, e := io.ReadFull(l.r, b); e != nil {
				return 0, "", e
			}
			l.parity = append(l.parity, b)
			continue
		}
		b := make([]byte, n)
		if _, e := io.ReadFull(l.r, b); e != nil {
			return 0, "", e
		}
		if n < flowSeqBytes {
			l.t.Fatal("frame without a sequence number")
		}
		l.n++
		return binary.BigEndian.Uint32(b), string(b[flowSeqBytes:]), nil
	}
}
func (l *flowClient) must() (uint32, string) {
	l.t.Helper()
	l.c.SetReadDeadline(time.Now().Add(3 * time.Second))
	seq, p, e := l.recv()
	if e != nil {
		l.t.Fatal(e)
	}
	return seq, p
}
func (l *flowClient) nothing(d time.Duration) {
	l.t.Helper()
	l.c.SetReadDeadline(time.Now().Add(d))
	if seq, p, e := l.recv(); e == nil {
		l.t.Fatalf("unexpected frame %d %q", seq, p)
	}
}
func theFlow(t *testing.T, p *portTunnels) *udpFlow {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, f := range p.flows {
		return f
	}
	t.Fatal("no flow")
	return nil
}
func flowWait(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(2 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatal("never: " + what)
}

func TestFlowCarriesDatagramsInSequence(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	l := openLane(t, s, port)
	l.send("ping")
	if <-app.got != "ping" {
		t.Fatal("datagram to the app changed")
	}
	from := <-app.from
	for i, payload := range []string{"one", strings.Repeat("video", 2000), "", "last"} {
		app.u.WriteToUDP([]byte(payload), from)
		seq, got := l.must()
		if seq != uint32(i) || got != payload {
			t.Fatalf("frame %d: seq %d, %d bytes", i, seq, len(got))
		}
		l.report()
	}
	st := theFlow(t, p).snapshot()
	if st.Sent != 4 || st.Dropped != 0 || st.Hedged != 0 || st.Lanes != 1 {
		t.Fatalf("%+v", st)
	}
	// once the lane has a usual round trip, the front says how long a second copy takes: that, the time to notice a
	// stalled lane, and two ticks. Over loopback the round trip is under a few milliseconds.
	time.Sleep(6 * flowTick)
	app.u.WriteToUDP([]byte("more"), from)
	l.must()
	if want := uint32((flowDefaults.hedge + 2*flowTick) / time.Millisecond); l.repair < want || l.repair > want+20 {
		t.Fatal("repair time", l.repair)
	}
	// the flow ends with its last lane
	l.c.Close()
	flowWait(t, "flow removed", func() bool { p.mu.Lock(); defer p.mu.Unlock(); return len(p.flows) == 0 && p.total == 0 })
}

func TestFlowLanesShareOneAssociation(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	a, b := openLane(t, s, port), openLane(t, s, port)
	a.send("from a")
	b.send("from b")
	first, second := <-app.from, <-app.from
	<-app.got
	<-app.got
	if first.Port != second.Port {
		t.Fatal("two lanes of one flow reached the app from two ports")
	}
	f := theFlow(t, p)
	if st := f.snapshot(); st.Lanes != 2 {
		t.Fatalf("%+v", st)
	}
	// every datagram arrives once, on one lane or the other, numbered in the order the app sent them
	type got struct {
		seq  uint32
		data string
	}
	all := make(chan got, 64)
	for _, l := range []*flowClient{a, b} {
		go func(l *flowClient) {
			for {
				l.c.SetReadDeadline(time.Now().Add(3 * time.Second))
				seq, data, e := l.recv()
				if e != nil {
					return
				}
				l.report()
				all <- got{seq, data}
			}
		}(l)
	}
	for i := 0; i < 20; i++ {
		app.u.WriteToUDP([]byte{byte(i)}, first)
	}
	seen := map[uint32]bool{}
	for i := 0; i < 20; i++ {
		select {
		case g := <-all:
			if seen[g.seq] || g.seq >= 20 || g.data != string([]byte{byte(g.seq)}) {
				t.Fatal("frame", g.seq)
			}
			seen[g.seq] = true
		case <-time.After(3 * time.Second):
			t.Fatal("datagrams missing", len(seen))
		}
	}
	if st := f.snapshot(); st.Sent != 20 || st.Dropped != 0 {
		t.Fatalf("%+v", st)
	}
	// a lane that goes away takes nothing with it: the other carries on, and the flow lives
	a.c.Close()
	flowWait(t, "lane gone", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.lanes) == 1 })
	app.u.WriteToUDP([]byte("after"), first)
	select {
	case g := <-all:
		if g.seq != 20 || g.data != "after" {
			t.Fatal("second lane", g.seq, g.data)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("nothing on the lane that is left")
	}
}

func TestFlowDropsWhatWouldBeLate(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	p.flowTune = flowTuning{spill: 10 * time.Millisecond, hedge: 15 * time.Millisecond, late: 60 * time.Millisecond, startup: 60 * time.Millisecond}
	l := openLane(t, s, port)
	l.send("hello")
	<-app.got
	from := <-app.from
	say := func(x string) { app.u.WriteToUDP([]byte(x), from) }
	say("a")
	l.must()
	l.report()
	f := theFlow(t, p)
	flowWait(t, "report taken", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.lanes[0].acked == 1 })
	// the client stops reporting (its side of the path is stuck): what is sent now stays unreported
	say("b")
	l.must()
	time.Sleep(100 * time.Millisecond)
	for i := 0; i < 50; i++ {
		say("late")
	}
	flowWait(t, "datagrams dropped", func() bool { return f.snapshot().Dropped == 50 })
	l.nothing(30 * time.Millisecond)
	// the path moves again: the report clears the lane, and new datagrams are carried with the next number
	l.report()
	flowWait(t, "report taken", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.lanes[0].acked == 2 })
	say("fresh")
	if seq, got := l.must(); seq != 2 || got != "fresh" {
		t.Fatal(seq, got)
	}
	if st := f.snapshot(); st.Sent != 3 || st.Dropped != 50 {
		t.Fatalf("%+v", st)
	}
}

func TestFlowSendsAgainWhatAStalledLaneCarries(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	p.flowTune = flowTuning{spill: 10 * time.Millisecond, hedge: 20 * time.Millisecond, late: 2 * time.Second, startup: 2 * time.Second}
	a, b := openLane(t, s, port), openLane(t, s, port)
	a.send("hello")
	<-app.got
	from := <-app.from
	say := func(x string) { app.u.WriteToUDP([]byte(x), from) }
	f := theFlow(t, p)
	clear := func(n int) func() bool {
		return func() bool { f.mu.Lock(); defer f.mu.Unlock(); return f.lanes[n].acked == f.lanes[n].sent }
	}
	// each lane carries one datagram and reports it, so each has a usual delay
	say("0")
	a.must()
	a.report()
	flowWait(t, "lane a clear", clear(0))
	say("1")
	say("2")
	if seq, _ := a.must(); seq != 1 {
		t.Fatal("of two empty lanes the first takes the datagram", seq)
	}
	if seq, _ := b.must(); seq != 2 {
		t.Fatal("the lane that carries less takes the next", seq)
	}
	// lane b reports; lane a stalls with frame 1 on it. Within the hedge time lane b gets a copy with the same number
	b.report()
	if seq, got := b.must(); seq != 1 || got != "1" {
		t.Fatal("copy", seq, got)
	}
	b.report()
	flowWait(t, "lane b clear", clear(1))
	// new datagrams keep off the stalled lane
	for i := 3; i < 6; i++ {
		say(fmt.Sprint(i))
		if seq, got := b.must(); seq != uint32(i) || got != fmt.Sprint(i) {
			t.Fatal("new datagram", seq, got)
		}
		b.report()
		flowWait(t, "lane b clear", clear(1))
	}
	a.nothing(60 * time.Millisecond)
	if st := f.snapshot(); st.Hedged != 1 || st.Sent != 6 || st.Dropped != 0 {
		t.Fatalf("%+v", st)
	}
	// the stalled lane reports at last: it is used again, and nothing is sent a third time
	a.report()
	flowWait(t, "lane a clear", clear(0))
	say("6")
	if seq, got := a.must(); seq != 6 || got != "6" {
		t.Fatal(seq, got)
	}
	if st := f.snapshot(); st.Hedged != 1 {
		t.Fatalf("%+v", st)
	}
}

// What a lane holds until it is reported is bounded in bytes, whatever the size of the app's datagrams.
func TestFlowBoundsWhatALaneHolds(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	p.flowTune = flowTuning{spill: time.Second, hedge: time.Hour, late: time.Hour, startup: time.Hour}
	l := openLane(t, s, port)
	l.send("hello")
	<-app.got
	from := <-app.from
	big := make([]byte, 60000)
	go func() {
		for {
			l.c.SetReadDeadline(time.Now().Add(5 * time.Second))
			if _, _, e := l.recv(); e != nil {
				return
			}
		}
	}()
	for i := 0; i < 40; i++ {
		app.u.WriteToUDP(big, from)
		time.Sleep(2 * time.Millisecond)
	}
	f := theFlow(t, p)
	flowWait(t, "all forty handled", func() bool { st := f.snapshot(); return st.Sent+st.Dropped == 40 })
	f.mu.Lock()
	held, sent := f.lanes[0].held, f.lanes[0].sent
	f.mu.Unlock()
	if st := f.snapshot(); st.Dropped == 0 || held > flowLaneBytes+60006 || sent != st.Sent || int(sent)*60006 != held {
		t.Fatalf("%+v held %d sent %d", st, held, sent)
	}
}

// A lane that stays silent with a frame on it is closed, so that the client can open a fresh one.
func TestFlowClosesADeadLane(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	p.flowTune = flowTuning{spill: 10 * time.Millisecond, hedge: 20 * time.Millisecond, late: time.Second, startup: time.Second, dead: 150 * time.Millisecond}
	a, b := openLane(t, s, port), openLane(t, s, port)
	a.send("hello")
	<-app.got
	from := <-app.from
	app.u.WriteToUDP([]byte("0"), from)
	a.must() // never reported
	f := theFlow(t, p)
	// while no lane reports, nothing is closed: a hold of the whole path is not one connection's fault
	time.Sleep(400 * time.Millisecond)
	f.mu.Lock()
	n0 := len(f.lanes)
	f.mu.Unlock()
	if n0 != 2 {
		t.Fatal("a lane was closed while every lane was silent")
	}
	// the other lane carries datagrams and reports them: now the silent one is the odd one out, and what it held
	// comes on the other lane when it is closed
	go func() {
		for i := 0; i < 60; i++ {
			app.u.WriteToUDP([]byte("x"), from)
			time.Sleep(10 * time.Millisecond)
		}
	}()
	copied := make(chan bool, 1)
	go func() {
		for {
			b.c.SetReadDeadline(time.Now().Add(2 * time.Second))
			seq, got, e := b.recv()
			if e != nil {
				return
			}
			if seq == 0 && got == "0" {
				copied <- true
			}
			b.report()
		}
	}()
	flowWait(t, "dead lane closed", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.lanes) == 1 })
	select {
	case <-copied:
	case <-time.After(2 * time.Second):
		t.Fatal("what the closed lane held did not come on the other")
	}
	a.c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, e := a.recv(); e == nil {
		t.Fatal("dead lane still open")
	}
	// an idle lane is never closed for silence
	time.Sleep(400 * time.Millisecond)
	if st := f.snapshot(); st.Renewed != 1 || st.Hedged != 1 {
		t.Fatalf("%+v", st)
	}
	f.mu.Lock()
	n := len(f.lanes)
	f.mu.Unlock()
	if n != 1 {
		t.Fatal("idle lane closed")
	}
}

// Every four data frames are followed by their parity, and the tail of a burst by its own after a few milliseconds.
func TestFlowParityCoversTheDataFrames(t *testing.T) {
	app, port := newFlowApp(t)
	s, _ := testTunnel(t, "udp", port)
	l := openLane(t, s, port)
	l.send("hello")
	<-app.got
	from := <-app.from
	sent := []string{"zero", "the longest of the five datagrams", "", "three", "tail"}
	for _, x := range sent {
		app.u.WriteToUDP([]byte(x), from)
	}
	for i := range sent {
		if seq, got := l.must(); seq != uint32(i) || got != sent[i] {
			t.Fatal(seq, got)
		}
	}
	// one more datagram later: reading it also reads the parity frames that came before it
	time.Sleep(4 * flowTick)
	app.u.WriteToUDP([]byte("later"), from)
	l.must()
	if len(l.parity) != 2 {
		t.Fatal("parity frames", len(l.parity))
	}
	xor := func(list []string) []byte {
		n := 0
		for _, x := range list {
			if len(x) > n {
				n = len(x)
			}
		}
		b := make([]byte, 2+n)
		for _, x := range list {
			b[0] ^= byte(len(x) >> 8)
			b[1] ^= byte(len(x))
			for i := 0; i < len(x); i++ {
				b[2+i] ^= x[i]
			}
		}
		return b
	}
	for i, want := range []struct {
		first uint32
		of    []string
	}{{0, sent[:4]}, {4, sent[4:]}} {
		p := l.parity[i]
		if binary.BigEndian.Uint32(p) != want.first || int(p[4]) != len(want.of) || string(p[5:]) != string(xor(want.of)) {
			t.Fatalf("parity %d: first %d count %d", i, binary.BigEndian.Uint32(p), p[4])
		}
	}
}

func TestFlowRefusals(t *testing.T) {
	app, port := newFlowApp(t)
	s, p := testTunnel(t, "udp", port)
	for _, h := range []string{flowHeader + ": 1\r\n", flowHeader + ": " + strings.ToUpper(testFlow) + "\r\n", flowHeader + ": " + testFlow + "0\r\n",
		flowHeader + ": " + testFlow + "\r\n" + flowHeader + ": " + testFlow + "\r\n"} {
		if _, res := flowUpgrade(t, s, "udp", port, h); res.StatusCode != 400 {
			t.Fatalf("%q: %d", h, res.StatusCode)
		}
	}
	// a tunnel without the header is the old protocol: no sequence numbers, no header in the answer
	old, res := flowUpgrade(t, s, "udp", port, "")
	if res.StatusCode != 101 || res.Header.Get(flowHeader) != "" {
		t.Fatal("plain tunnel", res.StatusCode, res.Header)
	}
	old.send("plain")
	<-app.got
	app.u.WriteToUDP([]byte("back"), <-app.from)
	var h [2]byte
	io.ReadFull(old.r, h[:])
	if b := make([]byte, binary.BigEndian.Uint16(h[:])); len(b) != 4 {
		t.Fatal("plain tunnel framed", len(b))
	}
	old.c.Close()
	// lanes are counted, and one too many is refused
	lanes := []*flowClient{}
	for i := 0; i < flowMaxLanes; i++ {
		lanes = append(lanes, openLane(t, s, port))
	}
	if _, res := flowUpgrade(t, s, "udp", port, flowHeader+": "+testFlow+"\r\n"); res.StatusCode != 503 {
		t.Fatal("ninth lane", res.StatusCode)
	}
	// a report of more than was sent ends that lane and no other
	lanes[0].n = 7
	lanes[0].report()
	f := theFlow(t, p)
	flowWait(t, "lying lane closed", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.lanes) == flowMaxLanes-1 })
	lanes[0].c.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, e := lanes[0].recv(); e == nil {
		t.Fatal("lying lane still open")
	}
	// an oversized frame ends a lane too
	lanes[1].c.Write([]byte{255, 254})
	flowWait(t, "oversized lane closed", func() bool { f.mu.Lock(); defer f.mu.Unlock(); return len(f.lanes) == flowMaxLanes-2 })
	// a flow on a TCP destination is refused
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	tp := l.Addr().(*net.TCPAddr).Port
	st, _ := testTunnel(t, "tcp", tp)
	if _, res := flowUpgrade(t, st, "tcp", tp, flowHeader+": "+testFlow+"\r\n"); res.StatusCode != 400 {
		t.Fatal("flow on tcp", res.StatusCode)
	}
}
