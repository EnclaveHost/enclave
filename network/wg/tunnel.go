package wg

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"golang.zx2c4.com/wireguard/conn"
	"golang.zx2c4.com/wireguard/device"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Key is a WireGuard key (Curve25519, 32 bytes), base64 in configs and JSON as WireGuard writes it.
type Key [32]byte

func ParseKey(s string) (Key, error) {
	var k Key
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != 32 {
		return k, errors.New("a WireGuard key is 32 bytes of base64")
	}
	copy(k[:], b)
	return k, nil
}
func (k Key) String() string                      { return base64.StdEncoding.EncodeToString(k[:]) }
func (k Key) IsZero() bool                        { return k == Key{} }
func (k Key) hex() string                         { return hex.EncodeToString(k[:]) }
func (k *Key) UnmarshalText(b []byte) (err error) { *k, err = ParseKey(string(b)); return }
func (k Key) MarshalText() ([]byte, error)        { return []byte(k.String()), nil }

// Peer is one WireGuard tunnel: this side's key and addresses, the one peer, and where it is.
type Peer struct {
	PrivateKey   Key            `json:"privateKey"`
	PublicKey    Key            `json:"publicKey"`
	PresharedKey *Key           `json:"presharedKey,omitempty"`
	Endpoint     netip.AddrPort `json:"endpoint"`
	Addresses    []netip.Addr   `json:"addresses"`
	DNS          []netip.Addr   `json:"dns,omitempty"`
	MTU          int            `json:"mtu,omitempty"`
	Keepalive    int            `json:"keepalive,omitempty"`
	ListenPort   uint16         `json:"-"` // set only by a side that accepts handshakes (tests, never a host)
}

func (p Peer) Validate() error {
	if p.PrivateKey.IsZero() || p.PublicKey.IsZero() {
		return errors.New("tunnel keys required")
	}
	if (!p.Endpoint.IsValid() || p.Endpoint.Port() == 0) && p.ListenPort == 0 {
		return errors.New("tunnel endpoint required")
	}
	if len(p.Addresses) < 1 || len(p.Addresses) > 2 {
		return errors.New("one IPv4 and at most one IPv6 tunnel address")
	}
	v4, v6 := 0, 0
	for _, a := range p.Addresses {
		if !a.IsValid() {
			return errors.New("invalid tunnel address")
		}
		if a.Unmap().Is4() {
			v4++
		} else {
			v6++
		}
	}
	if v4 > 1 || v6 > 1 {
		return errors.New("one IPv4 and at most one IPv6 tunnel address")
	}
	if p.MTU != 0 && (p.MTU < 1280 || p.MTU > 1500) {
		return errors.New("MTU must be 1280-1500")
	}
	if p.Keepalive < 0 || p.Keepalive > 120 {
		return errors.New("keepalive must be 0-120 s")
	}
	if len(p.DNS) > 4 {
		return errors.New("at most four resolvers")
	}
	return nil
}

func (p Peer) HasIPv6() bool {
	for _, a := range p.Addresses {
		if !a.Unmap().Is4() {
			return true
		}
	}
	return false
}

// Device is a running tunnel and its private network stack.
type Device struct {
	dev   *device.Device
	Net   *netstack.Net
	Peer  Peer
	start time.Time
}

