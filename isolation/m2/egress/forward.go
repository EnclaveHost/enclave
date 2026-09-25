package egress

// The wire between the guest's forwarder and the host's egress server (vsock in a guest, any stream in tests):
//
//	guest -> host:  "egress-v1 <host> 443\n"      the LISTENER's bound origin, never bytes the tenant sent
//	host  -> guest: "ok\n" | "refused\n"          then, after ok, raw bytes both ways (the tenant's TLS, end to end)
//
// The tenant never speaks this protocol: it connects to a loopback address that /etc/hosts gave an allowed name,
// the listener there already knows its one origin, and whatever the tenant writes is payload after the header.

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/netip"
	"strings"
	"sync"
	"time"
)

const (
	protoVersion = "egress-v1"
	maxHeader    = 300
)

// ---- guest side ----

// Forwarder runs one loopback listener per allowed origin.
type Forwarder struct {
	Policy *Policy
	Port   int                      // 443 in a guest; a free port in tests
	Upstream func() (net.Conn, error) // a new stream to the host's egress server (vsock to the host CID in a guest)
	Logf   func(string, ...any)       // the guest's own log; never a URL or header, only the origin's index and outcome

	mu    sync.Mutex
	ls    []net.Listener
	addrs map[string]netip.Addr // host -> its loopback address
}

// loopbackFor gives origin i its own address in 127.64.0.0/16 (127/8 is all loopback on Linux).
func loopbackFor(i int) netip.Addr {
	return netip.AddrFrom4([4]byte{127, 64, byte((i + 1) / 250), byte((i+1)%250 + 1)})
}

// HostsFile is /etc/hosts for the guest: ONLY the allowed names, each on its own loopback address, so an unlisted
// name does not resolve at all (the guest has no other resolver).
func (f *Forwarder) HostsFile() string {
	var b strings.Builder
	b.WriteString("127.0.0.1 localhost\n")
	for i, o := range f.Policy.Origins {
		fmt.Fprintf(&b, "%s %s\n", loopbackFor(i), o.Host)
	}
	return b.String()
}

// Start binds every listener and serves until ctx ends. A bind failure is fatal: a guest that could not enforce its
// allowlist must not start the tenant.
func (f *Forwarder) Start(ctx context.Context) error {
	f.addrs = map[string]netip.Addr{}
	for i, o := range f.Policy.Origins {
		a := loopbackFor(i)
		l, err := net.Listen("tcp", netip.AddrPortFrom(a, uint16(f.Port)).String())
		if err != nil {
			f.Close()
			return fmt.Errorf("egress listener %d: %w", i, err)
		}
		f.mu.Lock()
		f.ls = append(f.ls, l)
		f.addrs[o.Host] = a
		f.mu.Unlock()
		go f.serve(ctx, l, i, o)
	}
	go func() { <-ctx.Done(); f.Close() }()
	return nil
}

// Addr is where the tenant reaches an origin (what /etc/hosts says), for tests and the guest's self-check.
func (f *Forwarder) Addr(host string) (netip.AddrPort, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.addrs[host]
	return netip.AddrPortFrom(a, uint16(f.Port)), ok
}

func (f *Forwarder) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, l := range f.ls {
		l.Close()
	}
	f.ls = nil
}

func (f *Forwarder) serve(ctx context.Context, l net.Listener, idx int, o Origin) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		go f.forward(c, idx, o)
	}
}

func (f *Forwarder) forward(tenant net.Conn, idx int, o Origin) {
	defer tenant.Close()
	up, err := f.Upstream()
	if err != nil {
		f.logf("egress origin #%d: no path to the host", idx)
		return
	}
	defer up.Close()
	up.SetDeadline(time.Now().Add(15 * time.Second))
	// the target is THIS listener's origin; nothing the tenant has sent has been read yet
	if _, err := fmt.Fprintf(up, "%s %s 443\n", protoVersion, o.Host); err != nil {
		return
	}
	br := bufio.NewReaderSize(up, 64)
	line, err := br.ReadString('\n')
	if err != nil || line != "ok\n" {
		f.logf("egress origin #%d: refused by the host", idx)
		return
	}
	up.SetDeadline(time.Time{})
	splice(tenant, tenant, up, br) // br holds anything the host sent after "ok"
}

func (f *Forwarder) logf(format string, a ...any) {
	if f.Logf != nil {
		f.Logf(format, a...)
	}
}

// ---- host side ----

// Server is the host's egress endpoint: one per host, serving every guest; `cidOf` says which guest a stream is
// from (the vsock peer CID), so the dialer's per-guest caps apply.
type Server struct {
	Dialer *Dialer
	CIDOf  func(net.Conn) uint32
	Log    *log.Logger // hostname:port, guest CID and outcome only - the host never sees more
}

func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	go func() { <-ctx.Done(); l.Close() }()
	for {
		c, err := l.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go s.handle(ctx, c)
	}
}

func (s *Server) handle(ctx context.Context, g net.Conn) {
	defer g.Close()
	cid := uint32(0)
	if s.CIDOf != nil {
		cid = s.CIDOf(g)
	}
	g.SetReadDeadline(time.Now().Add(10 * time.Second))
	br := bufio.NewReaderSize(g, maxHeader)
	line, err := readLine(br, maxHeader)
	if err != nil {
		return
	}
	g.SetReadDeadline(time.Time{})
	f := strings.Fields(line)
	if len(f) != 3 || f[0] != protoVersion || f[2] != "443" {
		io.WriteString(g, "refused\n")
		return
	}
	dctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	up, release, err := s.Dialer.Dial(dctx, cid, f[1], 443)
	cancel()
	if err != nil {
		s.logf("guest %d -> %s:443 refused: %v", cid, f[1], err)
		io.WriteString(g, "refused\n")
		return
	}
	defer release()
	defer up.Close()
	s.logf("guest %d -> %s:443 open", cid, f[1])
	if _, err := io.WriteString(g, "ok\n"); err != nil {
		return
	}
	splice(g, br, up, up) // br holds anything the guest sent after its header
}

func (s *Server) logf(format string, a ...any) {
	if s.Log != nil {
		s.Log.Printf(format, a...)
	}
}

func readLine(br *bufio.Reader, max int) (string, error) {
	var b strings.Builder
	for b.Len() < max {
		c, err := br.ReadByte()
		if err != nil {
			return "", err
		}
		if c == '\n' {
			return b.String(), nil
		}
		b.WriteByte(c)
	}
	return "", errors.New("header too long")
}

// splice copies both ways until either side ends. Each side has its own reader (ar reads a, br reads b), so bytes
// a bufio.Reader already buffered from one side are delivered to the OTHER side, never echoed back.
func splice(a net.Conn, ar io.Reader, b net.Conn, br io.Reader) {
	done := make(chan struct{}, 2)
	go func() { io.Copy(b, ar); closeWrite(b); done <- struct{}{} }()
	go func() { io.Copy(a, br); closeWrite(a); done <- struct{}{} }()
	<-done
	<-done
}

func closeWrite(c net.Conn) {
	if cw, ok := c.(interface{ CloseWrite() error }); ok {
		cw.CloseWrite()
		return
	}
	c.Close()
}
