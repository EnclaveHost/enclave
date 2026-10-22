package bootstrap

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/m2/appconfig"
)

// TestColdHistoryRig: the relay-free guest's ACTUAL direct path (Reader.Authorize on the owner-committed startup package,
// then Authorization.WriterAuthority under WhenFinal, as front/bootstrap.go and shield_direct_custody.go call it) with a
// FRESH reader per check (no coverage, no cache), against the live rev-16d ledger bytecode on anvil. Driven by
// test/storage-front-cold-history.test.mjs, which mutates the chain and passes each run's checks in COLD_HISTORY_RIG;
// skipped without it. The transport refuses an owner history host until Authorize admits it (AllowOrigin), as the
// guest's dialer does (front/measured_reader.go).
func TestColdHistoryRig(t *testing.T) {
	raw := os.Getenv("COLD_HISTORY_RIG")
	if raw == "" {
		t.Skip("driven by test/storage-front-cold-history.test.mjs")
	}
	var in struct {
		Routes   map[string]string `json:"routes"`
		Measured []string          `json:"measured"`
		Ledger   string            `json:"ledger"`
		Offset   int64             `json:"clockOffsetSec"`
		Checks   []struct {
			Name      string          `json:"name"`
			ID        string          `json:"id"`
			Package   string          `json:"package"`
			AppID     string          `json:"appId"`
			RuntimeID string          `json:"runtimeId"`
			WindowMs  int             `json:"windowMs"`
			StepMs    int             `json:"intervalMs"`
			Pause     string          `json:"pause"`
			Fact      json.RawMessage `json:"fact"`
			Code      string          `json:"code"`
			Contains  string          `json:"contains"`
			AuthFails string          `json:"authorizeFails"`
			MaxReq    int             `json:"maxRequests"`
			AttemptMs int             `json:"attemptTimeoutMs"`
		} `json:"checks"`
	}
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatal(err)
	}
	from, backoff, maxReq, attempt := leaseFromBlock, leaseBackoff, leaseMaxRequests, leaseAttemptTimeout
	leaseFromBlock, leaseBackoff = 0, 10*time.Millisecond
	defer func() {
		leaseFromBlock, leaseBackoff, leaseMaxRequests, leaseAttemptTimeout = from, backoff, maxReq, attempt
	}()
	measuredHosts := map[string]bool{}
	for _, m := range in.Measured {
		u, _ := url.Parse(m)
		measuredHosts[u.Hostname()] = true
	}
	for _, c := range in.Checks {
		leaseMaxRequests, leaseAttemptTimeout = maxReq, attempt
		if c.MaxReq > 0 { // a smaller per-attempt budget: the scan must resume across attempts
			leaseMaxRequests = c.MaxReq
		}
		if c.AttemptMs > 0 { // a shorter attempt deadline: its completed steps must survive it
			leaseAttemptTimeout = time.Duration(c.AttemptMs) * time.Millisecond
		}
		// a fresh guest: its own reader, its own allowlist (the measured origins), nothing cached
		var mu sync.Mutex
		allowed, admitted := map[string]bool{}, []string{}
		for h := range measuredHosts {
			allowed[h] = true
		}
		client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			mu.Lock()
			ok := allowed[r.URL.Hostname()]
			mu.Unlock()
			to, known := in.Routes[r.URL.Hostname()]
			if !ok || !known {
				return nil, errors.New("unmeasured bootstrap RPC origin")
			}
			u, _ := url.Parse(to)
			r = r.Clone(r.Context())
			r.URL.Scheme, r.URL.Host, r.Host = u.Scheme, u.Host, u.Host
			return http.DefaultTransport.RoundTrip(r)
		})}
		reader, err := NewReader(Config{ChainID: 8453, Ledger: in.Ledger, RPCs: in.Measured, Confirmations: 2, MaxAge: 2 * time.Minute, Client: client,
			AllowOrigin: func(hostport string) {
				h, _, _ := net.SplitHostPort(hostport)
				mu.Lock()
				allowed[h] = true
				admitted = append(admitted, h)
				mu.Unlock()
			}})
		if err != nil {
			t.Fatal(err)
		}
		offset := time.Duration(in.Offset) * time.Second
		reader.now = func() time.Time { return time.Now().Add(offset) }
		var id, app, rt [32]byte
		b, _ := hex.DecodeString(strings.TrimPrefix(c.ID, "0x"))
		copy(id[:], b)
		b, _ = hex.DecodeString(c.AppID)
		copy(app[:], b)
		b, _ = hex.DecodeString(c.RuntimeID)
		copy(rt[:], b)
		pkg, _ := base64.StdEncoding.DecodeString(c.Package)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		auth, err := reader.AuthorizeWhenConfirmed(ctx, id, pkg, Identity{AppID: app, RuntimeID: rt})
		if c.AuthFails != "" {
			cancel()
			mu.Lock()
			n := len(admitted)
			mu.Unlock()
			if err == nil || !strings.Contains(err.Error(), c.AuthFails) || n != 0 {
				t.Errorf("%s: want Authorize to fail with %q and admit no origin, got %v (admitted %d)", c.Name, c.AuthFails, err, n)
			}
			continue
		}
		if err != nil {
			cancel()
			t.Errorf("%s: authorize: %v", c.Name, err)
			continue
		}
		mu.Lock()
		fmt.Printf("ADMITTED %s %s\n", c.Name, strings.Join(admitted, ","))
		mu.Unlock()
		if c.Pause != "" { // the driver changes the chain between authorization and the writer authority
			os.WriteFile(filepath.Join(c.Pause, "authorized"), []byte("1"), 0o644)
			for i := 0; i < 600; i++ {
				if _, e := os.Stat(filepath.Join(c.Pause, "proceed")); e == nil {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		attempts := 0
		t0 := time.Now()
		w, err := WhenFinal(ctx, time.Duration(c.WindowMs)*time.Millisecond, time.Duration(c.StepMs)*time.Millisecond, func(x context.Context) (appconfig.WriterAuthority, error) {
			attempts++
			return auth.WriterAuthority(x)
		})
		cancel()
		fmt.Printf("ATTEMPTS %s %d %dms %v\n", c.Name, attempts, time.Since(t0).Milliseconds(), err)
		switch {
		case c.Code != "":
			var ae *AuthorityError
			if !errors.As(err, &ae) || ae.Code != c.Code {
				t.Errorf("%s: want %s, got %v", c.Name, c.Code, err)
			}
		case c.Contains != "":
			if err == nil || !strings.Contains(err.Error(), c.Contains) {
				t.Errorf("%s: want an error containing %q, got %v", c.Name, c.Contains, err)
			}
		default:
			if err != nil {
				t.Errorf("%s: %v", c.Name, err)
				continue
			}
			j, _ := w.JSON()
			if j != string(c.Fact) {
				t.Errorf("%s: fact\n got %s\nwant %s", c.Name, j, c.Fact)
			}
		}
	}
}
