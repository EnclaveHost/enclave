package egress

// Public HTTPS is an explicit owner capability. SOCKS carries the destination
// name from wasi:http to the guest's front without needing external DNS in the
// guest. TLS remains in the runtime; this listener never handles plaintext HTTP
// or terminates TLS. The existing host dialer judges DNS answers and the peer.
import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"net/netip"
	"time"
)

const PublicSOCKSAddress = "127.0.0.2:1080"

func (f *Forwarder) PublicAddr() (netip.AddrPort, bool) {
	return f.publicAddr, f.publicAddr.IsValid()
}

func (f *Forwarder) startPublic(ctx context.Context) error {
	addr := f.PublicListen
	if addr == "" {
		addr = PublicSOCKSAddress
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return errors.New("public HTTPS listener unavailable")
	}
	f.publicAddr = l.Addr().(*net.TCPAddr).AddrPort()
	f.publicSlots = make(chan struct{}, 32)
	f.ls = append(f.ls, l)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			select {
			case f.publicSlots <- struct{}{}:
				go func() {
					defer func() { <-f.publicSlots }()
					stop := context.AfterFunc(ctx, func() { c.Close() })
					defer stop()
					f.publicConnect(c)
				}()
			default:
				c.Close()
			}
		}
	}()
	return nil
}

// Only SOCKS5 user/password and CONNECT with a DNS name on port 443 are
// accepted. Literals, UDP, bind, other ports, invalid names and malformed
// handshakes never open an upstream connection. All pre-connect reads are
// bounded. The constant credential is framing, not authentication.
func (f *Forwarder) publicConnect(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(15 * time.Second))
	var h [2]byte
	if _, err := io.ReadFull(c, h[:]); err != nil || h[0] != 5 || h[1] == 0 {
		return
	}
	methods := make([]byte, int(h[1]))
	if _, err := io.ReadFull(c, methods); err != nil {
		return
	}
	auth := false
	for _, m := range methods {
		if m == 2 {
			auth = true
		}
	}
	if !auth {
		c.Write([]byte{5, 255})
		return
	}
	if _, err := c.Write([]byte{5, 2}); err != nil {
		return
	}
	if _, err := io.ReadFull(c, h[:]); err != nil || h[0] != 1 {
		return
	}
	user := make([]byte, int(h[1]))
	if _, err := io.ReadFull(c, user); err != nil {
		return
	}
	var n [1]byte
	if _, err := io.ReadFull(c, n[:]); err != nil {
		return
	}
	pass := make([]byte, int(n[0]))
	if _, err := io.ReadFull(c, pass); err != nil {
		return
	}
	if string(user) != "guest" || string(pass) != "public-https" {
		c.Write([]byte{1, 1})
		return
	}
	if _, err := c.Write([]byte{1, 0}); err != nil {
		return
	}
	reply := func(code byte) { c.Write([]byte{5, code, 0, 1, 0, 0, 0, 0, 0, 0}) }
	var req [4]byte
	if _, err := io.ReadFull(c, req[:]); err != nil {
		return
	}
	if req != [4]byte{5, 1, 0, 3} {
		reply(2)
		return
	}
	if _, err := io.ReadFull(c, n[:]); err != nil || n[0] == 0 {
		reply(2)
		return
	}
	host := make([]byte, int(n[0]))
	if _, err := io.ReadFull(c, host); err != nil {
		return
	}
	if _, err := io.ReadFull(c, h[:]); err != nil {
		return
	}
	if binary.BigEndian.Uint16(h[:]) != 443 {
		reply(2)
		return
	}
	// ParseOrigin also refuses IP-like spellings and control characters.
	// Require the whole SOCKS string to be the host (no injected path/userinfo).
	o, err := ParseOrigin("https://" + string(host))
	if err != nil || !equalHost(o.Host, string(host)) || !f.Policy.PublicHTTPS {
		reply(2)
		return
	}
	up, err := DialOrigin(f.Upstream, o)
	if err != nil {
		f.logf("public HTTPS: %s", dialClass(err))
		reply(2)
		return
	}
	defer up.Close()
	reply(0)
	c.SetDeadline(time.Time{})
	splice(c, c, up, up)
}

func equalHost(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		c := b[i]
		if c >= 'A' && c <= 'Z' {
			c += 'a' - 'A'
		}
		if a[i] != c {
			return false
		}
	}
	return true
}
