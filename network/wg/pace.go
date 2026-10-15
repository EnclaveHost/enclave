package wg

import (
	"sync"
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

	mu   sync.Mutex
	next time.Time
}

const paceChunk = 8 // packets sent together between waits: a burst any router buffer holds

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
		// no credit for idle time beyond one chunk: an idle tunnel does not earn a burst
		if b.next.Before(now) {
			b.next = now
		}
		at := b.next
		b.next = at.Add(time.Duration(float64(size) / b.Rate * float64(time.Second)))
		b.mu.Unlock()
		if d := time.Until(at); d > 0 {
			time.Sleep(d)
		}
		if err := b.Bind.Send(chunk, ep); err != nil {
			return err
		}
	}
	return nil
}

// Paced wraps bind when mbps > 0 (megabits per second, the host's uplink as its operator configured it).
func Paced(bind conn.Bind, mbps float64) conn.Bind {
	if mbps <= 0 {
		return bind
	}
	return &PacedBind{Bind: bind, Rate: mbps * 1e6 / 8}
}
