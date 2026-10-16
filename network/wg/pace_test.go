package wg

import (
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/conn"
)

type countBind struct {
	conn.Bind
	sent  int
	sizes []int
}

func (c *countBind) Send(bufs [][]byte, _ conn.Endpoint) error {
	c.sent += len(bufs)
	c.sizes = append(c.sizes, len(bufs))
	return nil
}

// 300 packets of 1372 B (+28 on the wire) at 4.2 MB/s take ~0.1 s, never go out more than paceChunk at a time, and all
// arrive; one packet per Send at 95 Mbps still reaches the rate (a sleep per call would cap it near 2 MB/s); an unpaced
// bind passes a batch straight through.
func TestPacedBind(t *testing.T) {
	inner := &countBind{}
	b := Paced(inner, 4.2e6*8/1e6)
	pkts := make([][]byte, 0, 300)
	for i := 0; i < 300; i++ {
		pkts = append(pkts, make([]byte, 1372))
	}
	start := time.Now()
	for i := 0; i < 300; i += 100 {
		if err := b.Send(pkts[i:i+100], nil); err != nil {
			t.Fatal(err)
		}
	}
	el := time.Since(start)
	if inner.sent != 300 {
		t.Fatalf("sent %d of 300", inner.sent)
	}
	for _, n := range inner.sizes {
		if n > paceChunk {
			t.Fatalf("a chunk of %d left at once", n)
		}
	}
	if el < 80*time.Millisecond || el > 250*time.Millisecond {
		t.Fatalf("300 packets took %v, want ~100 ms at 4.2 MB/s", el)
	}
	fast := &countBind{}
	fb := Paced(fast, 95)
	one := [][]byte{make([]byte, 1372)}
	start = time.Now()
	for i := 0; i < 8000; i++ { // 11.2 MB at 11.9 MB/s: ~0.94 s
		fb.Send(one, nil)
	}
	if el := time.Since(start); el < 800*time.Millisecond || el > 1300*time.Millisecond {
		t.Fatalf("8000 single-packet sends at 95 Mbps took %v, want ~0.94 s", el)
	}
	raw := &countBind{}
	if Paced(raw, 0) != conn.Bind(raw) {
		t.Fatal("0 Mbps must leave the bind unpaced")
	}
}

// A timer that sleeps in 15.6 ms steps (Windows' default resolution) must not drag the rate down to the ~3 ms of
// every step that paceCredit alone makes up (~2.2 MB/s at 90 Mbps); the oversleep is earned back as credit, and no
// single Send burst exceeds what maxPaceCredit allows.
func TestPacedBindCoarseTimer(t *testing.T) {
	defer func(s func(time.Duration)) { paceSleep = s }(paceSleep)
	const step = 15600 * time.Microsecond
	paceSleep = func(d time.Duration) { time.Sleep((d + step - 1) / step * step) }
	inner := &countBind{}
	b := Paced(inner, 90)
	one := [][]byte{make([]byte, 1372)}
	start := time.Now()
	for i := 0; i < 8000; i++ { // 11.2 MB at 11.25 MB/s: ~1.0 s
		b.Send(one, nil)
	}
	el := time.Since(start)
	if el > 1400*time.Millisecond {
		t.Fatalf("8000 packets at 90 Mbps with a 15.6 ms timer took %v (%.1f MB/s), want ~1 s", el, 8000*1400/el.Seconds()/1e6)
	}
	if el < 850*time.Millisecond {
		t.Fatalf("8000 packets at 90 Mbps took only %v: the pacer is not pacing", el)
	}
}
