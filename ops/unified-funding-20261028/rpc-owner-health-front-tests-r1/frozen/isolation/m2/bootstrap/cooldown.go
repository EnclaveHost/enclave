package bootstrap

// Per-source cooldown after EXPLICIT rate refusals (leasegen.go peerLogs; work/storage-front-cold-history-interface.txt).

import (
	"sync"
	"time"
)

var (
	// an EXPLICIT rate refusal (429, -32005, -32011, ...) is retried in place leaseRateRetries times; then the source
	// cools down: it is not asked for leaseCooldown (doubling per consecutive refusal, up to leaseCooldownMax) and is
	// probed again afterwards. While cooling it is a source that may answer later (quorum_unavailable), never empty
	// history, and it never delays the other sources' steps.
	leaseRateRetries = 1
	leaseCooldown    = 30 * time.Second
	leaseCooldownMax = 5 * time.Minute
)

// coolingError: the source is cooling down after its own explicit rate refusal.
type coolingError struct{ until time.Time }

func (e *coolingError) Error() string {
	return "cooling down after a rate refusal until " + e.until.UTC().Format(time.RFC3339)
}

type cooldown struct {
	until time.Time
	next  time.Duration
}

var coolMu sync.Mutex

func (r *Reader) cooling(name string) (time.Time, bool) {
	coolMu.Lock()
	defer coolMu.Unlock()
	if c, ok := r.cool[name]; ok && r.now().Before(c.until) {
		return c.until, true
	}
	return time.Time{}, false
}
func (r *Reader) rateRefused(name string) {
	coolMu.Lock()
	defer coolMu.Unlock()
	if r.cool == nil {
		r.cool = map[string]*cooldown{}
	}
	c, ok := r.cool[name]
	if !ok {
		c = &cooldown{next: leaseCooldown}
		r.cool[name] = c
	}
	c.until = r.now().Add(c.next)
	if c.next *= 2; c.next > leaseCooldownMax {
		c.next = leaseCooldownMax
	}
}
func (r *Reader) answered(name string) {
	coolMu.Lock()
	defer coolMu.Unlock()
	delete(r.cool, name)
}
