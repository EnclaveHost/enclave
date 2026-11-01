//go:build linux && amd64

package rpcservice

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

func TestLocalReadyActualPipeIdentityFreshnessAndEOF(t *testing.T) {
	b := contract.RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
	for _, mode := range []string{"valid", "wrong-nonce", "stale", "future", "short", "extra", "empty", "held-open", "approval"} {
		t.Run(mode, func(t *testing.T) {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			defer w.Close()
			now, err := MonotonicNow()
			if err != nil {
				t.Fatal(err)
			}
			record := contract.RPCLocalReady{Binding: b, ObservedMono: now}
			switch mode {
			case "wrong-nonce":
				record.Binding.Nonce[0]++
			case "stale":
				record.ObservedMono -= contract.RPCLocalReadyFreshnessNS
			case "future":
				record.ObservedMono += uint64(time.Hour)
			}
			frame, err := record.Frame()
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "short":
				frame = frame[:4]
			case "extra":
				frame = append(frame, 0)
			case "empty":
				frame = nil
			case "approval":
				frame, _ = b.Frame()
			}
			if _, err = w.Write(frame); err != nil {
				t.Fatal(err)
			}
			if mode != "held-open" {
				w.Close()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			defer cancel()
			observed, err := readLocalReady(ctx, r, b)
			if (err == nil) != (mode == "valid") {
				t.Fatal(mode, observed, err)
			}
			if err == nil && (observed == observed.Round(0) || time.Since(observed) < 0 || time.Since(observed) >= 4*time.Second) {
				t.Fatal("lost monotonic/freshness")
			}
		})
	}
}

func TestLocalReadyDoesNotExtendDeadline(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0), ready: func(context.Context) (time.Time, error) { return time.Now(), nil }}
	s := supervisor(t, f, 100*time.Millisecond, testTiming)
	done := runAsync(s)
	eventually(t, "local ready", func() bool { return s.State().Phase == PhaseLocalReady })
	observed := s.State().LocalReadyAt
	if observed.IsZero() || !s.State().ClientsStarted {
		t.Fatal(s.State())
	}
	st := await(t, done)
	wantFinal(t, st, OutcomeDeadline, CleanupConfirmed, true)
	if st.LocalReadyAt != observed || !f.allEmpty() {
		t.Fatal("readiness changed deadline or final cleanup")
	}
	if _, err := s.Run(context.Background()); !errors.Is(err, ErrUsed) {
		t.Fatal("restarted after readiness", err)
	}
}

func TestLocalReadyRefusalTerminatesClients(t *testing.T) {
	for _, mode := range []string{"error", "zero", "wall", "future", "stale"} {
		t.Run(mode, func(t *testing.T) {
			f := &fakeBackend{probe: probeReadyAfter(0), ready: func(context.Context) (time.Time, error) {
				n := time.Now()
				switch mode {
				case "error":
					return time.Time{}, errors.New("bad frame")
				case "zero":
					return time.Time{}, nil
				case "wall":
					return n.Round(0), nil
				case "future":
					return n.Add(time.Hour), nil
				default:
					return n.Add(-4 * time.Second), nil
				}
			}}
			s := supervisor(t, f, time.Second, testTiming)
			st := await(t, runAsync(s))
			wantFinal(t, st, OutcomeFailed, CleanupConfirmed, true)
			if !st.LocalReadyAt.IsZero() || !f.allEmpty() {
				t.Fatal(st)
			}
		})
	}
}

func TestLocalReadyBlockedCallbackCannotReviveDeadline(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeBackend{probe: probeReadyAfter(0), ready: func(context.Context) (time.Time, error) { close(entered); <-release; return time.Now(), nil }}
	tm := testTiming
	tm.cleanupBound = 25 * time.Millisecond
	s := supervisor(t, f, 50*time.Millisecond, tm)
	done := runAsync(s)
	<-entered
	st := await(t, done)
	wantFinal(t, st, OutcomeDeadline, CleanupUncertain, true)
	close(release)
	time.Sleep(20 * time.Millisecond)
	if s.State() != st || !st.LocalReadyAt.IsZero() || !f.allEmpty() {
		t.Fatal("late readiness revived state", s.State())
	}
}

func TestLocalReadyCannotSuppressFrontLoss(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0), ready: func(context.Context) (time.Time, error) { return time.Now(), nil }}
	s := supervisor(t, f, time.Second, testTiming)
	done := runAsync(s)
	eventually(t, "ready", func() bool { return s.State().Phase == PhaseLocalReady })
	f.exit(roleFront, nil)
	wantFinal(t, await(t, done), OutcomeFailed, CleanupConfirmed, true)
	if !f.allEmpty() {
		t.Fatal("front loss left clients running")
	}
}
