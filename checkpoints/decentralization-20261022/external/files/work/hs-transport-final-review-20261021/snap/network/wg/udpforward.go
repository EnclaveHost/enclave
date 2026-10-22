package wg

import (
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// UDP ingress bounds: flows (senders) at once, how long an UNANSWERED flow lives, the largest datagram relayed either way.
// A flow is one DNS exchange: it closes as soon as its answer is relayed, so a resolver that answers keeps the table near
// empty. When the table is full the OLDEST flow is evicted rather than the new one refused: a burst of distinct source
// ports (the exit masquerades, so every query is a new sender) can delay only itself, never lock out a later query
// (hs-transport review B4). Variables only so tests can shrink them.
var (
	UDPMaxFlows    = 1024
	UDPIdle        = 3 * time.Second
	UDPMaxDatagram = 4096
)

type udpFlow struct {
	key  string
	c    *net.UDPConn
	born int64
	last atomic.Int64
}

type udpRelay struct {
	mu    sync.Mutex
	flows map[string]*udpFlow
	order []*udpFlow // oldest first (eviction); entries of closed flows are skipped lazily
}

// UDPIngress accepts datagrams on the tunnel address and port (DNS that the exit forwards, as packets, to a host's
// route-dns role) and relays each to ONE fixed loopback address, and the answer back to its sender. Each sender is a flow
// with its own connected loopback socket (so only the target's answers come back). It never takes a destination from a
// sender, and nothing but the target is reachable through it.
func (f *Forwards) UDPIngress(d *Device, port uint16, to string) error {
	target, err := netip.ParseAddrPort(to)
	if err != nil || !target.Addr().IsLoopback() {
		return errors.New("udp ingress forwards only to loopback")
	}
	addr, _ := d.Local(false)
	pc, err := d.Net.ListenUDPAddrPort(netip.AddrPortFrom(addr, port))
	if err != nil {
		return err
	}
	r := &udpRelay{flows: map[string]*udpFlow{}}
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		pc.Close()
		return net.ErrClosed
	}
	f.pcs = append(f.pcs, pc)
	f.relays = append(f.relays, r)
	f.mu.Unlock()
	go f.serveUDP(r, pc, net.UDPAddrFromAddrPort(target))
	return nil
}

// drop closes a flow and forgets it (the caller holds r.mu)
func (r *udpRelay) drop(fl *udpFlow) {
	if r.flows[fl.key] == fl {
		delete(r.flows, fl.key)
	}
	fl.c.Close()
}

// evictOldest makes room for one flow (the caller holds r.mu)
func (r *udpRelay) evictOldest() {
	for len(r.order) > 0 {
		fl := r.order[0]
		r.order = r.order[1:]
		if r.flows[fl.key] == fl {
			r.drop(fl)
			return
		}
	}
}

func (r *udpRelay) open() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.flows) }

func (f *Forwards) serveUDP(r *udpRelay, pc net.PacketConn, target *net.UDPAddr) {
	maxFlows, idle, maxDatagram := UDPMaxFlows, UDPIdle, UDPMaxDatagram // fixed for this socket's life
	stop := make(chan struct{})
	defer func() {
		close(stop)
		r.mu.Lock()
		for _, fl := range r.flows {
			r.drop(fl)
		}
		r.order = nil
		r.mu.Unlock()
	}()
	go func() {
		t := time.NewTicker(idle / 3)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				now := time.Now().UnixNano()
				r.mu.Lock()
				for _, fl := range r.flows {
					if now-fl.last.Load() > int64(idle) {
						r.drop(fl)
					}
				}
				live := r.order[:0]
				for _, fl := range r.order {
					if r.flows[fl.key] == fl {
						live = append(live, fl)
					}
				}
				r.order = live
				r.mu.Unlock()
			}
		}
	}()
	buf := make([]byte, maxDatagram+1)
	for {
		n, from, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		if n > maxDatagram {
			continue
		}
		key := from.String()
		r.mu.Lock()
		fl := r.flows[key]
		if fl == nil {
			if len(r.flows) >= maxFlows {
				r.evictOldest()
			}
			c, err := net.DialUDP("udp", nil, target)
			if err != nil {
				r.mu.Unlock()
				continue
			}
			fl = &udpFlow{key: key, c: c, born: time.Now().UnixNano()}
			r.flows[key] = fl
			r.order = append(r.order, fl)
			go func(fl *udpFlow, from net.Addr) {
				b := make([]byte, maxDatagram+1)
				m, err := fl.c.Read(b)
				if err == nil && m <= maxDatagram {
					if _, err := pc.WriteTo(b[:m], from); err == nil {
						f.count(0, int64(m))
					}
				}
				// one exchange: the answer (or a read error, e.g. the flow was evicted or expired) ends the flow
				r.mu.Lock()
				r.drop(fl)
				r.mu.Unlock()
			}(fl, from)
		}
		fl.last.Store(time.Now().UnixNano())
		r.mu.Unlock()
		if _, err := fl.c.Write(buf[:n]); err == nil {
			f.count(int64(n), 0)
		}
	}
}

// udpListeners is the number of UDP ingress sockets still open (tests).
func (f *Forwards) udpListeners() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.pcs) }

// udpFlows is the number of open flows of every UDP ingress (tests).
func (f *Forwards) udpFlows() int {
	f.mu.Lock()
	rs := append([]*udpRelay(nil), f.relays...)
	f.mu.Unlock()
	n := 0
	for _, r := range rs {
		n += r.open()
	}
	return n
}
