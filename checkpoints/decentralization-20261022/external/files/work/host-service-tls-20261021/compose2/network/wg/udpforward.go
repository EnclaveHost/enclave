package wg

import (
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"
)

// UDP ingress bounds: flows (senders) at once, a flow's idle lifetime, the largest datagram relayed either way.
// Variables only so tests can shrink them.
var (
	UDPMaxFlows    = 1024
	UDPIdle        = 30 * time.Second
	UDPMaxDatagram = 4096
)

type udpFlow struct {
	c    *net.UDPConn
	last atomic.Int64
}

// UDPIngress accepts datagrams on the tunnel address and port (DNS that the exit forwards, as packets, to a host's
// route-dns role) and relays each to ONE fixed loopback address, and the answers back to their sender. Each sender is a
// flow with its own connected loopback socket (so only the target's answers come back); at most UDPMaxFlows flows, each
// closed after UDPIdle without traffic; a datagram over UDPMaxDatagram is dropped. It never takes a destination from a
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
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		pc.Close()
		return net.ErrClosed
	}
	f.pcs = append(f.pcs, pc)
	f.mu.Unlock()
	go f.serveUDP(pc, net.UDPAddrFromAddrPort(target))
	return nil
}

func (f *Forwards) serveUDP(pc net.PacketConn, target *net.UDPAddr) {
	maxFlows, idle, maxDatagram := UDPMaxFlows, UDPIdle, UDPMaxDatagram // fixed for this socket's life
	var mu sync.Mutex
	flows := map[string]*udpFlow{}
	stop := make(chan struct{})
	defer func() {
		close(stop)
		mu.Lock()
		for k, fl := range flows {
			fl.c.Close()
			delete(flows, k)
		}
		mu.Unlock()
	}()
	go func() {
		t := time.NewTicker(idle / 6)
		defer t.Stop()
		for {
			select {
			case <-stop:
				return
			case <-t.C:
				now := time.Now().UnixNano()
				mu.Lock()
				for k, fl := range flows {
					if now-fl.last.Load() > int64(idle) {
						fl.c.Close()
						delete(flows, k)
					}
				}
				mu.Unlock()
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
		mu.Lock()
		fl := flows[key]
		if fl == nil {
			if len(flows) >= maxFlows {
				mu.Unlock()
				continue
			}
			c, err := net.DialUDP("udp", nil, target)
			if err != nil {
				mu.Unlock()
				continue
			}
			fl = &udpFlow{c: c}
			flows[key] = fl
			go func(fl *udpFlow, from net.Addr) {
				b := make([]byte, maxDatagram+1)
				for {
					m, err := fl.c.Read(b)
					if err != nil {
						return
					}
					if m > maxDatagram {
						continue
					}
					fl.last.Store(time.Now().UnixNano())
					if _, err := pc.WriteTo(b[:m], from); err == nil {
						f.count(0, int64(m))
					}
				}
			}(fl, from)
		}
		fl.last.Store(time.Now().UnixNano())
		mu.Unlock()
		if _, err := fl.c.Write(buf[:n]); err == nil {
			f.count(int64(n), 0)
		}
	}
}

// udpListeners is the number of UDP ingress sockets still open (tests).
func (f *Forwards) udpListeners() int { f.mu.Lock(); defer f.mu.Unlock(); return len(f.pcs) }
