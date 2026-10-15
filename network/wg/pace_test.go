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
// arrive; an unpaced bind passes a batch straight through.
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
	raw := &countBind{}
	if Paced(raw, 0) != conn.Bind(raw) {
		t.Fatal("0 Mbps must leave the bind unpaced")
	}
}
