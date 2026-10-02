package egress

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
)

// RouteFor is resolved from the manager's authenticated guest CID, never a
// deployment identifier supplied in a guest request.
type AppRoute struct {
	Proxies []string      `json:"proxies"`
	DNS     []DNSEndpoint `json:"dns"`
}
type DNSEndpoint struct {
	Address    string `json:"address"`
	ServerName string `json:"serverName"`
	Path       string `json:"path"`
}
type AppRouteFile struct {
	Version   int                 `json:"version"`
	ExpiresAt int64               `json:"expiresAt"`
	Apps      map[string]AppRoute `json:"apps"`
}

var appIDPattern = regexp.MustCompile(`^0x[0-9a-f]{64}$`)

func ReadAppRoute(file, deploymentID string) (AppRoute, error) {
	var zero AppRoute
	if !appIDPattern.MatchString(deploymentID) {
		return zero, errors.New("unbound guest")
	}
	f, e := os.Open(file)
	if e != nil {
		return zero, e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 1<<20+1))
	if e != nil || len(b) > 1<<20 {
		return zero, errors.New("invalid app routes")
	}
	var doc AppRouteFile
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if e = dec.Decode(&doc); e != nil {
		return zero, e
	}
	var extra any
	if dec.Decode(&extra) != io.EOF {
		return zero, errors.New("trailing app route data")
	}
	now := time.Now().UnixMilli()
	if doc.Version != 1 || doc.ExpiresAt <= now || doc.ExpiresAt > now+120000 || len(doc.Apps) > 256 {
		return zero, errors.New("expired or invalid app routes")
	}
	// Reject shared circuit entries, including another app reusing one proxy.
	seen := map[string]bool{}
	for id, r := range doc.Apps {
		if !appIDPattern.MatchString(id) || len(r.Proxies) < 1 || len(r.Proxies) > 2 || len(r.DNS) < 1 || len(r.DNS) > 4 {
			return zero, errors.New("invalid app route")
		}
		for _, p := range r.Proxies {
			a, e := netip.ParseAddrPort(p)
			canonical := ""
			if e == nil {
				canonical = netip.AddrPortFrom(a.Addr().Unmap(), a.Port()).String()
			}
			if ValidateSOCKSProxy(p) != nil || seen[canonical] {
				return zero, errors.New("invalid or reused app proxy")
			}
			seen[canonical] = true
		}
		for _, d := range r.DNS {
			if d.Path != "/dns-query" && d.Path != "/resolve" {
				return zero, errors.New("unsupported DNS query path")
			}
			a, e := netip.ParseAddrPort(d.Address)
			if e != nil || a.Port() != 443 || RefuseAddr(a.Addr(), nil) != "" {
				return zero, errors.New("public DNS endpoint required")
			}
			if _, e = ParseOrigin("https://" + d.ServerName + "/"); e != nil {
				return zero, errors.New("invalid DNS TLS identity")
			}
		}
	}
	r, ok := doc.Apps[deploymentID]
	if !ok {
		return zero, errors.New("app has no authorized egress route")
	}
	return r, nil
}

// DNS is HTTPS over the SAME app proxy. The resolver is dialed by pinned IP
// and verified using its configured TLS name; host DNS is never consulted.
type appResolver struct {
	proxy   string
	servers []DNSEndpoint
}

