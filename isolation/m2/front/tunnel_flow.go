package main

// A UDP tunnel carries datagrams inside TLS over TCP, and TCP never drops: when the path loses packets or carries
// less than the app sends, live traffic (a GameStream video) queues in every buffer between here and the client and
// arrives later and later. A flow is a UDP tunnel whose client reports what it has received, so this end knows how
// far behind each connection is and can keep the datagrams current instead of complete:
//
//   - A client asks for a flow with the request header Enclave-Port-Flow: <32 hex>, and the 101 answers
//     Enclave-Port-Flow: 1. Without the header (or the answer) the tunnel is exactly enclave-port/1.
//   - Connections that name the same flow, protocol and port are lanes of ONE association: one UDP socket to the
//     app, up to flowMaxLanes connections to the client.
//   - To the client each frame is a four-byte big-endian flow sequence number, then the datagram. Sequence numbers
//     are given only to datagrams that are sent, so a gap at the client is a datagram still on its way on a lane.
//   - A frame of size 0xFFFF is a report: eight bytes follow, the big-endian count of data frames the sender of the
//     report has received on that connection. Each end reports as it receives, and at least every 30 s, which keeps
//     a quiet lane open. With this end's reports a client can keep its own datagrams off a lane that is behind.
//   - A frame of size 0xFFFE, to the client only, is the repair time: four bytes follow, big-endian milliseconds
//     within which a frame that a stalled lane holds can be expected on another lane (the time to notice plus the
//     slowest lane's usual round trip). A client that waits for a missing datagram should wait about that long:
//     less passes over datagrams that are on their way, more holds the others back for nothing.
//
// With the reports this end knows, per lane, how long the oldest unreported frame has been on its way beyond the
// lane's usual delay. A new datagram goes to the lane that is least behind; when every lane is further behind than
// flowTuning.late it is dropped: late video is worth nothing, and the client's own error correction and key-frame
// requests are made for loss. When a lane falls behind and its reports stop (a lost segment holds everything after
// it back) the frames it still carries are sent again on a lane that is not behind, so one stalled connection costs
// the detection time and not TCP's recovery. Second copies are at most a quarter of what is sent. The client delivers
// in sequence and drops the second copy.
//
// Waiting for a second copy costs the time to notice and the path once more, and everything after the missing
// datagram waits with it. So the datagrams are also covered by parity: after every flowTuning.parity data frames (or a
// few milliseconds, for the tail of a burst) one parity frame goes out on a lane that carried none of them, the XOR of
// those frames, each as its two-byte length and its bytes. A client that has all but one of them has that one, at
// once. The frame is size 0xFFFD, then a two-byte length, then the first sequence number (four bytes), the count
// (one byte) and the XOR.
//
// A lane that stays silent with frames on it for flowTuning.dead is closed (its TCP is backing off, and a new
// connection starts without that history); a client that wants its number of lanes opens another.
//
// Nothing here knows the app's protocol. The client's datagrams to the app are not sequenced or dropped.

import (
	"bufio"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"time"
)

const (
	flowHeader     = "Enclave-Port-Flow"
	flowReportSize = 0xFFFF
	flowRepairSize = 0xFFFE
	flowParitySize = 0xFFFD
	flowParityWait = 4 * time.Millisecond // a group that is not full is covered after this long
	flowParityMax  = 32                   // data frames one parity frame may cover
	flowHedgeShare = 4                    // at most one frame in this many is sent a second time...
	flowHedgeBurst = 64                   // ...beyond this many at once
	flowMaxLanes   = 16
	flowRing       = 1024      // frames a lane may have unreported; beyond that it takes nothing new
	flowLaneBytes  = 512 << 10 // and bytes: what a lane holds until it is reported is this end's memory
	flowQueue      = 256       // frames waiting for a lane's writer
	flowSeqBytes   = 4
	flowKeepalive  = 20 * time.Second
	flowTick       = 5 * time.Millisecond
)

