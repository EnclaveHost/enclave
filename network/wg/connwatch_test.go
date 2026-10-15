package wg

import (
	"context"
	"io"
	"net/netip"
	"testing"
	"time"

	"golang.zx2c4.com/wireguard/tun/netstack"
)

// The watcher finds the gVisor endpoint inside a netstack connection and reports a big transfer's windows per second.
func TestConnWatchReportsAnUpload(t *testing.T) {
	a4, b4 := netip.MustParseAddr("10.9.0.1"), netip.MustParseAddr("10.9.0.2")
	da, na, _ := netstack.CreateNetTUN([]netip.Addr{a4}, nil, 1340)
	db, nb, _ := netstack.CreateNetTUN([]netip.Addr{b4}, nil, 1340)
	TuneTCP(na)
	TuneTCP(nb)
	stop := make(chan struct{})
	defer close(stop)
	link(t, da, db, 20*time.Millisecond, 0, stop, 5e6)
	link(t, db, da, 20*time.Millisecond, 0, stop)
	l, _ := nb.ListenTCPAddrPort(netip.AddrPortFrom(b4, 9000))
	defer l.Close()
	go func() {
		c, err := l.Accept()
		if err == nil {
			io.Copy(io.Discard, c)
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := na.DialContextTCPAddrPort(ctx, netip.AddrPortFrom(b4, 9000))
	if err != nil {
		t.Fatal(err)
	}
	ep := tcpEndpoint(c)
	if ep == nil {
		t.Fatal("no gVisor endpoint found in the netstack connection")
	}
	w := watchConn(ep)
	buf := make([]byte, 64<<10)
	for sent := 0; sent < 12<<20; sent += len(buf) { // ~2.5 s at 5 MB/s: two or three samples
		c.Write(buf)
		w.up.Add(int64(len(buf)))
	}
	time.Sleep(1100 * time.Millisecond)
	r := w.report()
	c.Close()
	if r == nil {
		t.Fatal("no report for a 12 MiB upload")
	}
	ps, _ := r["perSecond"].([]map[string]any)
	if len(ps) == 0 || r["maxCwnd"].(uint32) == 0 {
		t.Fatalf("empty report: %v", r)
	}
	t.Logf("report: maxCwnd %v minSsthresh %v states %v first %v", r["maxCwnd"], r["minSsthresh"], r["ccStates"], ps[0])
	if watchConn(nil).report() != nil {
		t.Fatal("a connection without an endpoint must not report")
	}
}
