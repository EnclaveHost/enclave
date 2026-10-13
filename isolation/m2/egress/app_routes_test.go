package egress

import (
	"context"
	"encoding/json"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAppRoutesAreBoundExpiringAndNeverShared(t *testing.T) {
	file := filepath.Join(t.TempDir(), "routes.json")
	id := "0x" + strings.Repeat("1", 64)
	other := "0x" + strings.Repeat("2", 64)
	r := AppRoute{Proxies: []string{"127.0.0.1:14567"}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}
	doc := AppRouteFile{Version: 1, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Apps: map[string]AppRoute{id: r}}
	write := func() {
		b, _ := json.Marshal(doc)
		if e := os.WriteFile(file, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	write()
	if _, e := ReadAppRoute(file, id); e != nil {
		t.Fatal(e)
	}
	if _, e := ReadAppRoute(file, other); e == nil {
		t.Fatal("another app used a route")
	}
	doc.Apps[other] = r
	write()
	if _, e := ReadAppRoute(file, id); e == nil {
		t.Fatal("shared proxy accepted")
	}
	delete(doc.Apps, other)
	doc.ExpiresAt = time.Now().Add(-time.Second).UnixMilli()
	write()
	if _, e := ReadAppRoute(file, id); e == nil {
		t.Fatal("expired route accepted")
	}
}
func TestAppRouteFailureNeverUsesLegacyResolverOrProxy(t *testing.T) {
	d := Dialer{Resolver: panicResolver{}, SOCKSProxy: "127.0.0.1:30489", RouteFor: func(cid uint32) (AppRoute, error) { return AppRoute{}, os.ErrNotExist }}
	if _, _, e := d.Dial(context.Background(), 12, "service.example", 443); ReasonOf(e) != ReasonAdmit {
		t.Fatalf("missing app route: %v", e)
	}
}

type panicResolver struct{}

func (panicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	panic("app egress attempted host DNS")
}

// The node overwrites the file in place when Windows refuses its rename: a reader that catches it half-written
// (here: not JSON, then trailing bytes) reads it again instead of failing the app's connection; a file that stays
// unreadable is still refused.
func TestAppRouteRereadsATornCopy(t *testing.T) {
	file := filepath.Join(t.TempDir(), "routes.json")
	id := "0x" + strings.Repeat("1", 64)
	r := AppRoute{Proxies: []string{"127.0.0.1:14567"}, DNS: []DNSEndpoint{{Address: "1.1.1.1:443", ServerName: "cloudflare-dns.com", Path: "/dns-query"}}}
	good, _ := json.Marshal(AppRouteFile{Version: 1, ExpiresAt: time.Now().Add(time.Minute).UnixMilli(), Apps: map[string]AppRoute{id: r}})
	for _, torn := range [][]byte{good[:len(good)/2], append(append([]byte{}, good...), []byte(`"apps":{}}`)...)} {
		os.WriteFile(file, torn, 0600)
		go func() {
			time.Sleep(15 * time.Millisecond)
			os.WriteFile(file, append(append([]byte{}, good...), "   "...), 0600)
		}()
		if _, e := ReadAppRoute(file, id); e != nil {
			t.Fatalf("a torn copy that is rewritten within the retries: %v", e)
		}
	}
	os.WriteFile(file, good[:10], 0600)
	start := time.Now()
	if _, e := ReadAppRoute(file, id); e == nil || !strings.Contains(e.Error(), "invalid app routes") {
		t.Fatalf("a file that stays torn: %v", e)
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("the rereads are bounded")
	}
	if _, e := ReadAppRoute(filepath.Join(t.TempDir(), "absent.json"), id); !os.IsNotExist(e) {
		t.Fatalf("a missing file is not reread as torn: %v", e)
	}
}