// Up starts a tunnel over bind (conn.NewDefaultBind() for a real UDP socket, a NetstackBind inside another tunnel).
// All traffic is full-tunnel: 0.0.0.0/0, plus ::/0 when the tunnel has an IPv6 address.
func Up(p Peer, bind conn.Bind, logf func(string, ...any)) (*Device, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	mtu := p.MTU
	if mtu == 0 {
		mtu = 1420
	}
	tunDev, tnet, err := netstack.CreateNetTUN(p.Addresses, p.DNS, mtu)
	if err != nil {
		return nil, err
	}
	// long-path TCP (tune.go): without it a circuit's uploads stayed far under the line
	if err := TuneTCP(tnet); err != nil {
		tunDev.Close()
		return nil, err
	}
	if logf == nil {
		logf = func(string, ...any) {}
	}
	dev := device.NewDevice(tunDev, bind, &device.Logger{Verbosef: func(string, ...any) {}, Errorf: logf})
	var b strings.Builder
	fmt.Fprintf(&b, "private_key=%s\n", p.PrivateKey.hex())
	if p.ListenPort != 0 {
		fmt.Fprintf(&b, "listen_port=%d\n", p.ListenPort)
	}
	fmt.Fprintf(&b, "replace_peers=true\npublic_key=%s\n", p.PublicKey.hex())
	if p.PresharedKey != nil {
		fmt.Fprintf(&b, "preshared_key=%s\n", p.PresharedKey.hex())
	}
	if p.Endpoint.IsValid() {
		fmt.Fprintf(&b, "endpoint=%s\n", p.Endpoint.String())
	}
	if p.Keepalive > 0 {
		fmt.Fprintf(&b, "persistent_keepalive_interval=%d\n", p.Keepalive)
	}
	b.WriteString("replace_allowed_ips=true\nallowed_ip=0.0.0.0/0\n")
	if p.HasIPv6() {
		b.WriteString("allowed_ip=::/0\n")
	}
	if err := dev.IpcSet(b.String()); err != nil {
		dev.Close()
		return nil, err
	}
	if err := dev.Up(); err != nil {
		dev.Close()
		return nil, err
	}
	return &Device{dev: dev, Net: tnet, Peer: p, start: time.Now()}, nil
}

func (d *Device) Close() { d.dev.Close() }

// Stats reads the peer's last handshake and byte counters.
func (d *Device) Stats() (last time.Time, rx, tx uint64) {
	s, err := d.dev.IpcGet()
	if err != nil {
		return
	}
	sc := bufio.NewScanner(strings.NewReader(s))
	var sec, nsec int64
	for sc.Scan() {
		k, v, ok := strings.Cut(sc.Text(), "=")
		if !ok {
			continue
		}
		switch k {
		case "last_handshake_time_sec":
			sec, _ = strconv.ParseInt(v, 10, 64)
		case "last_handshake_time_nsec":
			nsec, _ = strconv.ParseInt(v, 10, 64)
		case "rx_bytes":
			rx, _ = strconv.ParseUint(v, 10, 64)
		case "tx_bytes":
			tx, _ = strconv.ParseUint(v, 10, 64)
		}
	}
	if sec > 0 {
		last = time.Unix(sec, nsec)
	}
	return
}

// WaitHandshake waits until the peer has completed a handshake (the tunnel is really up).
func (d *Device) WaitHandshake(ctx context.Context) error {
	t := time.NewTicker(100 * time.Millisecond)
	defer t.Stop()
	for {
		if last, _, _ := d.Stats(); !last.IsZero() {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("no WireGuard handshake with " + d.Peer.Endpoint.String())
		case <-t.C:
		}
	}
}

func (d *Device) DialTCP(ctx context.Context, to netip.AddrPort) (net.Conn, error) {
	return d.Net.DialContextTCPAddrPort(ctx, to)
}

// Resolve looks a name up through the tunnel's resolvers (the netstack's own DNS client: no host resolver).
func (d *Device) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if len(d.Peer.DNS) == 0 {
		return nil, errors.New("tunnel has no resolver")
	}
	r, err := d.Net.LookupContextHost(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]netip.Addr, 0, len(r))
	for _, s := range r {
		if a, err := netip.ParseAddr(s); err == nil {
			if a.Unmap().Is6() && !d.Peer.HasIPv6() {
				continue
			}
			out = append(out, a.Unmap())
		}
	}
	return out, nil
}

// Local returns this side's tunnel address of the given family.
func (d *Device) Local(v6 bool) (netip.Addr, bool) {
	for _, a := range d.Peer.Addresses {
		if a.Unmap().Is4() != v6 {
			return a.Unmap(), true
		}
	}
	return netip.Addr{}, false
}
