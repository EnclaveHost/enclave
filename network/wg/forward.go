package wg

import (
	"context"
	"net"
	"net/netip"
	"sync"
	"time"
)

// Forwards relays whole TCP connections and can cut them all at once (admission lost, tunnel down).
type Forwards struct {
	mu     sync.Mutex
	conns  map[net.Conn]struct{}
	ls     []net.Listener
	closed bool
	Count  func(in, out int64) // in = toward the app, out = from the app
}

func (f *Forwards) track(c net.Conn) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed || len(f.conns) >= 4096 {
		return false
	}
	if f.conns == nil {
		f.conns = map[net.Conn]struct{}{}
	}
	f.conns[c] = struct{}{}
	return true
}
func (f *Forwards) untrack(c net.Conn) { f.mu.Lock(); delete(f.conns, c); f.mu.Unlock() }
func (f *Forwards) listener(l net.Listener) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		l.Close()
		return false
	}
	f.ls = append(f.ls, l)
	return true
}

// Close stops every listener and cuts every connection.
func (f *Forwards) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	for _, l := range f.ls {
		l.Close()
	}
	for c := range f.conns {
		c.Close()
	}
}

// Cut closes every open connection but keeps the listeners.
func (f *Forwards) Cut() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for c := range f.conns {
		c.Close()
	}
}

func (f *Forwards) count(in, out int64) {
	if f.Count != nil {
		f.Count(in, out)
	}
}

// Ingress accepts on the tunnel address and port (public visitors arriving from the exit's SNI router) and relays
// each connection, still TLS ciphertext, to the circuit's local ingress worker.
func (f *Forwards) Ingress(d *Device, port uint16, to string) error {
	addr, _ := d.Local(false)
	l, err := d.Net.ListenTCPAddrPort(netip.AddrPortFrom(addr, port))
	if err != nil {
		return err
	}
	if !f.listener(l) {
		return net.ErrClosed
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go f.relay(c, func(ctx context.Context) (net.Conn, error) {
				var dl net.Dialer
				return dl.DialContext(ctx, "tcp", to)
			}, true)
		}
	}()
	return nil
}

// Local listens on loopback and relays each connection through the tunnel to one fixed address (the exit's control
// port, reached through the guard). It never takes a destination from the client.
func (f *Forwards) Local(d *Device, to netip.AddrPort, listen string) (string, error) {
	l, err := net.Listen("tcp", listen)
	if err != nil {
		return "", err
	}
	if !f.listener(l) {
		return "", net.ErrClosed
	}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go f.relay(c, func(ctx context.Context) (net.Conn, error) { return d.DialTCP(ctx, to) }, false)
		}
	}()
	return l.Addr().String(), nil
}

func (f *Forwards) relay(c net.Conn, dial func(context.Context) (net.Conn, error), inbound bool) {
	if !f.track(c) {
		c.Close()
		return
	}
	defer f.untrack(c)
	defer c.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	up, err := dial(ctx)
	cancel()
	if err != nil {
		return
	}
	if !f.track(up) {
		up.Close()
		return
	}
	defer f.untrack(up)
	defer up.Close()
	done := make(chan struct{}, 2)
	go func() {
		copyCounted(up, c, func(n int64) {
			if inbound {
				f.count(n, 0)
			} else {
				f.count(0, n)
			}
		})
		done <- struct{}{}
	}()
	go func() {
		copyCounted(c, up, func(n int64) {
			if inbound {
				f.count(0, n)
			} else {
				f.count(n, 0)
			}
		})
		done <- struct{}{}
	}()
	<-done
	<-done
}