// spill: a lane within this of its usual delay is not behind. hedge: behind by this much and silent for as long, what
// it carries is sent again elsewhere. late: behind by this much it takes nothing, and a datagram that old is not sent
// again. startup: the same bound before a lane's first report, when its usual delay is not known yet. dead: silent
// this long with frames on it, a lane is closed. parity: data frames per parity frame (0: none).
type flowTuning struct {
	spill, hedge, late, startup, dead time.Duration
	parity                            int
}

// (Measured with the real front and gateway over a simulated path, 12.5 ms each way: with 1-3% loss a 5 Mbit/s video
// on sixteen lanes arrives with a median delay of 13 ms, 99 in 100 datagrams within 55 ms and nothing dropped, where
// one plain tunnel is 7 s behind after 30 s; ops/stream-flow-20261115/.)
var flowDefaults = flowTuning{spill: 10 * time.Millisecond, hedge: 12 * time.Millisecond, late: 100 * time.Millisecond, startup: 2 * time.Second, dead: time.Second, parity: 4}

type flowSlot struct {
	at, born int64 // sent on this lane; first sent on any lane (UnixNano)
	frame    []byte
	hedged   bool // already sent again on another lane, or itself a second copy
}

type flowLane struct {
	c         net.Conn
	out       chan []byte
	sent      uint64 // data frames given to this lane
	held      int    // bytes of the frames not yet reported
	acked     uint64 // of them, reported received
	hedgeNext uint64 // frames below this have been considered for a second copy
	ring      [flowRing]flowSlot
	progress  int64  // when a report last moved, or the lane last went from empty to carrying
	base      int64  // the lane's usual delay: the least time from sending a frame to its report (0: none yet)
	received  uint64 // data frames from the client on this lane
	reported  uint64 // of them, told to the client
	lastWrite int64
	closed    bool
	dying     bool // closed for silence; its reader has not ended it yet
}

type flowStats struct{ Sent, Dropped, Hedged, Lanes, Renewed, Parity uint64 }

type udpFlow struct {
	mu      sync.Mutex
	u       *net.UDPConn
	tune    flowTuning
	lanes   []*flowLane
	pending int
	seq     uint32
	repair  uint32 // the repair time last told to the client, in ms
	credit  int    // second copies that may be sent now, in 1/flowHedgeShare of a frame
	group   struct {
		first uint32
		count int
		at    int64
		xor   []byte
		used  []*flowLane
	}
	stats   flowStats
	closed  bool
	done    chan struct{}
	onClose func()
}

func validFlowID(s string) bool {
	if len(s) != 32 {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}

// flowFor returns the flow a lane is about to join, opening the association for the first one. The caller owes
// either serveLane or abandon.
func (t *portTunnels) flowFor(key, port, id string) (*udpFlow, error) {
	name := key + "/" + id
	t.mu.Lock()
	defer t.mu.Unlock()
	if f := t.flows[name]; f != nil {
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.closed || len(f.lanes)+f.pending >= flowMaxLanes {
			return nil, errFlowFull
		}
		f.pending++
		return f, nil
	}
	c, err := net.DialTimeout("udp", net.JoinHostPort("127.0.0.1", port), 5*time.Second)
	if err != nil {
		return nil, err
	}
	tune := t.flowTune
	if tune == (flowTuning{}) {
		tune = flowDefaults
	}
	f := &udpFlow{u: c.(*net.UDPConn), tune: tune, pending: 1, done: make(chan struct{}), credit: flowHedgeShare * flowHedgeBurst}
	f.onClose = func() {
		t.mu.Lock()
		if t.flows[name] == f {
			delete(t.flows, name)
		}
		t.mu.Unlock()
	}
	if t.flows == nil {
		t.flows = map[string]*udpFlow{}
	}
	t.flows[name] = f
	go f.fromApp()
	go f.tick()
	return f, nil
}

type flowError string

func (e flowError) Error() string { return string(e) }

const errFlowFull = flowError("flow has no room for another lane")

func (f *udpFlow) abandon() {
	f.mu.Lock()
	f.pending--
	empty := f.pending == 0 && len(f.lanes) == 0
	f.mu.Unlock()
	if empty {
		f.close()
	}
}

func (f *udpFlow) close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	lanes := f.lanes
	f.lanes = nil
	for _, l := range lanes {
		if !l.closed {
			l.closed = true
			close(l.out)
		}
	}
	f.mu.Unlock()
	close(f.done)
	f.u.Close()
	for _, l := range lanes {
		l.c.Close()
	}
	f.onClose()
}