func (r appResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	if network != "ip" {
		return nil, errors.New("unsupported address family")
	}
	var result []netip.Addr
	for _, kind := range []int{1, 28} {
		var answer []netip.Addr
		var accepted bool
		for _, server := range r.servers {
			transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, ServerName: server.ServerName},
				DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
					return dialSOCKS(ctx, r.proxy, server.Address, 8*time.Second)
				}}
			client := &http.Client{Transport: transport, Timeout: 8 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("DNS redirect refused") }}
			u := "https://" + server.ServerName + server.Path + "?name=" + url.QueryEscape(host) + "&type=" + fmt.Sprint(kind)
			req, e := http.NewRequestWithContext(ctx, "GET", u, nil)
			if e != nil {
				return nil, e
			}
			req.Header.Set("Accept", "application/dns-json")
			res, e := client.Do(req)
			if e != nil {
				transport.CloseIdleConnections()
				continue
			}
			b, e := io.ReadAll(io.LimitReader(res.Body, 65537))
			res.Body.Close()
			transport.CloseIdleConnections()
			if e != nil || res.StatusCode != 200 || len(b) > 65536 {
				continue
			}
			var doc struct {
				Status int
				Answer []struct {
					Type int
					Data string
				}
			}
			if json.Unmarshal(b, &doc) != nil || doc.Status != 0 {
				continue
			}
			bad := false
			for _, a := range doc.Answer {
				if a.Type == kind {
					ip, e := netip.ParseAddr(a.Data)
					if e != nil || (kind == 1 && !ip.Is4()) || (kind == 28 && !ip.Is6()) {
						bad = true
						break
					}
					answer = append(answer, ip)
				}
			}
			if bad {
				answer = nil
				continue
			}
			accepted = true
			break
		}
		if !accepted {
			return nil, errors.New("guarded DNS unavailable")
		}
		result = append(result, answer...)
	}
	if len(result) == 0 {
		return nil, errors.New("DNS returned no addresses")
	}
	return result, nil
}

// A failure after DNS resolution still tries the app's other authorized circuit.
// Every attempt is bounded and carries its own DNS through the same proxy.
func (d *Dialer) dialAppRoute(ctx context.Context, route AppRoute, host string, port int, allowIP bool) (net.Conn, error) {
	var own []netip.Addr
	if d.Own != nil {
		own = d.Own()
	}
	reason := ReasonResolve
	for _, proxy := range route.Proxies {
		if ValidateSOCKSProxy(proxy) != nil {
			return nil, refused(ReasonAdmit)
		}
		attempt, cancel := context.WithTimeout(ctx, d.timeout())
		resolver := &Dialer{Resolver: appResolver{proxy: proxy, servers: route.DNS}, Own: d.Own}
		addresses, err := resolver.publicAddresses(attempt, host, allowIP)
		if ReasonOf(err) == ReasonNonPublicAnswer || ReasonOf(err) == ReasonName {
			cancel()
			return nil, err
		}
		if err != nil || len(addresses) == 0 {
			cancel()
			continue
		}
		for _, address := range addresses {
			if RefuseAddr(address, own) != "" {
				cancel()
				return nil, refused(ReasonNonPublicAnswer)
			}
		}
		reason = ReasonConnect
		for _, address := range addresses {
			conn, err := dialSOCKS(attempt, proxy, netip.AddrPortFrom(address.Unmap(), uint16(port)).String(), d.timeout())
			if err == nil {
				cancel()
				return conn, nil
			}
			if attempt.Err() != nil {
				break
			}
		}
		cancel()
		if ctx.Err() != nil {
			break
		}
	}
	return nil, &DialError{Reason: reason, refused: reason == ReasonResolve}
}

// CID is authenticated by the transport and bound by the manager, never chosen
// by a guest. Missing or expired entries cannot use legacy host routing.
func (d *Dialer) appRoute(cid uint32) (AppRoute, error) {
	route, err := d.RouteFor(cid)
	if err != nil || len(route.Proxies) == 0 || len(route.DNS) == 0 {
		return AppRoute{}, refused(ReasonAdmit)
	}
	return route, nil
}

// Browser DNS uses the same per-app circuits as HTTPS. It has no host resolver
// fallback, including after a circuit failure or an empty answer.
func (d *Dialer) resolveAppRoute(ctx context.Context, route AppRoute, host string) ([]netip.Addr, error) {
	for _, proxy := range route.Proxies {
		if ValidateSOCKSProxy(proxy) != nil {
			return nil, refused(ReasonAdmit)
		}
		attempt, cancel := context.WithTimeout(ctx, d.timeout())
		resolver := &Dialer{Resolver: appResolver{proxy: proxy, servers: route.DNS}, Own: d.Own}
		addresses, err := resolver.publicAddresses(attempt, host, false)
		cancel()
		if err == nil {
			return addresses, nil
		}
		if ReasonOf(err) == ReasonNonPublicAnswer || ReasonOf(err) == ReasonName {
			return nil, err
		}
		if ctx.Err() != nil {
			break
		}
	}
	return nil, refused(ReasonResolve)
}
