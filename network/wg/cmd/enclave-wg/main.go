// enclave-wg is one circuit's data plane (docs/design/enclave-network.md). It is driven by JSON lines on stdin and
// reports JSON lines on stdout; it holds no policy of its own beyond refusing non-public destinations:
//
//	{"type":"outer","peer":{...},"control":"<exit ip>:<port>"}   tunnel to the guard + a loopback forward to the
//	                                                              exit's control port through it -> outer-ready
//	{"type":"inner","peer":{...},"egress":{"user","pass"},"ingress":{"443":"127.0.0.1:p","80":"127.0.0.1:q"},
//	 "own":["<ip>",...]}                                          tunnel to the exit (inside the outer tunnel when
//	                                                              there is one) + SOCKS egress + ingress -> ready
//	{"type":"admission","open":false}                             cut every open connection (the runtime gates new ones)
//	{"type":"close"}
//
// A tunnel with no handshake for 180 s (or none within 30 s of starting) is reported "down" and the process exits:
// nothing ever falls back to the host's own network.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"enclave.host/network/wg"
	"golang.zx2c4.com/wireguard/conn"
)

type msg struct {
	Type    string                       `json:"type"`
	Peer    *wg.Peer                     `json:"peer,omitempty"`
	Control string                       `json:"control,omitempty"`
	Egress  *struct{ User, Pass string } `json:"egress,omitempty"`
	Ingress map[string]string            `json:"ingress,omitempty"`
	Own     []string                     `json:"own,omitempty"`
	Open    *bool                        `json:"open,omitempty"`
}

var (
	outMu sync.Mutex
	enc   = json.NewEncoder(os.Stdout)
)

func emit(v map[string]any) {
	outMu.Lock()
	defer outMu.Unlock()
	enc.Encode(v)
}

func fail(err string) {
	emit(map[string]any{"type": "down", "error": err})
	os.Exit(1)
}

type state struct {
	mu           sync.Mutex
	outer, inner *wg.Device
	socks        *wg.Socks
	fwd          wg.Forwards
	ctl          wg.Forwards
	up, down     atomic.Int64
	innerStarted time.Time
	outerStarted time.Time
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println("enclave-wg 1")
		return
	}
	s := &state{}
	s.fwd.Count = func(in, out int64) { s.down.Add(in); s.up.Add(out) }
	go s.watch()
	sc := bufio.NewScanner(os.Stdin)
	sc.Buffer(make([]byte, 64*1024), 64*1024)
	for sc.Scan() {
		var m msg
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			fail("bad command")
		}
		switch m.Type {
		case "outer":
			s.outerUp(m)
		case "inner":
			s.innerUp(m)
		case "admission":
			if m.Open != nil && !*m.Open {
				s.mu.Lock()
				if s.socks != nil {
					s.socks.Cut()
				}
				s.fwd.Cut()
				s.mu.Unlock()
			}
		case "close":
			s.cut()
			os.Exit(0)
		default:
			fail("unknown command")
		}
	}
	// stdin closed: the runtime is gone, so is this circuit
	s.cut()
	os.Exit(0)
}

func (s *state) outerUp(m msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.outer != nil || s.inner != nil || m.Peer == nil {
		fail("outer tunnel must come first and once")
	}
	control, err := netip.ParseAddrPort(m.Control)
	if err != nil {
		fail("control address required")
	}
	d, err := wg.Up(*m.Peer, conn.NewDefaultBind(), func(f string, a ...any) {})
	if err != nil {
		fail("outer tunnel: " + err.Error())
	}
	s.outer, s.outerStarted = d, time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.WaitHandshake(ctx); err != nil {
		fail("guard: " + err.Error())
	}
	local, err := s.ctl.Local(d, control)
	if err != nil {
		fail("control forward: " + err.Error())
	}
	emit(map[string]any{"type": "outer-ready", "control": local})
}

