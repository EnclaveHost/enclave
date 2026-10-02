package egress

// PublicWeb is an owner-selected extension of the HTTPS-only capability. The
// guest still has no NIC. A TCP DNS listener supplies only public addresses,
// and its SOCKS listener permits only HTTP and HTTPS. The host checks names,
// every DNS answer, and the final destination; it never receives TLS keys.
import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
)

const PublicDNSAddress = "127.0.0.2:53"

func validWebHost(host string, allowIP bool) bool {
	if a, err := netip.ParseAddr(host); err == nil {
		return allowIP && RefuseAddr(a, nil) == ""
	}
	o, err := ParseOrigin("https://" + host)
	return err == nil && equalHost(o.Host, host)
}

func (d *Dialer) publicAddresses(ctx context.Context, host string, allowIP bool) ([]netip.Addr, error) {
	if !validWebHost(host, allowIP) {
		return nil, refused(ReasonName)
	}
	var addresses []netip.Addr
	if a, err := netip.ParseAddr(host); err == nil {
		addresses = []netip.Addr{a}
	} else {
		var err error
		if d.Resolver == nil {
			return nil, refused(ReasonResolve)
		}
		addresses, err = d.Resolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(addresses) == 0 {
			return nil, refused(ReasonResolve)
		}
	}
	var own []netip.Addr
	if d.Own != nil {
		own = d.Own()
	}
	for _, a := range addresses {
		if RefuseAddr(a, own) != "" {
			return nil, refused(ReasonNonPublicAnswer)
		}
	}
	return addresses, nil
}

func (d *Dialer) ResolvePublic(ctx context.Context, cid uint32, host string) ([]netip.Addr, error) {
	release, err := d.take(cid)
	if err != nil {
		return nil, err
	}
	defer release()
	var addresses []netip.Addr
	if d.RouteFor != nil {
		var route AppRoute
		route, err = d.appRoute(cid)
		if err != nil {
			return nil, err
		}
		addresses, err = d.resolveAppRoute(ctx, route, host)
	} else {
		addresses, err = d.publicAddresses(ctx, host, false)
	}
	if len(addresses) > 16 {
		addresses = addresses[:16]
	}
	return addresses, err
}

func (d *Dialer) DialWeb(ctx context.Context, cid uint32, host string, port int) (net.Conn, func(), error) {
	if port != 80 && port != 443 {
		return nil, nil, refused(ReasonPort)
	}
	if !validWebHost(host, true) {
		return nil, nil, refused(ReasonName)
	}
	return d.dialPublic(ctx, cid, host, port, true)
}

func (s *Server) handleWeb(ctx context.Context, cid uint32, g net.Conn, br *bufio.Reader, fields []string) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if fields[0] == "egress-dns-v1" && fields[2] == "0" {
		addresses, err := s.Dialer.ResolvePublic(ctx, cid, fields[1])
		if err != nil {
			s.outcome(cid, "refused:"+string(ReasonOf(err)))
			io.WriteString(g, "refused\n")
			return
		}
		var names []string
		for _, a := range addresses {
			names = append(names, a.Unmap().String())
		}
		s.outcome(cid, "resolved")
		fmt.Fprintf(g, "ok %s\n", strings.Join(names, " "))
		return
	}
	port, err := strconv.Atoi(fields[2])
	if fields[0] != "egress-web-v1" || err != nil || (port != 80 && port != 443) {
		s.outcome(cid, "refused:"+string(ReasonHeader))
		io.WriteString(g, "refused\n")
		return
	}
	up, release, err := s.Dialer.DialWeb(ctx, cid, fields[1], port)
	if err != nil {
		s.outcome(cid, "refused:"+string(ReasonOf(err)))
		io.WriteString(g, "refused\n")
		return
	}
	defer release()
	defer up.Close()
	s.outcome(cid, "open")
	if _, err := io.WriteString(g, "ok\n"); err != nil {
		return
	}
	splice(g, br, up, up)
}

func dialPublicWeb(upstream func() (net.Conn, error), host string, port uint16) (net.Conn, error) {
	if (port != 80 && port != 443) || !validWebHost(host, true) {
		return nil, errRefused
	}
	up, err := upstream()
	if err != nil {
		return nil, errNoPath
	}
	up.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := fmt.Fprintf(up, "egress-web-v1 %s %d\n", host, port); err != nil {
		up.Close()
		return nil, errPathFailed
	}
	br := bufio.NewReaderSize(up, 64)
	line, err := readLine(br, 64)
	if err != nil || line != "ok" {
		up.Close()
		return nil, errRefused
	}
	up.SetDeadline(time.Time{})
	return &bufConn{Conn: up, r: br}, nil
}

