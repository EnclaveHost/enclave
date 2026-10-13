// Package wg is the host side of the Enclave network: one WireGuard data plane per circuit, entirely in-process
// (wireguard-go and its userspace netstack). There is no OS interface and no route, so an app's traffic can only
// leave through the tunnel it was given (docs/design/enclave-network.md).
package wg

import (
	"errors"
	"net/netip"
)

// blocked are the destinations an app may never reach through any egress: loopback, private, CGNAT, link-local
// (cloud metadata), multicast, documentation and other reserved ranges. Providers enforce the same set; this copy
// refuses early so a refusal is a clear SOCKS reply, never a hang.
var blocked = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
	"192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32",
	"2002::/16", "fc00::/7", "fe80::/10", "ff00::/8",
)

func mustPrefixes(s ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(s))
	for i, v := range s {
		out[i] = netip.MustParsePrefix(v)
	}
	return out
}

// ErrRefused marks a destination the policy refuses (SOCKS reply 2).
var ErrRefused = errors.New("destination refused by policy")

// Policy decides which destinations an app may dial.
type Policy struct {
	Own    []netip.Addr     // addresses of the providers on this circuit and of this host: never reachable
	NoIPv6 bool             // the tunnel has no IPv6 route: refuse IPv6 instead of trying it
	Only   []netip.AddrPort // when set, exactly these destinations and nothing else (the guard path)
}

// Judge returns nil when port on a is an allowed destination.
func (p Policy) Judge(a netip.Addr, port int) error {
	a = a.Unmap()
	if len(p.Only) > 0 {
		for _, o := range p.Only {
			if o.Addr().Unmap() == a && int(o.Port()) == port {
				return nil
			}
		}
		return ErrRefused
	}
	if !a.IsValid() || port < 1 || port > 65535 || port == 25 {
		return ErrRefused
	}
	if a.Is6() && p.NoIPv6 {
		return ErrRefused
	}
	for _, b := range blocked {
		if b.Contains(a) {
			return ErrRefused
		}
	}
	for _, o := range p.Own {
		if o.Unmap() == a {
			return ErrRefused
		}
	}
	return nil
}
