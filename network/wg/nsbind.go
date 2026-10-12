package wg

import (
	"errors"
	"net"
	"net/netip"
	"sync"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// NetstackBind carries one WireGuard device's UDP inside another device's tunnel: the inner tunnel to the exit runs
// through the outer tunnel to the guard, so the exit only ever sees the guard's address (WireGuard in WireGuard).
// It sends and receives only to the one endpoint it was opened for; any other source is dropped.
type NetstackBind struct {
	Net   *netstack.Net
	Local netip.Addr     // the outer tunnel address to send from
	Peer  netip.AddrPort // the only endpoint this bind talks to
	mu    sync.Mutex
	udp   net.PacketConn
}

type nsEndpoint struct{ dst netip.AddrPort }

func (e nsEndpoint) ClearSrc()           {}
func (e nsEndpoint) SrcToString() string { return "" }
func (e nsEndpoint) DstToString() string { return e.dst.String() }
func (e nsEndpoint) DstToBytes() []byte  { b, _ := e.dst.MarshalBinary(); return b }
func (e nsEndpoint) DstIP() netip.Addr   { return e.dst.Addr() }
func (e nsEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }

func (b *NetstackBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.udp != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	c, err := b.Net.ListenUDPAddrPort(netip.AddrPortFrom(b.Local, port))
	if err != nil {
		return nil, 0, err
	}
	b.udp = c
	actual := uint16(c.LocalAddr().(*net.UDPAddr).Port)
	recv := func(packets [][]byte, sizes []int, eps []conn.Endpoint) (int, error) {
		for {
			n, from, err := c.ReadFrom(packets[0])
			if err != nil {
				return 0, net.ErrClosed
			}
			ua, ok := from.(*net.UDPAddr)
			if !ok {
				continue
			}
			src := ua.AddrPort()
			if netip.AddrPortFrom(src.Addr().Unmap(), src.Port()) != b.Peer {
				continue // not the exit: drop
			}
			sizes[0] = n
			eps[0] = nsEndpoint{dst: b.Peer}
			return 1, nil
		}
	}
	return []conn.ReceiveFunc{recv}, actual, nil
}

func (b *NetstackBind) Close() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.udp == nil {
		return nil
	}
	err := b.udp.Close()
	b.udp = nil
	return err
}

func (b *NetstackBind) SetMark(uint32) error { return nil }
func (b *NetstackBind) BatchSize() int       { return 1 }

func (b *NetstackBind) Send(bufs [][]byte, ep conn.Endpoint) error {
	b.mu.Lock()
	c := b.udp
	b.mu.Unlock()
	if c == nil {
		return net.ErrClosed
	}
	if ep.DstToString() != b.Peer.String() {
		return errors.New("netstack bind: endpoint is not the configured exit")
	}
	to := net.UDPAddrFromAddrPort(b.Peer)
	for _, p := range bufs {
		if _, err := c.WriteTo(p, to); err != nil {
			return err
		}
	}
	return nil
}

func (b *NetstackBind) ParseEndpoint(s string) (conn.Endpoint, error) {
	ap, err := netip.ParseAddrPort(s)
	if err != nil {
		return nil, err
	}
	if netip.AddrPortFrom(ap.Addr().Unmap(), ap.Port()) != b.Peer {
		return nil, errors.New("netstack bind: endpoint is not the configured exit")
	}
	return nsEndpoint{dst: b.Peer}, nil
}