func readSOCKSTarget(c net.Conn, web bool) (string, uint16, error) {
	var h [4]byte
	if _, err := io.ReadFull(c, h[:]); err != nil || h[0] != 5 || h[1] != 1 || h[2] != 0 {
		return "", 0, errRefused
	}
	var host string
	switch h[3] {
	case 3:
		var n [1]byte
		if _, err := io.ReadFull(c, n[:]); err != nil || n[0] == 0 {
			return "", 0, errRefused
		}
		b := make([]byte, int(n[0]))
		if _, err := io.ReadFull(c, b); err != nil {
			return "", 0, errRefused
		}
		host = string(b)
	case 1, 4:
		if !web {
			return "", 0, errRefused
		}
		size := 4
		if h[3] == 4 {
			size = 16
		}
		b := make([]byte, size)
		if _, err := io.ReadFull(c, b); err != nil {
			return "", 0, errRefused
		}
		a, _ := netip.AddrFromSlice(b)
		host = a.Unmap().String()
	default:
		return "", 0, errRefused
	}
	if _, err := io.ReadFull(c, h[:2]); err != nil {
		return "", 0, errRefused
	}
	port := binary.BigEndian.Uint16(h[:2])
	if (port != 443 && (!web || port != 80)) || !validWebHost(host, web) {
		return "", 0, errRefused
	}
	return strings.ToLower(host), port, nil
}

func (f *Forwarder) DNSAddr() (netip.AddrPort, bool) { return f.dnsAddr, f.dnsAddr.IsValid() }
func (f *Forwarder) startDNS(ctx context.Context) error {
	addr := f.DNSListen
	if addr == "" {
		addr = PublicDNSAddress
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return errors.New("public DNS listener unavailable")
	}
	f.dnsAddr = l.Addr().(*net.TCPAddr).AddrPort()
	f.ls = append(f.ls, l)
	slots := make(chan struct{}, 16)
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			select {
			case slots <- struct{}{}:
				go func() {
					defer func() { <-slots }()
					defer c.Close()
					stop := context.AfterFunc(ctx, func() { c.Close() })
					defer stop()
					// getaddrinfo uses TCP via resolv.conf's use-vc option. Limit each connection
					// and request so tenant input cannot occupy the front without bound.
					for i := 0; i < 16; i++ {
						c.SetDeadline(time.Now().Add(20 * time.Second))
						var n [2]byte
						if _, err := io.ReadFull(c, n[:]); err != nil {
							return
						}
						length := int(binary.BigEndian.Uint16(n[:]))
						if length < 12 || length > 4096 {
							return
						}
						q := make([]byte, length)
						if _, err := io.ReadFull(c, q); err != nil {
							return
						}
						answer := f.answerPublicDNS(q)
						if answer == nil {
							return
						}
						binary.BigEndian.PutUint16(n[:], uint16(len(answer)))
						if _, err := c.Write(append(n[:], answer...)); err != nil {
							return
						}
					}
				}()
			default:
				c.Close()
			}
		}
	}()
	return nil
}

func (f *Forwarder) answerPublicDNS(q []byte) []byte {
	if len(q) < 12 || q[2]&0xf8 != 0 || binary.BigEndian.Uint16(q[4:6]) != 1 {
		return nil
	}
	i := 12
	var labels []string
	for {
		if i >= len(q) {
			return nil
		}
		n := int(q[i])
		i++
		if n == 0 {
			break
		}
		if n > 63 || i+n > len(q) {
			return nil
		}
		labels = append(labels, string(q[i:i+n]))
		i += n
		if i > 267 {
			return nil
		}
	}
	if i+4 > len(q) {
		return nil
	}
	kind := binary.BigEndian.Uint16(q[i : i+2])
	class := binary.BigEndian.Uint16(q[i+2 : i+4])
	i += 4
	resp := append([]byte(nil), q[:i]...)
	resp[2] = 0x80 | (q[2] & 1)
	resp[3] = 0x80
	for j := 6; j < 12; j++ {
		resp[j] = 0
	}
	name := strings.Join(labels, ".")
	if class != 1 || !validWebHost(name, false) {
		resp[3] |= 3
		return resp
	}
	if kind != 1 && kind != 28 {
		return resp
	}
	up, err := f.Upstream()
	if err != nil {
		resp[3] |= 2
		return resp
	}
	defer up.Close()
	up.SetDeadline(time.Now().Add(15 * time.Second))
	if _, err := fmt.Fprintf(up, "egress-dns-v1 %s 0\n", name); err != nil {
		resp[3] |= 2
		return resp
	}
	line, err := readLine(bufio.NewReader(up), 2048)
	fields := strings.Fields(line)
	if err != nil || len(fields) < 2 || fields[0] != "ok" || len(fields) > 17 {
		resp[3] |= 2
		return resp
	}
	var addresses []netip.Addr
	for _, s := range fields[1:] {
		a, err := netip.ParseAddr(s)
		if err != nil || RefuseAddr(a, nil) != "" {
			resp[3] |= 2
			return resp
		}
		addresses = append(addresses, a.Unmap())
	}
	var count uint16
	for _, a := range addresses {
		if (kind == 1 && !a.Is4()) || (kind == 28 && !a.Is6()) {
			continue
		}
		count++
		resp = append(resp, 0xc0, 0x0c)
		resp = binary.BigEndian.AppendUint16(resp, kind)
		resp = append(resp, 0, 1, 0, 0, 0, 30)
		b := a.AsSlice()
		resp = binary.BigEndian.AppendUint16(resp, uint16(len(b)))
		resp = append(resp, b...)
	}
	binary.BigEndian.PutUint16(resp[6:8], count)
	return resp
}
