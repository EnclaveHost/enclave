package bootstrap

import (
    "context"
    "encoding/json"
    "fmt"
    "sync"
    "testing"
    "time"
)

// Only complete, already-quorum-verified finalized ranges may survive a later
// timeout. A cancelled range must never become cached empty history.
func TestFinalizedHistoryProgressSurvivesLaterRangeDeadline(t *testing.T) {
    oldFrom, oldWindow := leaseFromBlock, leaseWindow
    leaseFromBlock, leaseWindow = 0, 10
    defer func() { leaseFromBlock, leaseWindow = oldFrom, oldWindow }()
    w := newWorld(t, 2)
    threshold := uint64(79)
    var mu sync.Mutex
    ranges := make(map[uint64]int)
    for i, original := range w.r.peers {
        saved := original.call
        w.r.peers[i].call = func(ctx context.Context, method string, params any, out any) error {
            if method == "eth_getBlockByNumber" && params.([]any)[0] == "finalized" {
                return saved(ctx, method, []any{"0x62", false}, out)
            }
            if method != "eth_getLogs" { return saved(ctx, method, params, out) }
            q := params.([]any)[0].(map[string]any)
            var lo uint64
            fmt.Sscanf(q["fromBlock"].(string), "0x%x", &lo)
            mu.Lock()
            ranges[lo]++
            mu.Unlock()
            if lo < threshold { <-ctx.Done(); return ctx.Err() }
            return json.Unmarshal([]byte("[]"), out)
        }
    }
    attempt := func(want uint64) {
        t.Helper()
        ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
        _, err := w.r.LeaseWriterAuthority(ctx, w.id)
        cancel()
        if err == nil { t.Fatal("no claim exists; a completed fact must not be manufactured") }
        cov, ok := w.r.coverage(w.id)
        if !ok || cov.lo != want || cov.hi != 98 {
            t.Fatalf("lost completed finalized history at later deadline: have=%v range=%d..%d want=%d..98; error=%v", ok, cov.lo, cov.hi, want, err)
        }
    }
    attempt(79) // 89..98 and 79..88 were verified; 69..78 was cancelled.
    threshold = 59
    attempt(59) // Continues at 69..78; does not download the completed ranges again.
    mu.Lock()
    defer mu.Unlock()
    if ranges[89] != 2 || ranges[79] != 2 {
        t.Fatalf("already finalized ranges were downloaded again: %v", ranges)
    }
}
