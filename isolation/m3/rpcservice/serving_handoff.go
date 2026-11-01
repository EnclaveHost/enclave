package rpcservice

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"enclave.host/isolation/contract"
)

// Process-local connection between the native entry's independent watcher and
// its fixed-role supervisor. No exported constructor, journal rehydration, host
// path, or caller supplied replacement for the original guardian capability.
type servingHandoff struct {
	offers   chan *servingOffer
	lost     chan struct{}
	once     sync.Once
	observed atomic.Uint64 // original raw private front observation, set once by OS backend
}
type servingOffer struct {
	binding          GuardBinding
	sequence, expiry uint64
	accepted         chan bool // buffered: supervisor never blocks on an acknowledgement
}

func newServingHandoff() *servingHandoff {
	return &servingHandoff{offers: make(chan *servingOffer, 1), lost: make(chan struct{})}
}
func (h *servingHandoff) fail() {
	if h != nil {
		h.once.Do(func() { close(h.lost) })
	}
}

// Called only by Run's control loop. It may take the supervisor lock, but the
// independent native watcher never does: it continues enforcing the PRIOR
// expiry/owner/channel checks while this offer is pending.
func (s *Supervisor) acceptServing(ctx context.Context, o *servingOffer, prior time.Time) (time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	bad := errors.New("serving handoff is not current/live/local-ready")
	now := time.Now()
	if s.handoff == nil || o == nil || ctx.Err() != nil || s.closing || s.stopped || !now.Before(prior) || o.expiry == 0 {
		return time.Time{}, bad
	}
	select {
	case <-s.handoff.lost:
		return time.Time{}, bad
	default:
	}
	// Convert the authenticated same-kernel absolute expiry once using the
	// EARLIER Go sample, making scheduling delay conservative, never a new clock.
	raw, e := MonotonicNow()
	if e != nil || o.expiry <= raw || o.expiry-raw > uint64(30*time.Second) {
		return time.Time{}, bad
	}
	until := now.Add(time.Duration(o.expiry - raw))
	if o.sequence == 1 {
		if !now.Before(s.deadline) || s.state.Phase != PhaseLocalReady || !s.state.ClientsStarted || s.starting != nil ||
			s.state.LocalReadyAt.IsZero() || now.Before(s.state.LocalReadyAt) || now.Sub(s.state.LocalReadyAt) >= time.Duration(contract.RPCLocalReadyFreshnessNS) ||
			s.handoff.observed.Load() == 0 || s.handoff.observed.Load() != o.binding.Observed || raw < o.binding.Observed || raw-o.binding.Observed >= contract.RPCLocalReadyFreshnessNS || s.servingSequence != 0 {
			return time.Time{}, bad
		}
	} else {
		if s.state.Phase != PhaseServing || s.servingSequence == 0 || o.sequence != s.servingSequence+1 || o.binding != s.servingBinding || !until.After(prior) {
			return time.Time{}, bad
		}
	}
	if !time.Now().Before(prior) || !time.Now().Before(until) || ctx.Err() != nil {
		return time.Time{}, bad
	}
	if o.sequence == 1 {
		s.servingBinding = o.binding
		s.state.ServingCommittedAt = now
	} // historical local commit only
	s.servingSequence = o.sequence
	s.state.Phase = PhaseServing
	return until, nil
}
