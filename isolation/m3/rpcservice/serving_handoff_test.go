//go:build linux && amd64

package rpcservice

import (
	"context"
	"os"
	"testing"
	"time"
)

// Actual guard sockets/clock/independent watcher joined to the maintained
// Supervisor.Run and fixed-role graph. Client/cgroup backend is deliberately
// simulated; no claim of production process death or chain/storage authority.
func TestServingHandoffThroughOriginalEntryAndSupervisor(t *testing.T) {
	for _, mode := range []string{"expiry", "renew-after-startup", "client-exit", "stop", "wrong-observation", "unready", "blocked-supervisor"} {
		t.Run(mode, func(t *testing.T) {
			rawNow, e := MonotonicNow()
			if e != nil {
				t.Fatal(e)
			}
			originalD := rawNow + uint64(200*time.Millisecond)
			origin := originalD - uint64(StartupWindow)
			h := newServingHandoff()
			f := &fakeBackend{probe: probeReadyAfter(0)}
			observed := time.Now()
			f.ready = func(ctx context.Context) (time.Time, error) {
				if mode == "unready" {
					<-ctx.Done()
					return time.Time{}, ctx.Err()
				}
				h.observed.Store(rawNow)
				return observed, nil
			}
			s := newSupervisor(f, observed.Add(200*time.Millisecond), testTiming)
			s.handoff = h
			originalGo := s.deadline
			a, b := guardPair(t)
			fd, e := GuardSocketFD(b)
			if e != nil {
				t.Fatal(e)
			}
			owner := openTestPidfd(t, os.Getpid())
			defer owner.Close()
			client, e := NewGuardClient(a, origin, originalD)
			if e != nil {
				t.Fatal(e)
			}
			armed, ended := make(chan struct{}), make(chan int, 1)
			go watchServingEntryWithHandoff(int(owner.Fd()), fd, origin, originalD, armed, h, func(n int) { ended <- n })
			<-armed
			result := runAsync(s)
			defer func() { client.Shutdown(); s.Stop() }()
			by := time.Now().Add(time.Second)
			for {
				state := s.State()
				if state.Phase == PhaseLocalReady || (mode == "unready" && state.ClientsStarted) {
					break
				}
				if time.Now().After(by) {
					t.Fatal("fixed role graph did not reach readiness")
				}
				time.Sleep(time.Millisecond)
			}
			binding := GuardBinding{Origin: origin, Deadline: originalD, Observed: rawNow, PreparedSHA256: [32]byte{7}}
			if mode == "wrong-observation" {
				binding.Observed--
			}
			if e = client.Prepare(context.Background(), binding); e != nil {
				t.Fatal(e)
			}
			until := originalD + uint64(180*time.Millisecond)
			switch mode {
			case "blocked-supervisor":
				s.mu.Lock()
				commit := make(chan error, 1)
				go func() { commit <- client.Commit(context.Background(), binding, until) }()
				// The native watcher must terminate while the supervisor lock is HELD.
				select {
				case code := <-ended:
					if code != 124 {
						s.mu.Unlock()
						t.Fatal(code)
					}
				case <-time.After(time.Second):
					s.mu.Unlock()
					t.Fatal("native watcher waited on supervisor lock")
				}
				terminal, _ := MonotonicNow()
				if terminal < originalD || terminal > originalD+uint64(200*time.Millisecond) {
					s.mu.Unlock()
					t.Fatal("original deadline changed")
				}
				s.mu.Unlock()
				if e = <-commit; e == nil {
					t.Fatal("blocked handoff acknowledged")
				}
			case "stop":
				s.Stop()
				if e = client.Commit(context.Background(), binding, until); e == nil {
					t.Fatal("stopped supervisor adopted")
				}
			case "wrong-observation", "unready":
				if e = client.Commit(context.Background(), binding, until); e == nil {
					t.Fatal("unqualified local readiness adopted")
				}
			default:
				if e = client.Commit(context.Background(), binding, until); e != nil {
					t.Fatal(e)
				}
				st := s.State()
				if st.Phase != PhaseServing || st.ServingCommittedAt.IsZero() {
					t.Fatal("commit ack preceded supervisor transition", st)
				}
				if mode == "client-exit" {
					f.exit(roleEL, errKilled)
				} else {
					time.Sleep(time.Until(originalGo.Add(20 * time.Millisecond)))
					if !f.running(roleEL) || s.State().Phase != PhaseServing {
						t.Fatal("clients terminated at old startup cutoff")
					}
					if mode == "renew-after-startup" {
						now, _ := MonotonicNow()
						until = now + uint64(300*time.Millisecond)
						if e = client.Renew(context.Background(), binding, 2, until); e != nil {
							t.Fatal(e)
						}
					}
				}
			}
			select {
			case r := <-result:
				if r.err != nil || r.st.Phase != PhaseTerminated || r.st.Cleanup != CleanupConfirmed || !f.allEmpty() {
					t.Fatal("incomplete cleanup", r)
				}
				if s.deadline != originalGo {
					t.Fatal("original launch deadline changed")
				}
				if mode == "wrong-observation" || mode == "unready" || mode == "stop" || mode == "blocked-supervisor" {
					if !r.st.ServingCommittedAt.IsZero() {
						t.Fatal("refused transition published", r.st)
					}
				}
				terminal, _ := MonotonicNow()
				if mode == "expiry" || mode == "renew-after-startup" {
					if terminal+uint64(5*time.Millisecond) < until || terminal > until+uint64(200*time.Millisecond) {
						t.Fatal("active permit not enforced", terminal, until)
					}
				}
				if mode == "client-exit" && (r.st.Outcome != OutcomeFailed || terminal >= until) {
					t.Fatal("client failure ignored")
				}
			case <-time.After(time.Second):
				t.Fatal("supervisor did not settle")
			}
			if mode != "blocked-supervisor" {
				select {
				case <-ended:
				case <-time.After(time.Second):
					t.Fatal("entry watcher did not end")
				}
			}
		})
	}
}

func TestServingHandoffPendingOfferStillObservesChannelLoss(t *testing.T) {
	now, _ := MonotonicNow()
	d := now + uint64(time.Second)
	origin := d - uint64(StartupWindow)
	a, b := guardPair(t)
	fd, e := GuardSocketFD(b)
	if e != nil {
		t.Fatal(e)
	}
	owner := openTestPidfd(t, os.Getpid())
	defer owner.Close()
	h := newServingHandoff()
	armed, done := make(chan struct{}), make(chan int, 1)
	go watchServingEntryWithHandoff(int(owner.Fd()), fd, origin, d, armed, h, func(n int) { done <- n })
	<-armed
	g, e := NewGuardClient(a, origin, d)
	if e != nil {
		t.Fatal(e)
	}
	binding := GuardBinding{Origin: origin, Deadline: d, Observed: now, PreparedSHA256: [32]byte{3}}
	if e = g.Prepare(context.Background(), binding); e != nil {
		t.Fatal(e)
	}
	raw := guardFrame(2, binding, 1, d+uint64(time.Second))
	if e = sendGuard(g.fd, raw); e != nil {
		t.Fatal(e)
	}
	select {
	case <-h.offers:
	case <-time.After(time.Second):
		t.Fatal("offer missing")
	}
	g.Shutdown()
	select {
	case code := <-done:
		if code != 124 {
			t.Fatal(code)
		}
		terminal, _ := MonotonicNow()
		if terminal >= d {
			t.Fatal("pending supervisor hid channel loss")
		}
	case <-time.After(time.Second):
		t.Fatal("blocked offer hid channel loss")
	}
}
