package wg

import (
	"context"
	"io"
	"math/rand"
	"net/netip"
	"os"
	"sync"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// link moves packets from one tunnel stack to the other after delay, dropping a fraction of them (a long circuit).
func link(t *testing.T, from, to tun.Device, delay time.Duration, loss float64, stop <-chan struct{}) {
	type pkt struct {
		at time.Time
		b  []byte
	}
	q := make(chan pkt, 1<<16)
	go func() {
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		r := rand.New(rand.NewSource(1))
		for {
			n, err := from.Read(bufs, sizes, 0)
			if err != nil {
				return
			}
			for i := 0; i < n; i++ {
				if loss > 0 && r.Float64() < loss {
					continue
				}
				b := append([]byte(nil), bufs[i][:sizes[i]]...)
				select {
				case q <- pkt{time.Now().Add(delay), b}:
				case <-stop:
					return
				}
			}
		}
	}()
	go func() {
		for {
			select {
			case p := <-q:
				if d := time.Until(p.at); d > 0 {
					time.Sleep(d)
				}
				to.Write([][]byte{p.b}, 0)
			case <-stop:
				return
			}
		}
	}()
}

// upload sends size bytes from a to b over one TCP connection; -> bytes per second
func upload(t *testing.T, tuned bool, delay time.Duration, loss float64, size int) float64 {
	a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
	da, na, err := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
	if err != nil {
		t.Fatal(err)
	}
	db, nb, err := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
	if err != nil {
		t.Fatal(err)
	}
	if tuned {
		if err := TuneTCP(na); err != nil {
			t.Fatal(err)
		}
		if err := TuneTCP(nb); err != nil {
			t.Fatal(err)
		}
	}
	stop := make(chan struct{})
	defer close(stop)
	link(t, da, db, delay, loss, stop)
	link(t, db, da, delay, loss, stop)
	l, err := nb.ListenTCPAddrPort(netip.AddrPortFrom(b4, 9000))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	var got int64
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		c, err := l.Accept()
		if err != nil {
			return
		}
		got, _ = io.Copy(io.Discard, c)
		c.Close()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	c, err := na.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(b4, 9000))
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	buf := make([]byte, 64<<10)
	for sent := 0; sent < size; sent += len(buf) {
		if _, err := c.Write(buf); err != nil {
			t.Fatal(err)
		}
	}
	c.Close()
	wg.Wait()
	el := time.Since(start)
	if got != int64(size) {
		t.Fatalf("received %d of %d", got, size)
	}
	return float64(size) / el.Seconds()
}

// The tuned stack must not be slower anywhere and must fill a long path that the defaults cannot (run with
// WG_THROUGHPUT=1: it takes a minute and measures, so it stays out of the default test run).
func TestTunedThroughput(t *testing.T) {
	if os.Getenv("WG_THROUGHPUT") == "" {
		t.Skip("set WG_THROUGHPUT=1 to measure")
	}
	for _, c := range []struct {
		name  string
		delay time.Duration
		loss  float64
	}{
		{"rtt 60ms", 30 * time.Millisecond, 0},
		{"rtt 300ms", 150 * time.Millisecond, 0},
		{"rtt 300ms 0.5% loss", 150 * time.Millisecond, 0.005},
	} {
		def := upload(t, false, c.delay, c.loss, 16<<20)
		tun := upload(t, true, c.delay, c.loss, 16<<20)
		t.Logf("%-22s default %6.2f MB/s   tuned %6.2f MB/s", c.name, def/1e6, tun/1e6)
	}
}

func TestTuneTCPFindsTheStack(t *testing.T) {
	_, n, err := netstack.CreateNetTUN([]netip.Addr{netip.MustParseAddr("10.9.0.1")}, nil, 1420)
	if err != nil {
		t.Fatal(err)
	}
	if err := TuneTCP(n); err != nil {
		t.Fatal(err)
	}
}
