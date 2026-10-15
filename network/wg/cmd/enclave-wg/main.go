// enclave-wg is one circuit's data plane (docs/design/enclave-network.md). It is driven by JSON lines on stdin and
// reports JSON lines on stdout; it holds no policy of its own beyond refusing non-public destinations:
//
//	{"type":"outer","peer":{...},"control":"<exit ip>:<port>","controlListen":"127.0.0.1:p",
//	 "guardSocks":{"listen":"127.0.0.1:q","only":["<exit ip>:443",...]}}
//	                                                              tunnel to the guard, a loopback forward to the exit's
//	                                                              control port and a SOCKS limited to exactly the listed
//	                                                              provider ports, both through it -> outer-ready
//	{"type":"inner","peer":{...},"egress":{"user","pass","listen"},"ingress":{"443":"127.0.0.1:p","80":"127.0.0.1:q"},
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
	Type          string   `json:"type"`
	Peer          *wg.Peer `json:"peer,omitempty"`
	Control       string   `json:"control,omitempty"`
	ControlListen string   `json:"controlListen,omitempty"`
	GuardSocks    *struct {
		Listen string   `json:"listen"`
		Only   []string `json:"only"`
	} `json:"guardSocks,omitempty"`
	Egress *struct {
		User   string `json:"user"`
		Pass   string `json:"pass"`
		Listen string `json:"listen"`
	} `json:"egress,omitempty"`
	Ingress map[string]string `json:"ingress,omitempty"`
	Own     []string          `json:"own,omitempty"`
	// the host's uplink in Mbps: the tunnel's real UDP socket is paced to it (pace.go); 0 = unpaced
	PaceMbps float64 `json:"paceMbps,omitempty"`
	Open     *bool   `json:"open,omitempty"`
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
	guardSocks   *wg.Socks
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
	// enclave-wg check < input.json: one provider's qualification checks through the real data path
	if len(os.Args) > 1 && os.Args[1] == "check" {
		var in wg.CheckInput
		if err := json.NewDecoder(os.Stdin).Decode(&in); err != nil {
			fmt.Fprintln(os.Stderr, "check input:", err)
			os.Exit(2)
		}
		enc.Encode(wg.RunCheck(in))
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
	d, err := wg.Up(*m.Peer, wg.Paced(conn.NewDefaultBind(), m.PaceMbps), func(f string, a ...any) {})
	if err != nil {
		fail("outer tunnel: " + err.Error())
	}
	s.outer, s.outerStarted = d, time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := d.WaitHandshake(ctx); err != nil {
		fail("guard: " + err.Error())
	}
	local, err := s.ctl.Local(d, control, listenOr(m.ControlListen))
	if err != nil {
		fail("control forward: " + err.Error())
	}
	ready := map[string]any{"type": "outer-ready", "control": local}
	if m.GuardSocks != nil {
		pol := wg.Policy{NoIPv6: true}
		for _, o := range m.GuardSocks.Only {
			ap, err := netip.ParseAddrPort(o)
			if err != nil {
				fail("guard SOCKS destinations are ip:port")
			}
			pol.Only = append(pol.Only, ap)
		}
		if len(pol.Only) == 0 || len(pol.Only) > 8 {
			fail("guard SOCKS needs 1-8 exact destinations")
		}
		s.guardSocks = &wg.Socks{Tunnel: d, Policy: pol}
		l, err := net.Listen("tcp", listenOr(m.GuardSocks.Listen))
		if err != nil {
			fail("guard SOCKS listener: " + err.Error())
		}
		go s.guardSocks.Serve(l)
		ready["guardSocks"] = l.Addr().String()
	}
	emit(ready)
}

func (s *state) innerUp(m msg) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inner != nil || m.Peer == nil {
		fail("inner tunnel once")
	}
	// the real socket is paced; an inner tunnel inside the outer one rides the outer's paced socket
	var bind conn.Bind = wg.Paced(conn.NewDefaultBind(), m.PaceMbps)
	if s.outer != nil {
		local, ok := s.outer.Local(false)
		if !ok {
			fail("outer tunnel has no IPv4 address")
		}
		bind = &wg.NetstackBind{Net: s.outer.Net, Local: local, Peer: netip.AddrPortFrom(m.Peer.Endpoint.Addr().Unmap(), m.Peer.Endpoint.Port())}
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
		if (m.Egress.User != "" || m.Egress.Pass != "") && (len(m.Egress.User) < 16 || len(m.Egress.Pass) < 16) {
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
			Count:  func(up, down int64) { s.up.Add(up); s.down.Add(down) },
			OnConn: func(r map[string]any) { r["type"] = "conn"; emit(r) }}
		l, err := net.Listen("tcp", listenOr(m.Egress.Listen))
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

// listenOr returns a loopback listen address (default: any free port); anything else is refused.
func listenOr(a string) string {
	if a == "" {
		return "127.0.0.1:0"
	}
	ap, err := netip.ParseAddrPort(a)
	if err != nil || ap.Addr() != netip.MustParseAddr("127.0.0.1") {
		fail("listeners are on 127.0.0.1 only")
	}
	return a
}

func (s *state) cut() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.socks != nil {
		s.socks.CloseAll()
	}
	if s.guardSocks != nil {
		s.guardSocks.CloseAll()
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
			stats[x.name] = map[string]any{"handshakeAgeMs": a.Milliseconds(), "rx": rx, "tx": tx, "tcp": wg.TCPCounters(x.d.Net)}
		}
		stats["paceSleptMs"] = wg.PaceSleptNs.Load() / int64(time.Millisecond)
		emit(stats)
	}
}
