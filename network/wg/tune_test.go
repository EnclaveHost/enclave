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
// rate (bytes/s, 0 = unlimited) is how fast the far side drains the stack: a real line behind WireGuard. A slow drain
// fills the netstack's 1024-packet outbound queue, which drops when full.
func link(t *testing.T, from, to tun.Device, delay time.Duration, loss float64, stop <-chan struct{}, rate ...float64) {
	type pkt struct {
		at time.Time
		b  []byte
	}
	q := make(chan pkt, 1<<16)
	go func() {
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		r := rand.New(rand.NewSource(1))
		// token bucket: sleeping per packet would be capped by the timer's ~1 ms granularity
		var start time.Time
		var sent float64
		for {
			n, err := from.Read(bufs, sizes, 0)
			if err != nil {
				return
			}
			if len(rate) > 0 && rate[0] > 0 {
				if start.IsZero() {
					start = time.Now()
				}
				sent += float64(sizes[0])
				if ahead := time.Duration(sent/rate[0]*float64(time.Second)) - time.Since(start); ahead > 2*time.Millisecond {
					time.Sleep(ahead)
				} else if ahead < -50*time.Millisecond {
					start, sent = time.Now(), 0 // idle: no credit for time nothing was sent
				}
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
	return uploadWith(t, func(n *netstack.Net) error {
		if tuned {
			return TuneTCP(n)
		}
		return nil
	}, delay, loss, size, 0)
}

func uploadWith(t *testing.T, tune func(*netstack.Net) error, delay time.Duration, loss float64, size int, rate float64) float64 {
	a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
	da, na, err := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
	if err != nil {
		t.Fatal(err)
	}
	db, nb, err := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
	if err != nil {
		t.Fatal(err)
	}
	if err := tune(na); err != nil {
		t.Fatal(err)
	}
	if err := tune(nb); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	defer close(stop)
	link(t, da, db, delay, loss, stop, rate)
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

// The sender's queue to WireGuard: with a line that drains at 12.5 MB/s, compare buffer sizes (WG_THROUGHPUT=1).
func TestQueueBoundThroughput(t *testing.T) {
	if os.Getenv("WG_THROUGHPUT") == "" {
		t.Skip("set WG_THROUGHPUT=1 to measure")
	}
	none := func(*netstack.Net) error { return nil }
	sized := func(def, max int) func(*netstack.Net) error {
		return func(n *netstack.Net) error { return tuneSized(n, def, max) }
	}
	for _, c := range []struct {
		name string
		tune func(*netstack.Net) error
	}{{"gvisor default", none}, {"tuned 4/32 MiB", TuneTCP}, {"cubic 1/4 MiB", sized(1<<20, 4<<20)}, {"cubic 1/1.25 MiB", sized(1<<20, 1280<<10)}} {
		for _, rtt := range []time.Duration{80 * time.Millisecond, 300 * time.Millisecond} {
			bps := uploadWith(t, c.tune, rtt/2, 0, 24<<20, 12.5e6)
			t.Logf("%-18s rtt %3dms line 12.5 MB/s: %6.2f MB/s", c.name, rtt.Milliseconds(), bps/1e6)
		}
	}
}

// A home router: packets arrive as fast as the sender emits them (a 1 Gbps NIC), queue in a small buffer (250 packets),
// drain at the uplink's rate and are dropped when the buffer is full. pace (bytes/s, 0 = off) spaces the sender's packets
// before they reach it, as a paced WireGuard bind would. -> upload bytes/s through it.
func uploadRouter(t *testing.T, delay time.Duration, line, pace float64, size int) float64 {
	a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
	da, na, _ := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
	db, nb, _ := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
	TuneTCP(na)
	TuneTCP(nb)
	stop := make(chan struct{})
	defer close(stop)
	type pkt struct {
		at time.Time
		b  []byte
	}
	router := make(chan []byte, 250)
	wire := make(chan pkt, 1<<16)
	go func() { // sender NIC -> (pacer) -> router buffer (drop when full)
		bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
		var start time.Time
		var sent float64
		for {
			if _, err := da.Read(bufs, sizes, 0); err != nil {
				return
			}
			if pace > 0 {
				if start.IsZero() {
					start = time.Now()
				}
				sent += float64(sizes[0])
				if ahead := time.Duration(sent/pace*float64(time.Second)) - time.Since(start); ahead > time.Millisecond {
					time.Sleep(ahead)
				} else if ahead < -50*time.Millisecond {
					start, sent = time.Now(), 0
				}
			}
			select {
			case router <- append([]byte(nil), bufs[0][:sizes[0]]...):
			default: // buffer full: dropped
			}
		}
	}()
	go func() { // router drains at the line rate onto the long path
		start, sent := time.Now(), 0.0
		for {
			select {
			case b := <-router:
				sent += float64(len(b))
				if ahead := time.Duration(sent/line*float64(time.Second)) - time.Since(start); ahead > time.Millisecond {
					time.Sleep(ahead)
				} else if ahead < -50*time.Millisecond {
					start, sent = time.Now(), 0
				}
				wire <- pkt{time.Now().Add(delay), b}
			case <-stop:
				return
			}
		}
	}()
	go func() {
		for {
			select {
			case p := <-wire:
				if d := time.Until(p.at); d > 0 {
					time.Sleep(d)
				}
				db.Write([][]byte{p.b}, 0)
			case <-stop:
				return
			}
		}
	}()
	link(t, db, da, delay, 0, stop) // ACKs back: plenty of room
	l, _ := nb.ListenTCPAddrPort(netip.AddrPortFrom(b4, 9000))
	defer l.Close()
	done := make(chan int64, 1)
	go func() {
		c, err := l.Accept()
		if err != nil {
			done <- 0
			return
		}
		n, _ := io.Copy(io.Discard, c)
		c.Close()
		done <- n
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
	if got := <-done; got != int64(size) {
		t.Fatalf("received %d of %d", got, size)
	}
	return float64(size) / time.Since(start).Seconds()
}

// Pacing the sender below the uplink keeps a small router buffer from dropping bursts (WG_THROUGHPUT=1).
func TestPacedThroughRouter(t *testing.T) {
	if os.Getenv("WG_THROUGHPUT") == "" {
		t.Skip("set WG_THROUGHPUT=1 to measure")
	}
	for _, rtt := range []time.Duration{100 * time.Millisecond, 250 * time.Millisecond} {
		for _, pace := range []float64{0, 11.5e6} {
			bps := uploadRouter(t, rtt/2, 12.5e6, pace, 32<<20)
			t.Logf("rtt %3dms uplink 12.5 MB/s, 250-packet buffer, pace %4.1f MB/s: %6.2f MB/s", rtt.Milliseconds(), pace/1e6, bps/1e6)
		}
	}
}

// Loss on the ACK path only (the sender's data all arrives): how far does the tunnel stack's upload fall (WG_THROUGHPUT=1)?
func TestAckLossSensitivity(t *testing.T) {
	if os.Getenv("WG_THROUGHPUT") == "" {
		t.Skip("set WG_THROUGHPUT=1 to measure")
	}
	for _, loss := range []float64{0, 0.005, 0.02, 0.05} {
		a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
		da, na, _ := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
		db, nb, _ := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
		TuneTCP(na)
		TuneTCP(nb)
		stop := make(chan struct{})
		link(t, da, db, 50*time.Millisecond, 0, stop, 11.5e6) // data: paced line, no loss
		link(t, db, da, 50*time.Millisecond, loss, stop)      // ACKs: lossy
		l, _ := nb.ListenTCPAddrPort(netip.AddrPortFrom(b4, 9000))
		done := make(chan int64, 1)
		go func() {
			c, err := l.Accept()
			if err != nil {
				done <- 0
				return
			}
			n, _ := io.Copy(io.Discard, c)
			c.Close()
			done <- n
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		c, err := na.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(b4, 9000))
		if err != nil {
			t.Fatal(err)
		}
		start, buf, size := time.Now(), make([]byte, 64<<10), 24<<20
		for sent := 0; sent < size; sent += len(buf) {
			c.Write(buf)
		}
		c.Close()
		<-done
		st, _ := netstackStack(na)
		t.Logf("ACK loss %4.1f%%: %6.2f MB/s  (retransmits %d, RTO timeouts %d)", loss*100, float64(size)/time.Since(start).Seconds()/1e6, st.Stats().TCP.Retransmits.Value(), st.Stats().TCP.Timeouts.Value())
		cancel()
		l.Close()
		close(stop)
	}
}

// ACKs that arrive in late clumps (a receive path that holds them for spike every period): spurious retransmission
// timeouts? (WG_THROUGHPUT=1)
func TestAckDelaySpikes(t *testing.T) {
	if os.Getenv("WG_THROUGHPUT") == "" {
		t.Skip("set WG_THROUGHPUT=1 to measure")
	}
	for _, spike := range []time.Duration{0, 150 * time.Millisecond, 300 * time.Millisecond, 600 * time.Millisecond} {
		a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
		da, na, _ := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
		db, nb, _ := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
		TuneTCP(na)
		TuneTCP(nb)
		stop := make(chan struct{})
		link(t, da, db, 50*time.Millisecond, 0, stop, 11.5e6)
		// ACK path: 50 ms, but every 2 s everything is held for `spike` and then delivered at once
		go func() {
			bufs, sizes := [][]byte{make([]byte, 2048)}, []int{0}
			t0 := time.Now()
			for {
				if _, err := db.Read(bufs, sizes, 0); err != nil {
					return
				}
				b := append([]byte(nil), bufs[0][:sizes[0]]...)
				el := time.Since(t0) % (2 * time.Second)
				hold := 50 * time.Millisecond
				if spike > 0 && el < spike {
					hold += spike - el
				}
				go func(b []byte, d time.Duration) { time.Sleep(d); da.Write([][]byte{b}, 0) }(b, hold)
			}
		}()
		l, _ := nb.ListenTCPAddrPort(netip.AddrPortFrom(b4, 9000))
		done := make(chan int64, 1)
		go func() {
			c, err := l.Accept()
			if err != nil {
				done <- 0
				return
			}
			n, _ := io.Copy(io.Discard, c)
			c.Close()
			done <- n
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		c, err := na.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(b4, 9000))
		if err != nil {
			t.Fatal(err)
		}
		start, buf, size := time.Now(), make([]byte, 64<<10), 24<<20
		for sent := 0; sent < size; sent += len(buf) {
			c.Write(buf)
		}
		c.Close()
		<-done
		st, _ := netstackStack(na)
		t.Logf("ACK spike %3dms every 2s: %6.2f MB/s  (retransmits %d, RTO timeouts %d)", spike.Milliseconds(), float64(size)/time.Since(start).Seconds()/1e6, st.Stats().TCP.Retransmits.Value(), st.Stats().TCP.Timeouts.Value())
		cancel()
		l.Close()
		close(stop)
	}
}
