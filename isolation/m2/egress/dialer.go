package egress

// The HOST side of controlled egress: a guest's forwarder asks for one (hostname, 443) and the host dials it, or
// refuses. The host holds no allowlist (that lives in the guest, derived from secrets it cannot see); what the host
// enforces is that a guest can never reach the host's own network: the FINAL resolved address is judged at dial time,
// so a CNAME chain or a DNS change that lands on a private address is refused on the address itself.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sync"
	"time"
)

// refusedPrefixes: never a destination for a tenant, whatever DNS says.
var refusedPrefixes = func() []netip.Prefix {
	var out []netip.Prefix
	for _, s := range []string{
		"0.0.0.0/8",       // "this network", incl. 0.0.0.0
		"10.0.0.0/8",      // RFC1918
		"100.64.0.0/10",   // CGNAT
		"127.0.0.0/8",     // loopback
		"169.254.0.0/16",  // link-local, incl. the 169.254.169.254 metadata service
		"172.16.0.0/12",   // RFC1918
		"192.0.0.0/24",    // IETF protocol assignments
		"192.168.0.0/16",  // RFC1918
		"198.18.0.0/15",   // benchmarking
		"224.0.0.0/4",     // multicast
		"240.0.0.0/4",     // reserved, incl. 255.255.255.255
		"::/128",          // unspecified
		"::1/128",         // loopback
		"64:ff9b::/96",    // NAT64: an IPv4 in disguise
		"fc00::/7",        // ULA
		"fe80::/10",       // link-local
		"ff00::/8",        // multicast
		"2002::/16",       // 6to4: an IPv4 in disguise
	} {
		out = append(out, netip.MustParsePrefix(s))
	}
	return out
}()

// RefuseAddr says why an address may not be dialed for a tenant ("" = allowed). IPv4-mapped IPv6 is judged as the
// IPv4 it carries.
func RefuseAddr(a netip.Addr, own []netip.Addr) string {
	a = a.Unmap()
	if !a.IsValid() {
		return "not an address"
	}
	for _, p := range refusedPrefixes {
		if p.Contains(a) {
			return "a non-public address (" + p.String() + ")"
		}
	}
	for _, o := range own {
		if o.Unmap() == a {
			return "one of this host's own addresses"
		}
	}
	return ""
}

// Resolver is the part of net.Resolver the dialer needs (a fake in tests).
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Dialer is the host's egress service for ALL guests; per-guest caps keep one guest from exhausting it.
type Dialer struct {
	Resolver      Resolver
	Own           func() []netip.Addr // this host's addresses, read at dial time
	DialTimeout   time.Duration
	MaxConcurrent int           // per guest
	MaxPerMinute  int           // per guest, dials started
	dial          func(ctx context.Context, addr string) (net.Conn, error)
	mu            sync.Mutex
	active        map[uint32]int
	window        map[uint32][]time.Time
}

var ErrRefused = errors.New("egress refused")

// Dial opens a TCP connection for guest `cid` to host:443, or refuses. It returns the connection and a release func
// the caller MUST call when the connection ends (it frees the guest's concurrency slot).
func (d *Dialer) Dial(ctx context.Context, cid uint32, host string, port int) (net.Conn, func(), error) {
	if port != 443 {
		return nil, nil, fmt.Errorf("%w: port %d (only 443)", ErrRefused, port)
	}
	if _, err := ParseOrigin("https://" + host + "/"); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrRefused, err) // an IP literal, a single label, …: never by name here
	}
	release, err := d.take(cid)
	if err != nil {
		return nil, nil, err
	}
	ok := false
	defer func() {
		if !ok {
			release()
		}
	}()
	addrs, err := d.Resolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return nil, nil, fmt.Errorf("%w: %s does not resolve", ErrRefused, host)
	}
	var own []netip.Addr
	if d.Own != nil {
		own = d.Own()
	}
	// every answer must be public: a name that resolves to ANY private address is refused outright, rather than
	// dialing its public sibling (a rebinding setup mixes the two)
	for _, a := range addrs {
		if why := RefuseAddr(a, own); why != "" {
			return nil, nil, fmt.Errorf("%w: %s resolves to %s", ErrRefused, host, why)
		}
	}
	dial := d.dial
	if dial == nil {
		nd := &net.Dialer{Timeout: d.timeout()}
		dial = func(ctx context.Context, addr string) (net.Conn, error) { return nd.DialContext(ctx, "tcp", addr) }
	}
	var lastErr error
	for _, a := range addrs {
		// dial the JUDGED address itself, never the name again (no second resolution between check and connect)
		c, err := dial(ctx, netip.AddrPortFrom(a.Unmap(), uint16(port)).String())
		if err != nil {
			lastErr = err
			continue
		}
		// and the address the socket actually reached is judged once more
		if ra, err := netip.ParseAddrPort(c.RemoteAddr().String()); err != nil || RefuseAddr(ra.Addr(), own) != "" {
			c.Close()
			return nil, nil, fmt.Errorf("%w: the connection reached a non-public address", ErrRefused)
		}
		ok = true
		return c, release, nil
	}
	return nil, nil, fmt.Errorf("could not connect to %s: %v", host, lastErr)
}

func (d *Dialer) timeout() time.Duration {
	if d.DialTimeout > 0 {
		return d.DialTimeout
	}
	return 10 * time.Second
}

func (d *Dialer) take(cid uint32) (func(), error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.active == nil {
		d.active, d.window = map[uint32]int{}, map[uint32][]time.Time{}
	}
	now := time.Now()
	w := d.window[cid][:0]
	for _, t := range d.window[cid] {
		if now.Sub(t) < time.Minute {
			w = append(w, t)
		}
	}
	d.window[cid] = w
	if d.MaxPerMinute > 0 && len(w) >= d.MaxPerMinute {
		return nil, fmt.Errorf("%w: guest %d is over its dial rate", ErrRefused, cid)
	}
	if d.MaxConcurrent > 0 && d.active[cid] >= d.MaxConcurrent {
		return nil, fmt.Errorf("%w: guest %d is at its connection limit", ErrRefused, cid)
	}
	d.window[cid] = append(w, now)
	d.active[cid]++
	var once sync.Once
	return func() {
		once.Do(func() {
			d.mu.Lock()
			d.active[cid]--
			d.mu.Unlock()
		})
	}, nil
}
