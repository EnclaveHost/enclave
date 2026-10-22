package bootstrap

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLease16dRig: the guest's writer-authority read (leasegen.go) over the REAL measured RPC client path (NewReader's
// HTTPS endpoints, their JSON-RPC error text) against the live rev-16d ledger bytecode on anvil behind the three
// provider proxies of test/helpers/lease16d-rig.mjs. Driven by test/storage-front-binding-go.test.mjs, which mutates the
// chain between runs and passes each run's expectations in LEASE16D_RIG; skipped without it.
func TestLease16dRig(t *testing.T) {
	raw := os.Getenv("LEASE16D_RIG")
	if raw == "" {
		t.Skip("driven by test/storage-front-binding-go.test.mjs")
	}
	var in struct {
		Proxies []string `json:"proxies"`
		Ledger  string   `json:"ledger"`
		Checks  []struct {
			Name   string          `json:"name"`
			ID     string          `json:"id"`
			Runner string          `json:"runner"`
			Fact   json.RawMessage `json:"fact"`
			Code   string          `json:"code"`
			Retry  bool            `json:"retry"`
		} `json:"checks"`
	}
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatal(err)
	}
	from, window, backoff := leaseFromBlock, leaseWindow, leaseBackoff
	leaseFromBlock, leaseBackoff = 0, 10*time.Millisecond
	defer func() { leaseFromBlock, leaseWindow, leaseBackoff = from, window, backoff }()
	// distinct HTTPS names, as a guest's measured RPCs are; the transport (a guest's egress) reaches the rig's proxies
	names, route := []string{}, map[string]*url.URL{}
	for i, p := range in.Proxies {
		u, err := url.Parse(p)
		if err != nil {
			t.Fatal(err)
		}
		name := "rpc." + string(rune('a'+i)) + "-lease16d.test" // distinct operators (history.go operatorOf)
		names, route[name] = append(names, "https://"+name), u
	}
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		u, ok := route[r.URL.Hostname()]
		if !ok {
			return nil, errors.New("no such provider")
		}
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host, r.Host = u.Scheme, u.Host, u.Host
		return http.DefaultTransport.RoundTrip(r)
	})}
	reader, err := NewReader(Config{ChainID: 8453, Ledger: in.Ledger, RPCs: names, Confirmations: 2, MaxAge: 2 * time.Minute, Client: client})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range in.Checks {
		var id, runner [32]byte
		b, _ := hex.DecodeString(strings.TrimPrefix(c.ID, "0x"))
		copy(id[:], b)
		var got interface{ JSON() (string, error) }
		var err error
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		if c.Runner != "" {
			b, _ = hex.DecodeString(strings.TrimPrefix(c.Runner, "0x"))
			copy(runner[:], b)
			w, e := reader.LeaseWriterAuthorityFor(ctx, id, runner)
			got, err = w, e
		} else {
			w, e := reader.LeaseWriterAuthority(ctx, id)
			got, err = w, e
		}
		cancel()
		if c.Code != "" {
			var ae *AuthorityError
			if !errors.As(err, &ae) || ae.Code != c.Code || ae.Retry != c.Retry {
				t.Errorf("%s: want %s (retry %v), got %v", c.Name, c.Code, c.Retry, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		j, _ := got.JSON()
		if j != string(c.Fact) {
			t.Errorf("%s: fact\n got %s\nwant %s", c.Name, j, c.Fact)
		}
	}
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
