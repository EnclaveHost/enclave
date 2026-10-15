package wg

import (
	"net"
	"reflect"
	"sync/atomic"
	"time"
	"unsafe"

	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/adapters/gonet"
)

// A big egress connection's life, for the circuit's log: on the NucBox some paced uploads ran at full speed and others,
// on the same circuit minutes apart, crawled at 100-400 KB/s with no loss anywhere on the path (2026-10-15). Sampled once
// a second, the tunnel stack's own view tells the causes apart: a congestion window driven down (cwnd/ssthresh small,
// RTO timeouts), a sender with a large window that is not sending (starved of data), or a window that never grew.
const connReportBytes = 4 << 20

// tcpEndpoint is the gVisor endpoint inside a netstack connection (gonet keeps it private): found by field name and
// checked against its type, so a dependency change that moves it fails quietly to "no report", never misreads memory.
func tcpEndpoint(c net.Conn) tcpip.Endpoint {
	g, ok := c.(*gonet.TCPConn)
	if !ok || g == nil {
		return nil
	}
	v := reflect.ValueOf(g).Elem().FieldByName("ep")
	if !v.IsValid() || v.Type() != reflect.TypeOf((*tcpip.Endpoint)(nil)).Elem() {
		return nil
	}
	return *(*tcpip.Endpoint)(unsafe.Pointer(v.UnsafeAddr()))
}

type connWatch struct {
	up, down atomic.Int64
	start    time.Time
	samples  []map[string]any
	minCwnd  uint32
	maxCwnd  uint32
	minSsth  uint32
	maxRTO   time.Duration
	states   map[string]int
	stop     chan struct{}
	done     chan struct{} // closed when the sampler has exited: report reads only after it
}

func ccName(s tcpip.CongestionControlState) string {
	switch s {
	case tcpip.Open:
		return "open"
	case tcpip.RTORecovery:
		return "rto"
	case tcpip.FastRecovery:
		return "fast"
	case tcpip.SACKRecovery:
		return "sack"
	case tcpip.Disorder:
		return "disorder"
	}
	return "other"
}

// watchConn samples ep every second until stop; up to 40 samples are kept for the report.
func watchConn(ep tcpip.Endpoint) *connWatch {
	w := &connWatch{start: time.Now(), minCwnd: ^uint32(0), minSsth: ^uint32(0), states: map[string]int{}, stop: make(chan struct{}), done: make(chan struct{})}
	if ep == nil {
		close(w.done)
		return w
	}
	go func() {
		defer close(w.done)
		t := time.NewTicker(time.Second)
		defer t.Stop()
		var lastUp int64
		for {
			select {
			case <-w.stop:
				return
			case <-t.C:
			}
			var info tcpip.TCPInfoOption
			if err := ep.GetSockOpt(&info); err != nil {
				return
			}
			up := w.up.Load()
			w.minCwnd = min(w.minCwnd, info.SndCwnd)
			w.maxCwnd = max(w.maxCwnd, info.SndCwnd)
			if info.SndSsthresh > 0 {
				w.minSsth = min(w.minSsth, info.SndSsthresh)
			}
			w.maxRTO = max(w.maxRTO, info.RTO)
			w.states[ccName(info.CcState)]++
			if len(w.samples) < 40 {
				w.samples = append(w.samples, map[string]any{"kbps": (up - lastUp) / 1024, "cwnd": info.SndCwnd,
					"ssthresh": info.SndSsthresh, "rttMs": info.RTT.Milliseconds(), "rtoMs": info.RTO.Milliseconds(), "cc": ccName(info.CcState)})
			}
			lastUp = up
		}
	}()
	return w
}

// report is the connection's summary when it moved enough to matter, else nil.
func (w *connWatch) report() map[string]any {
	close(w.stop)
	<-w.done
	if w.up.Load()+w.down.Load() < connReportBytes || len(w.samples) == 0 {
		return nil
	}
	d := time.Since(w.start)
	return map[string]any{"up": w.up.Load(), "down": w.down.Load(), "ms": d.Milliseconds(),
		"upKBps": w.up.Load() / 1024 / max(1, d.Milliseconds()/1000), "minCwnd": w.minCwnd, "maxCwnd": w.maxCwnd,
		"minSsthresh": w.minSsth, "maxRtoMs": w.maxRTO.Milliseconds(), "ccStates": w.states, "perSecond": w.samples}
}
