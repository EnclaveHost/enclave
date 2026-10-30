package bootstrap

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/appconfig"
)

// TestLiveColdHistory (opt-in: LIVE_COLD_HISTORY=<json>): the guest's writer-authority read, THIS code, against the
// LIVE rev-16d ledger on Base through the real measured RPC set (MeasuredConfig, TLS to the measured roots only), with
// and without owner history sources, for live deployments that hold a current lease. Read-only public JSON-RPC: no
// keys, no writes. Prints one LIVE line per read for the result file; it asserts only that a fact, when produced, is
// the same with every source set and passes the replay (the chain's state decides what exists).
func TestLiveColdHistory(t *testing.T) {
	raw := os.Getenv("LIVE_COLD_HISTORY")
	if raw == "" {
		t.Skip("opt-in live read")
	}
	var in struct {
		IDs     []string `json:"ids"`
		History []string `json:"history"`
		Window  int      `json:"windowSec"`
		// the measured-only read's own window: it retries quorum_unavailable, so it would otherwise use the whole window
		MeasuredWindow int `json:"measuredWindowSec"`
		// strict: the history read MUST produce a fact (a live recovery claim), not merely agree when it does
		ExpectFact bool `json:"expectFact"`
	}
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatal(err)
	}
	roots, err := MeasuredRoots()
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}}}
	for _, idHex := range in.IDs {
		var id [32]byte
		b, _ := hex.DecodeString(strings.TrimPrefix(idHex, "0x"))
		copy(id[:], b)
		facts := map[string]string{}
		for _, mode := range []string{"measured-only", "with-history"} {
			conf := MeasuredConfig(client)
			reader, err := NewReader(conf) // a fresh guest: nothing cached
			if err != nil {
				t.Fatal(err)
			}
			var hist []endpoint
			if mode == "with-history" {
				hist = reader.historySources(&History{RPCs: in.History})
			}
			attempts, t0 := 0, time.Now()
			window := in.Window
			if mode == "measured-only" && in.MeasuredWindow > 0 {
				window = in.MeasuredWindow
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Duration(window+60)*time.Second)
			w, err := WhenFinal(ctx, time.Duration(window)*time.Second, 15*time.Second, func(c context.Context) (appconfig.WriterAuthority, error) {
				attempts++
				w, err := reader.writerAuthority(c, id, func(snapshot) error { return nil }, hist)
				if err != nil {
					fmt.Printf("LIVE-ATTEMPT %s %s %d %v\n", idHex[:10], mode, attempts, err)
					// diagnostic checkpoint: the verified finalized coverage this guest holds after the attempt
					if cov, ok := reader.coverage(id); ok {
						fmt.Printf("LIVE-COVERAGE %s %s %d blocks %d-%d (%d logs)\n", idHex[:10], mode, attempts, cov.lo, cov.hi, len(cov.logs))
					} else {
						fmt.Printf("LIVE-COVERAGE %s %s %d none\n", idHex[:10], mode, attempts)
					}
				}
				return w, err
			})
			cancel()
			code := "ok"
			var ae *AuthorityError
			if errors.As(err, &ae) {
				code = ae.Code
			} else if err != nil {
				code = "error"
			}
			j, _ := w.JSON()
			fmt.Printf("LIVE %s %s code=%s attempts=%d seconds=%.0f fact=%s err=%v\n", idHex, mode, code, attempts, time.Since(t0).Seconds(), j, err)
			if err == nil {
				facts[mode] = j
			} else if mode == "with-history" && in.ExpectFact {
				t.Errorf("%s: no writer authority from the history sources: %v", idHex, err)
			}
		}
		if len(facts) == 2 && facts["measured-only"] != facts["with-history"] {
			t.Errorf("%s: the measured-only and history reads disagree: %s vs %s", idHex, facts["measured-only"], facts["with-history"])
		}
	}
}