// behind is how much longer than the lane's usual delay its oldest unreported frame has been on its way. ok is false
// when the lane can take nothing: it is closed, its writer is full, or too much is unreported.
func (l *flowLane) behind(now int64, t flowTuning) (time.Duration, bool) {
	if l.closed || l.dying || len(l.out) == cap(l.out) {
		return 0, false
	}
	un := l.sent - l.acked
	if un == 0 {
		return 0, true
	}
	if un >= flowRing || l.held >= flowLaneBytes {
		return 0, false
	}
	age := time.Duration(now - l.ring[l.acked%flowRing].at)
	b := l.base
	if b == 0 {
		return 0, age <= t.startup
	}
	if age -= time.Duration(b); age < 0 {
		age = 0
	}
	return age, true
}

// pick: the least behind of the lanes within `limit`; of equals one that carries none of the current parity group,
// and of those the one carrying least. Never `not`.
func (f *udpFlow) pick(now int64, limit time.Duration, not *flowLane) *flowLane {
	var best *flowLane
	var least time.Duration
	var load uint64
	for _, l := range f.lanes {
		if l == not {
			continue
		}
		q, ok := l.behind(now, f.tune)
		if !ok || q > limit {
			continue
		}
		if q < f.tune.spill {
			q = 0 // within the usual jitter all lanes are equal
		}
		n := l.sent - l.acked
		for _, u := range f.group.used {
			if u == l {
				n += flowRing // a lane that stalls must not hold two frames of one group
				break
			}
		}
		if best == nil || q < least || (q == least && n < load) {
			best, least, load = l, q, n
		}
	}
	return best
}

// cover adds a data frame that was just sent on lane l to the parity group, and sends the parity when it is full.
func (f *udpFlow) cover(seq uint32, data []byte, l *flowLane, now int64) {
	g := &f.group
	if f.tune.parity <= 0 {
		return
	}
	if g.count == 0 {
		g.first, g.at, g.xor, g.used = seq, now, g.xor[:0], g.used[:0]
	}
	for len(g.xor) < 2+len(data) {
		g.xor = append(g.xor, 0)
	}
	g.xor[0] ^= byte(len(data) >> 8)
	g.xor[1] ^= byte(len(data))
	for i, b := range data {
		g.xor[2+i] ^= b
	}
	g.used = append(g.used, l)
	if g.count++; g.count >= f.tune.parity || g.count >= flowParityMax {
		f.parity(now)
	}
}

// parity sends the current group's parity frame on a lane that is not behind, by preference one that carried none of
// the group. A parity frame is not numbered, reported or sent again: if it cannot go now, the group goes without.
func (f *udpFlow) parity(now int64) {
	g := &f.group
	if g.count == 0 {
		return
	}
	if l := f.pick(now, f.tune.spill, nil); l != nil {
		frame := make([]byte, 9+len(g.xor))
		binary.BigEndian.PutUint16(frame, flowParitySize)
		binary.BigEndian.PutUint16(frame[2:], uint16(5+len(g.xor)))
		binary.BigEndian.PutUint32(frame[4:], g.first)
		frame[8] = byte(g.count)
		copy(frame[9:], g.xor)
		l.lastWrite = now
		l.out <- frame
		f.stats.Parity++
	}
	g.count, g.used = 0, g.used[:0]
}

func (l *flowLane) put(frame []byte, now, born int64, hedged bool) {
	if l.sent == l.acked {
		l.progress = now
	}
	l.ring[l.sent%flowRing] = flowSlot{at: now, born: born, frame: frame, hedged: hedged}
	l.sent++
	l.held += len(frame)
	l.lastWrite = now
	l.out <- frame // never blocks: behind() saw room, and only the flow's lock holder puts
}

