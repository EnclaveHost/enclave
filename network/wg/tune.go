package wg

import (
	"errors"
	"fmt"
	"reflect"
	"unsafe"

	"golang.zx2c4.com/wireguard/tun/netstack"
	"gvisor.dev/gvisor/pkg/tcpip"
	"gvisor.dev/gvisor/pkg/tcpip/stack"
	"gvisor.dev/gvisor/pkg/tcpip/transport/tcp"
)

// Every circuit's TCP runs in this userspace stack, and over a guard and an exit the round trip is 0.2-0.5 s. With
// gVisor's defaults (reno, 1 MiB send buffers capped at 4 MiB) a single stream's upload stayed under buffer/RTT and
// collapsed on any loss: 0.23-2.2 MB/s up through production circuits against 7-13 MB/s on the same lines, while
// downloads (where the far, ordinary stack sends) ran 3-5 MB/s (2026-10-15). Cubic, larger buffers and receive-buffer
// moderation let a stream fill the path. Buffers grow only with data in flight, so idle connections cost nothing more.
const (
	tunedBufferDefault = 4 << 20
	tunedBufferMax     = 32 << 20
)

// netstackStack reaches the gVisor stack wireguard-go keeps private (netstack.Net is its netTun): looked up by name and
// checked against its type, so a dependency update that changes the layout fails loudly instead of misreading memory.
func netstackStack(n *netstack.Net) (*stack.Stack, error) {
	if n == nil {
		return nil, errors.New("no netstack")
	}
	v := reflect.ValueOf(n).Elem().FieldByName("stack")
	if !v.IsValid() || v.Type() != reflect.TypeOf((*stack.Stack)(nil)) {
		return nil, errors.New("wireguard-go netstack layout changed: no *stack.Stack field named stack")
	}
	s := *(**stack.Stack)(unsafe.Pointer(v.UnsafeAddr()))
	if s == nil {
		return nil, errors.New("netstack has no stack")
	}
	return s, nil
}

// TuneTCP sets the tunnel stack's TCP for long paths. Called right after the stack is made, before any connection.
func TuneTCP(n *netstack.Net) error {
	s, err := netstackStack(n)
	if err != nil {
		return err
	}
	set := func(what string, e tcpip.Error) error {
		if e != nil {
			return fmt.Errorf("tune %s: %v", what, e)
		}
		return nil
	}
	// the stack-wide socket limits bound what the TCP ranges below may ask for
	if err := set("send buffer limit", s.SetOption(tcpip.SendBufferSizeOption{Min: 4 << 10, Default: tunedBufferDefault, Max: tunedBufferMax})); err != nil {
		return err
	}
	if err := set("receive buffer limit", s.SetOption(tcpip.ReceiveBufferSizeOption{Min: 4 << 10, Default: tunedBufferDefault, Max: tunedBufferMax})); err != nil {
		return err
	}
	snd := tcpip.TCPSendBufferSizeRangeOption{Min: 4 << 10, Default: tunedBufferDefault, Max: tunedBufferMax}
	if err := set("tcp send buffer", s.SetTransportProtocolOption(tcp.ProtocolNumber, &snd)); err != nil {
		return err
	}
	rcv := tcpip.TCPReceiveBufferSizeRangeOption{Min: 4 << 10, Default: 1 << 20, Max: tunedBufferMax}
	if err := set("tcp receive buffer", s.SetTransportProtocolOption(tcp.ProtocolNumber, &rcv)); err != nil {
		return err
	}
	moderate := tcpip.TCPModerateReceiveBufferOption(true)
	if err := set("receive buffer moderation", s.SetTransportProtocolOption(tcp.ProtocolNumber, &moderate)); err != nil {
		return err
	}
	cc := tcpip.CongestionControlOption("cubic")
	return set("congestion control", s.SetTransportProtocolOption(tcp.ProtocolNumber, &cc))
}
