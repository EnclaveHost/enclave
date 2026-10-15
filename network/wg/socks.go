package wg

import (
	"context"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"strconv"
	"sync"
	"time"
)

// Tunnel is what the SOCKS server needs from a data plane: dial a judged address, and resolve a name through the
// tunnel's own resolver (never the host's).
type Tunnel interface {
	DialTCP(ctx context.Context, to netip.AddrPort) (net.Conn, error)
	Resolve(ctx context.Context, host string) ([]netip.Addr, error)
}

// Socks is an RFC 1928 CONNECT-only server with RFC 1929 username/password authentication. It listens on loopback
// only; every destination is judged by Policy before it is dialed, and a name is dialed only as a judged literal.
type Socks struct {
	User, Pass string
	Tunnel     Tunnel
	Policy     Policy
	MaxConns   int
	Count      func(up, down int64) // optional byte meter
	OnConn     func(map[string]any) // optional: a big connection's summary when it ends (connwatch.go)
	mu         sync.Mutex
	conns      map[net.Conn]struct{}
	closed     bool
}

const (
	repOK          = 0
	repFailure     = 1
	repNotAllowed  = 2
	repHostUnreach = 4
	repRefused     = 5
	repCmd         = 7
	repAddr        = 8
)

// Serve accepts until l is closed.
func (s *Socks) Serve(l net.Listener) error {
	s.mu.Lock()
	if s.conns == nil {
		s.conns = map[net.Conn]struct{}{}
	}
	s.mu.Unlock()
	for {
		c, err := l.Accept()
		if err != nil {
			return err
		}
		s.mu.Lock()
		max := s.MaxConns
		if max <= 0 {
			max = 1024
		}
		if s.closed || len(s.conns) >= max {
			s.mu.Unlock()
			c.Close()
			continue
		}
		s.conns[c] = struct{}{}
		s.mu.Unlock()
		go func() {
			s.handle(c)
			s.mu.Lock()
			delete(s.conns, c)
			s.mu.Unlock()
		}()
	}
}

// CloseAll cuts every open connection and refuses new ones (circuit closing).
func (s *Socks) CloseAll() {
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.Cut()
}

// Cut closes every open connection but keeps accepting (admission lapsed: the runtime's gate refuses new ones).
func (s *Socks) Cut() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for c := range s.conns {
		c.Close()
	}
}

func (s *Socks) handle(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(c, h[:]); err != nil || h[0] != 5 || h[1] == 0 {
		return
	}
	methods := make([]byte, h[1])
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	want := byte(2)
	if s.User == "" && s.Pass == "" {
		want = 0 // an unauthenticated loopback entry, reachable only as the host firewall allows (TUNA's model)
	}
	ok := false
	for _, m := range methods {
		if m == want {
			ok = true
		}
	}
	if !ok {
		c.Write([]byte{5, 0xff})
		return
	}
	c.Write([]byte{5, want})
	if want == 2 && !s.auth(c) {
		return
	}
	var req [4]byte
	if _, err := io.ReadFull(c, req[:]); err != nil || req[0] != 5 {
		return
	}
	if req[1] != 1 {
		reply(c, repCmd)
		return
	}
	host, port, err := readAddr(c, req[3])
	if err != nil {
		reply(c, repAddr)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	up, code := s.dial(ctx, host, port)
	if up == nil {
		reply(c, code)
		return
	}
	defer up.Close()
	if err := reply(c, repOK); err != nil {
		return
	}
	c.SetDeadline(time.Time{})
	s.splice(c, up)
}

func (s *Socks) auth(c net.Conn) bool {
	var v [2]byte
	if _, err := io.ReadFull(c, v[:]); err != nil || v[0] != 1 {
		return false
	}
	user := make([]byte, v[1])
	if _, err := io.ReadFull(c, user); err != nil {
		return false
	}
	var pl [1]byte
	if _, err := io.ReadFull(c, pl[:]); err != nil {
		return false
	}
	pass := make([]byte, pl[0])
	if _, err := io.ReadFull(c, pass); err != nil {
		return false
	}
	good := s.User != "" && s.Pass != "" && len(user) > 0 &&
		subtle.ConstantTimeCompare(user, []byte(s.User)) == 1 && subtle.ConstantTimeCompare(pass, []byte(s.Pass)) == 1
	if !good {
		c.Write([]byte{1, 1})
		return false
	}
	_, err := c.Write([]byte{1, 0})
	return err == nil
}

func readAddr(c net.Conn, atyp byte) (string, int, error) {
	var host string
	switch atyp {
	case 1:
		var b [4]byte
		if _, err := io.ReadFull(c, b[:]); err != nil {
			return "", 0, err
		}
		host = netip.AddrFrom4(b).String()
	case 4:
		var b [16]byte
		if _, err := io.ReadFull(c, b[:]); err != nil {
			return "", 0, err
		}
		host = netip.AddrFrom16(b).String()
	case 3:
		var l [1]byte
		if _, err := io.ReadFull(c, l[:]); err != nil || l[0] == 0 {
			return "", 0, errors.New("bad name")
		}
		b := make([]byte, l[0])
		if _, err := io.ReadFull(c, b); err != nil {
			return "", 0, err
		}
		host = string(b)
	default:
		return "", 0, errors.New("bad address type")
	}
	var p [2]byte
	if _, err := io.ReadFull(c, p[:]); err != nil {
		return "", 0, err
	}
	return host, int(binary.BigEndian.Uint16(p[:])), nil
}

func (s *Socks) dial(ctx context.Context, host string, port int) (net.Conn, byte) {
	var addrs []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addrs = []netip.Addr{a}
	} else {
		if len(host) > 253 {
			return nil, repAddr
		}
		r, err := s.Tunnel.Resolve(ctx, host)
		if err != nil || len(r) == 0 {
			return nil, repHostUnreach
		}
		addrs = r
	}
	code := byte(repNotAllowed)
	for _, a := range addrs {
		if s.Policy.Judge(a, port) != nil {
			continue
		}
		up, err := s.Tunnel.DialTCP(ctx, netip.AddrPortFrom(a.Unmap(), uint16(port)))
		if err == nil {
			return up, 0
		}
		code = repRefused
		if ctx.Err() != nil {
			code = repHostUnreach
			break
		}
	}
	return nil, code
}

func reply(c net.Conn, code byte) error {
	_, err := c.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0})
	return err
}

func (s *Socks) splice(a, b net.Conn) {
	w := watchConn(tcpEndpoint(b))
	done := make(chan struct{}, 2)
	go func() { copyCounted(b, a, func(n int64) { s.count(n, 0); w.up.Add(n) }); done <- struct{}{} }()
	go func() { copyCounted(a, b, func(n int64) { s.count(0, n); w.down.Add(n) }); done <- struct{}{} }()
	<-done
	<-done
	if r := w.report(); r != nil && s.OnConn != nil {
		s.OnConn(r)
	}
}

func (s *Socks) count(up, down int64) {
	if s.Count != nil {
		s.Count(up, down)
	}
}

// copyCounted copies src to dst, reporting every chunk as it passes (a meter must see bytes as they move, not
// when the connection ends), then half-closes dst.
func copyCounted(dst, src net.Conn, count func(int64)) {
	buf := make([]byte, 32*1024)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				break
			}
			count(int64(n))
		}
		if err != nil {
			break
		}
	}
	if cw, ok := dst.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
	} else {
		dst.Close()
	}
}

// HostPort formats a judged destination for logs without names.
func HostPort(a netip.Addr, port int) string { return net.JoinHostPort(a.String(), strconv.Itoa(port)) }