// hedge sends again, on a lane that is not behind, the frames a lane that has fallen behind (or is going away) still
// carries. Each frame gets one second copy, and none once it is too old to be of use.
func (f *udpFlow) hedge(now int64, l *flowLane, leaving bool) {
	if l.sent == l.acked {
		return
	}
	if !leaving {
		// behind AND silent: a lane that is only slow still reports, and a second copy of what it carries would
		// load the others for nothing
		if q, ok := l.behind(now, f.tune); (ok && q <= f.tune.hedge) || time.Duration(now-l.progress) <= f.tune.hedge {
			return
		}
	}
	if l.hedgeNext < l.acked {
		l.hedgeNext = l.acked
	}
	for ; l.hedgeNext < l.sent; l.hedgeNext++ {
		s := &l.ring[l.hedgeNext%flowRing]
		if s.hedged || time.Duration(now-s.born) > f.tune.late {
			continue
		}
		// second copies are a share of what is sent, not more: when every lane is slow because the path is full,
		// copies would fill it further and make more lanes slow
		if f.credit < flowHedgeShare && !leaving {
			return
		}
		to := f.pick(now, f.tune.spill, l)
		if to == nil {
			return
		}
		if f.credit -= flowHedgeShare; f.credit < 0 {
			f.credit = 0
		}
		s.hedged = true
		to.put(s.frame, now, s.born, true)
		f.stats.Hedged++
	}
}

// fromApp gives each datagram from the app to a lane, or drops it when every lane is too far behind.
func (f *udpFlow) fromApp() {
	defer f.close()
	b := make([]byte, maxDatagram+1)
	for {
		f.u.SetReadDeadline(time.Now().Add(tunnelIdle))
		n, err := f.u.Read(b)
		if err != nil {
			return
		}
		frame := make([]byte, 2+flowSeqBytes+n)
		copy(frame[2+flowSeqBytes:], b[:n])
		now := time.Now().UnixNano()
		f.mu.Lock()
		if f.closed {
			f.mu.Unlock()
			return
		}
		for _, l := range f.lanes {
			f.hedge(now, l, false)
		}
		l := f.pick(now, f.tune.late, nil)
		if l == nil || n > maxDatagram-flowSeqBytes {
			f.stats.Dropped++
			f.mu.Unlock()
			continue
		}
		binary.BigEndian.PutUint16(frame, uint16(flowSeqBytes+n))
		binary.BigEndian.PutUint32(frame[2:], f.seq)
		seq := f.seq
		f.seq++
		f.stats.Sent++
		if f.credit < flowHedgeShare*flowHedgeBurst {
			f.credit++
		}
		l.put(frame, now, now, false)
		f.cover(seq, frame[2+flowSeqBytes:], l, now)
		f.mu.Unlock()
	}
}

// tick notices a lane that has fallen behind while the app is quiet, and reports what each lane has received.
func (f *udpFlow) tick() {
	t := time.NewTicker(flowTick)
	defer t.Stop()
	for {
		select {
		case <-f.done:
			return
		case at := <-t.C:
			now := at.UnixNano()
			f.mu.Lock()
			if f.group.count > 0 && time.Duration(now-f.group.at) >= flowParityWait {
				f.parity(now)
			}
			var slowest int64
			for _, l := range f.lanes {
				f.hedge(now, l, false)
				if l.dying {
					continue
				}
				if f.tune.dead > 0 && l.sent != l.acked && time.Duration(now-l.progress) > f.tune.dead {
					l.dying = true
					l.c.Close() // its reader ends the lane
					f.stats.Renewed++
					continue
				}
				if !l.closed && len(l.out) < cap(l.out) && (l.received != l.reported || time.Duration(now-l.lastWrite) > flowKeepalive) {
					l.lastWrite, l.reported = now, l.received
					l.out <- flowReport(l.received)
				}
				if b := l.base; b > slowest {
					slowest = b
				}
			}
			// told again when it has moved by a fifth, on the lane that has room
			if ms := uint32((time.Duration(slowest) + f.tune.hedge + 2*flowTick) / time.Millisecond); slowest != 0 && (ms > f.repair+f.repair/5 || ms < f.repair-f.repair/5) {
				for _, l := range f.lanes {
					if !l.closed && len(l.out) < cap(l.out) {
						f.repair = ms
						r := make([]byte, 6)
						binary.BigEndian.PutUint16(r, flowRepairSize)
						binary.BigEndian.PutUint32(r[2:], ms)
						l.out <- r
						break
					}
				}
			}
			f.mu.Unlock()
		}
	}
}

