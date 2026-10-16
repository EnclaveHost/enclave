package wg

import (
	"sync"
	"sync/atomic"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

// PacedBind spaces a tunnel's outgoing UDP at Rate bytes/s. A home router buffers only a few hundred packets, and a
// host's 1 Gbps NIC hands it a TCP window's burst ten times faster than a 100 Mbps uplink drains: on the NucBox's line,
// bursts of 512 packets lost 40% and 1024 lost 66% (paced, 80 Mbps lost nothing; 2026-10-15). The userspace TCP inside
// the tunnel then backs off hard on every burst. Sent in small chunks at the host's uplink rate, the same traffic queues
// nowhere (TestPacedThroughRouter: 250 ms RTT 2.6 -> 6.7 MB/s on a 12.5 MB/s line).
type PacedBind struct {
	conn.Bind
	Rate float64 // bytes per second; 0 = unpaced

	mu     sync.Mutex
	next   time.Time
	credit time.Duration // how far behind the schedule may be made up at once: paceCredit, or a coarse timer's oversleep
}

const paceChunk = 8 // packets sent together between waits: a burst any router buffer holds

// paceCredit is the most a tunnel may run ahead: 2 ms at 100 Mbps is ~16 packets
const paceCredit = 2 * time.Millisecond

// maxPaceCredit bounds the credit a coarse timer earns. Windows at its default 15.6 ms timer resolution turned every
// 1 ms sleep into ~15.6 ms, and with only paceCredit made up afterwards a circuit sent ~3 ms of every 15.6: a flat
// ~2.2 MB/s at 90 Mbps, on every circuit at once, for minutes, until some program raised the resolution again (the
// NucBox's bimodal uploads, 2026-10-16). 16 ms at 90 Mbps is ~130 packets, under the ~250 the home router held.
const maxPaceCredit = 16 * time.Millisecond

// paceSleep is time.Sleep (a test swaps in a coarse one)
var paceSleep = time.Sleep

func (b *PacedBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	if b.Rate <= 0 {
		return b.Bind.Send(bufs, ep)
	}
	for len(bufs) > 0 {
		n := min(paceChunk, len(bufs))
		chunk := bufs[:n]
		bufs = bufs[n:]
		size := 0
		for _, p := range chunk {
			size += len(p) + 28 // IPv4 + UDP headers on the wire
		}
		b.mu.Lock()
		now := time.Now()
		// a token bucket holding at most b.credit: an idle tunnel earns no more than that burst, yet the time a sleep
		// overshoots is not lost (resetting to now each time left the rate ~35% short)
		credit := max(b.credit, paceCredit)
		if floor := now.Add(-credit); b.next.Before(floor) {
			b.next = floor
		}
		at := b.next
		b.next = at.Add(time.Duration(float64(size) / b.Rate * float64(time.Second)))
		b.mu.Unlock()
		// a sleep lasts at least ~1 ms, far longer than one chunk's share at 100 Mbps (~1 ms for 8 packets, 130 us for
		// one): sleeping for every chunk capped metal0 at ~2 MB/s whatever the rate. So run ahead by up to a millisecond
		// (a burst any router holds) and sleep only once the debt is larger; the average rate is still exact.
		if d := time.Until(at); d > time.Millisecond {
			PaceSleptNs.Add(int64(d))
			t0 := time.Now()
			paceSleep(d)
			// what the timer overslept is behind schedule through no fault of the line: let it be made up (up to
			// maxPaceCredit); a timer that sleeps true brings the credit back down to paceCredit
			over := time.Since(t0) - d
			b.mu.Lock()
			b.credit = min(max(over+time.Millisecond, paceCredit), maxPaceCredit)
			b.mu.Unlock()
		}
		if err := b.Bind.Send(chunk, ep); err != nil {
			return err
		}
	}
	return nil
}

// PaceSleptNs is how long this process's pacers have waited in all (the circuit's stats line).
var PaceSleptNs atomic.Int64

// Paced wraps bind when mbps > 0 (megabits per second, the host's uplink as its operator configured it).
func Paced(bind conn.Bind, mbps float64) conn.Bind {
	if mbps <= 0 {
		return bind
	}
	return &PacedBind{Bind: bind, Rate: mbps * 1e6 / 8}
}