func (s *state) innerUp(m msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inner != nil || m.Peer == nil {
		fail("inner tunnel once")
	}
	var bind conn.Bind = conn.NewDefaultBind()
	if s.outer != nil {
		local, ok := s.outer.Local(false)
		if !ok {
			fail("outer tunnel has no IPv4 address")
		}
		bind = &wg.NetstackBind{Net: s.outer.Net, Local: local, Peer: netip.AddrPortFrom(m.Peer.Endpoint.Addr().Unmap(), m.Peer.Endpoint.Port())}
		// the exit's control forward is done once the inner tunnel exists
		s.ctl.Close()
	}
	d, err := wg.Up(*m.Peer, bind, func(f string, a ...any) {})
	if err != nil {
		fail("tunnel: " + err.Error())
	}
	s.inner, s.innerStarted = d, time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.WaitHandshake(ctx); err != nil {
		fail("exit: " + err.Error())
	}
	ready := map[string]any{"type": "ready"}
	if m.Egress != nil {
		if len(m.Egress.User) < 16 || len(m.Egress.Pass) < 16 {
			fail("egress credentials too short")
		}
		pol := wg.Policy{NoIPv6: !m.Peer.HasIPv6(), Own: []netip.Addr{m.Peer.Endpoint.Addr()}}
		if s.outer != nil {
			pol.Own = append(pol.Own, s.outer.Peer.Endpoint.Addr())
		}
		for _, o := range m.Own {
			if a, err := netip.ParseAddr(o); err == nil {
				pol.Own = append(pol.Own, a)
			}
		}
		s.socks = &wg.Socks{User: m.Egress.User, Pass: m.Egress.Pass, Tunnel: d, Policy: pol,
			Count: func(up, down int64) { s.up.Add(up); s.down.Add(down) }}
		l, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			fail("egress listener: " + err.Error())
		}
		go s.socks.Serve(l)
		ready["egress"] = l.Addr().String()
	}
	for p, to := range m.Ingress {
		port, err := strconv.Atoi(p)
		if err != nil || (port != 443 && port != 80) {
			fail("ingress ports are 443 and 80")
		}
		if ap, err := netip.ParseAddrPort(to); err != nil || !ap.Addr().IsLoopback() {
			fail("ingress forwards only to loopback")
		}
		if err := s.fwd.Ingress(d, uint16(port), to); err != nil {
			fail("ingress listener: " + err.Error())
		}
	}
	if len(m.Ingress) > 0 {
		ready["ingress"] = true
	}
	emit(ready)
}

func (s *state) cut() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.socks != nil {
		s.socks.CloseAll()
	}
	s.fwd.Close()
	s.ctl.Close()
}

func age(d *wg.Device, started time.Time) (time.Duration, uint64, uint64, bool) {
	last, rx, tx := d.Stats()
	if last.IsZero() {
		return time.Since(started), rx, tx, false
	}
	return time.Since(last), rx, tx, true
}

func (s *state) watch() {
	t := time.NewTicker(5 * time.Second)
	for range t.C {
		s.mu.Lock()
		outer, inner, os_, is := s.outer, s.inner, s.outerStarted, s.innerStarted
		s.mu.Unlock()
		stats := map[string]any{"type": "stats", "app": map[string]int64{"up": s.up.Load(), "down": s.down.Load()}}
		for _, x := range []struct {
			name    string
			d       *wg.Device
			started time.Time
		}{{"outer", outer, os_}, {"inner", inner, is}} {
			if x.d == nil {
				continue
			}
			a, rx, tx, ok := age(x.d, x.started)
			if (!ok && a > 30*time.Second) || a > 180*time.Second {
				fail(x.name + " tunnel: no handshake for " + a.Round(time.Second).String())
			}
			stats[x.name] = map[string]any{"handshakeAgeMs": a.Milliseconds(), "rx": rx, "tx": tx}
		}
		emit(stats)
	}
}
