package wg

import (
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// UDP ingress bounds: flows (senders) at once, how long an UNANSWERED flow lives, the largest datagram relayed in, and
// the largest answer returned as one datagram. A flow lives while it has queries outstanding: it closes as soon as every
// query written into it has its answer relayed (a stub's A and AAAA from one port both get theirs - final review N1), so
// a resolver that answers keeps the table near empty. When the table is full the OLDEST flow is evicted rather than the
// new one refused: a burst of distinct source ports (the exit masquerades, so every query is a new sender) can delay only
// itself, never lock out a later query (hs-transport review B4). Variables only so tests can shrink them.
var (
	UDPMaxFlows    = 1024
	UDPIdle        = 3 * time.Second
	UDPMaxDatagram = 4096
	UDPMaxReply    = 1232 // the most any answer datagram may carry (the DNS flag-day EDNS size)
)

// UDPPlainReply is the RFC 1035 limit for a client that sent no EDNS OPT record.
const UDPPlainReply = 512

// queryLimit is the largest answer the sender of query q accepts in one datagram: 512 without EDNS, else the payload size
// its OPT record advertises, clamped to [512, max]. A longer answer goes back truncated (TC); the client retries on TCP.
func queryLimit(q []byte, max int) int {
	if len(q) < 12 {
		return UDPPlainReply
	}
	qd, rest := int(binary.BigEndian.Uint16(q[4:6])), int(binary.BigEndian.Uint16(q[6:8]))+int(binary.BigEndian.Uint16(q[8:10]))
	ar := int(binary.BigEndian.Uint16(q[10:12]))
	i := 12
	skipName := func() bool {
		for {
			if i >= len(q) {
				return false
			}
			l := int(q[i])
			if l == 0 {
				i++
				return true
			}
			if l&0xc0 == 0xc0 {
				i += 2
				return i <= len(q)
			}
			i += 1 + l
		}
	}
	for k := 0; k < qd; k++ {
		if !skipName() {
			return UDPPlainReply
		}
		i += 4
	}
	for k := 0; k < rest+ar; k++ {
		if !skipName() || i+10 > len(q) {
			return UDPPlainReply
		}
		typ, class, rdlen := binary.BigEndian.Uint16(q[i:]), int(binary.BigEndian.Uint16(q[i+2:])), int(binary.BigEndian.Uint16(q[i+8:]))
		if typ == 41 && k >= rest { // OPT: its CLASS is the requestor's UDP payload size
			if class < UDPPlainReply {
				return UDPPlainReply
			}
			if class > max {
				return max
			}
			return class
		}
		i += 10 + rdlen
	}
	return UDPPlainReply
}

type udpFlow struct {
	key      string
	c        net.Conn // the flow's own loopback TCP connection to the DNS role
	last     atomic.Int64
	pending  int            // queries written into this flow (guarded by udpRelay.mu)
	answered int            // answers relayed back (guarded by udpRelay.mu)
	limits   map[uint16]int // DNS id -> that query's answer size limit (guarded by udpRelay.mu)
}

type udpRelay struct {
	mu    sync.Mutex
	flows map[string]*udpFlow
	order []*udpFlow // oldest first (eviction); entries of closed flows are skipped lazily
}

// UDPIngress accepts DNS datagrams on the tunnel address and port (DNS that the exit forwards, as packets, to a host's
// route-dns role) and relays each to ONE fixed loopback DNS server over TCP: the datagram is framed as RFC 1035 4.2.2 DNS
// over TCP (a two-byte length), the framed answer is returned to its sender as one datagram. Over TCP because a Windows
// circuit sandbox grants enclave-wg exact LOOPBACK TCP ports only (enclave-circuit-firewall: UDP is for its WireGuard
// peers), and route-dns answers TCP on the same port. Each sender is a flow with its own loopback connection; it never
// takes a destination from a sender, and nothing but the target is reachable through it.
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
	go f.serveUDP(r, pc, target.String())
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

// truncate returns an answer that fits one datagram: as it is, or (longer than max) its header with TC set and no
// records, plus its question section, so the client asks again over TCP. nil when the answer cannot be read as DNS.
func truncate(a []byte, max int) []byte {
	if len(a) <= max {
		return a
	}
	if len(a) < 12 {
		return nil
	}
	qd := int(binary.BigEndian.Uint16(a[4:6]))
	i := 12
	for q := 0; q < qd; q++ {
		for {
			if i >= len(a) {
				return nil
			}
			l := int(a[i])
			if l == 0 {
				i++
				break
			}
			if l&0xc0 == 0xc0 {
				i += 2
				break
			}
			i += 1 + l
		}
		i += 4
		if i > len(a) || i > max {
			return nil
		}
	}
	out := append([]byte(nil), a[:i]...)
	out[2] |= 0x02 // TC
	for _, o := range []int{6, 8, 10} {
		out[o], out[o+1] = 0, 0
	}
	return out
}

func (f *Forwards) serveUDP(r *udpRelay, pc net.PacketConn, target string) {
	maxFlows, idle, maxDatagram, maxReply := UDPMaxFlows, UDPIdle, UDPMaxDatagram, UDPMaxReply // fixed for this socket's life
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
		if n > maxDatagram || n < 12 {
			continue
		}
		key := from.String()
		r.mu.Lock()
		fl := r.flows[key]
		if fl == nil {
			if len(r.flows) >= maxFlows {
				r.evictOldest()
			}
			c, err := net.DialTimeout("tcp", target, time.Second)
			if err != nil {
				r.mu.Unlock()
				continue
			}
			fl = &udpFlow{key: key, c: c, limits: map[uint16]int{}}
			r.flows[key] = fl
			r.order = append(r.order, fl)
			go func(fl *udpFlow, from net.Addr) {
				// every framed answer goes back as one datagram; the flow ends when all its queries are answered, or on an
				// error (it was evicted, expired or refused)
				defer func() { r.mu.Lock(); r.drop(fl); r.mu.Unlock() }()
				for {
					var l [2]byte
					if _, err := io.ReadFull(fl.c, l[:]); err != nil {
						return
					}
					size := int(binary.BigEndian.Uint16(l[:]))
					a := make([]byte, size)
					if _, err := io.ReadFull(fl.c, a); err != nil {
						return
					}
					limit := UDPPlainReply
					if size >= 2 {
						r.mu.Lock()
						if l, ok := fl.limits[binary.BigEndian.Uint16(a)]; ok {
							limit = l
							delete(fl.limits, binary.BigEndian.Uint16(a))
						}
						r.mu.Unlock()
					}
					if out := truncate(a, limit); size >= 12 && out != nil {
						if _, err := pc.WriteTo(out, from); err == nil {
							f.count(0, int64(len(out)))
						}
					}
					fl.last.Store(time.Now().UnixNano())
					r.mu.Lock()
					fl.answered++
					done := fl.answered >= fl.pending
					r.mu.Unlock()
					if done {
						return
					}
				}
			}(fl, from)
		}
		// counted and written under the lock: a flow can be neither dropped nor evicted between the two, and the reader
		// never ends it with this query outstanding
		framed := make([]byte, 2+n)
		binary.BigEndian.PutUint16(framed, uint16(n))
		copy(framed[2:], buf[:n])
		fl.last.Store(time.Now().UnixNano())
		fl.pending++
		if len(fl.limits) < 64 {
			fl.limits[binary.BigEndian.Uint16(buf[:2])] = queryLimit(buf[:n], maxReply)
		}
		fl.c.SetWriteDeadline(time.Now().Add(time.Second))
		if _, err := fl.c.Write(framed); err == nil {
			f.count(int64(n), 0)
		} else {
			r.drop(fl)
		}
		r.mu.Unlock()
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