func flowReport(count uint64) []byte {
	r := make([]byte, 10)
	binary.BigEndian.PutUint16(r, flowReportSize)
	binary.BigEndian.PutUint64(r[2:], count)
	return r
}

// delivered records the client's count for a lane. A count that goes back, or passes what was sent, ends the lane.
func (f *udpFlow) delivered(l *flowLane, count uint64) bool {
	now := time.Now().UnixNano()
	f.mu.Lock()
	defer f.mu.Unlock()
	if count < l.acked || count > l.sent {
		return false
	}
	if count == l.acked {
		return true
	}
	// the least ever seen, for the connection's life: a period's least would creep up under lasting congestion, and
	// what the lane is behind by would be measured against the congestion itself
	if d := now - l.ring[(count-1)%flowRing].at; d > 0 && (l.base == 0 || d < l.base) {
		l.base = d
	}
	for ; l.acked < count; l.acked++ {
		l.held -= len(l.ring[l.acked%flowRing].frame)
		l.ring[l.acked%flowRing] = flowSlot{}
	}
	l.progress = now
	return true
}

// serveLane runs one connection of the flow until it ends. What it still carried is sent again on another lane; the
// flow ends with its last lane.
func (f *udpFlow) serveLane(c net.Conn, buffered *bufio.Reader) {
	l := &flowLane{c: c, out: make(chan []byte, flowQueue), lastWrite: time.Now().UnixNano()}
	f.mu.Lock()
	f.pending--
	if f.closed {
		f.mu.Unlock()
		c.Close()
		return
	}
	f.lanes = append(f.lanes, l)
	f.stats.Lanes++
	f.mu.Unlock()
	go func() {
		for b := range l.out {
			c.SetWriteDeadline(time.Now().Add(tunnelIdle))
			if _, err := c.Write(b); err != nil {
				c.Close()
				for range l.out {
				}
				return
			}
		}
	}()
	r := io.MultiReader(io.LimitReader(buffered, int64(buffered.Buffered())), idleConn{c})
	b := make([]byte, maxDatagram)
	var head [8]byte
	for {
		if _, err := io.ReadFull(r, head[:2]); err != nil {
			break
		}
		n := int(binary.BigEndian.Uint16(head[:2]))
		if n == flowReportSize {
			if _, err := io.ReadFull(r, head[:]); err != nil || !f.delivered(l, binary.BigEndian.Uint64(head[:])) {
				break
			}
			continue
		}
		if n > maxDatagram {
			break
		}
		if _, err := io.ReadFull(r, b[:n]); err != nil {
			break
		}
		f.mu.Lock()
		l.received++
		f.mu.Unlock()
		f.u.SetWriteDeadline(time.Now().Add(tunnelIdle))
		if _, err := f.u.Write(b[:n]); err != nil {
			break
		}
	}
	f.mu.Lock()
	last := false
	if !l.closed {
		l.closed = true
		close(l.out)
		f.hedge(time.Now().UnixNano(), l, true)
		for i, x := range f.lanes {
			if x == l {
				f.lanes = append(f.lanes[:i], f.lanes[i+1:]...)
				break
			}
		}
		last = len(f.lanes) == 0 && f.pending == 0
	}
	f.mu.Unlock()
	c.Close()
	if last {
		f.close()
	}
}

func (f *udpFlow) snapshot() flowStats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stats
}
