package rpcservice

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

// No test launches a process or touches a real cgroup. The fake backend models
// role cgroup membership: kill exits members, empty reports no members.

var testTiming = timing{probeTimeout: 2 * time.Second, probeInterval: 5 * time.Millisecond, probeSettle: 20 * time.Millisecond, cleanupBound: 300 * time.Millisecond, poll: time.Millisecond}

var errKilled = errors.New("killed by cgroup.kill")

type fakeProc struct {
	once sync.Once
	done chan struct{}
	err  error
}

func (p *fakeProc) Wait() error { <-p.done; return p.err }

type fakeBackend struct {
	mu       sync.Mutex
	starts   []role
	alive    [roleCount][]*fakeProc
	probes   int
	hook     func(r role) // runs at Start entry, outside the lock; may block
	startErr [roleCount]error
	probe    func(attempt int) (exits bool, err error) // nil: every probe hangs
	stuck    [roleCount]bool                           // cgroup.kill leaves members
	killErr  [roleCount]error
}

func (f *fakeBackend) start(r role) (process, error) {
	if f.hook != nil {
		f.hook(r)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts = append(f.starts, r)
	if f.startErr[r] != nil {
		return nil, f.startErr[r]
	}
	p := &fakeProc{done: make(chan struct{})}
	f.alive[r] = append(f.alive[r], p)
	if r == roleProbe && f.probe != nil {
		attempt := f.probes
		f.probes++
		if exits, err := f.probe(attempt); exits {
			f.exitLocked(r, err)
		}
	}
	return p, nil
}

func (f *fakeBackend) exitLocked(r role, err error) {
	for _, p := range f.alive[r] {
		p.once.Do(func() { p.err = err; close(p.done) })
	}
	f.alive[r] = nil
}

func (f *fakeBackend) exit(r role, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.exitLocked(r, err)
}

func (f *fakeBackend) kill(r role) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.killErr[r] != nil {
		return f.killErr[r]
	}
	if !f.stuck[r] {
		f.exitLocked(r, errKilled)
	}
	return nil
}

func (f *fakeBackend) empty(r role) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.alive[r]) == 0, nil
}

func (f *fakeBackend) order() []role {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.starts)
}

func (f *fakeBackend) allEmpty() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range allRoles {
		if len(f.alive[r]) != 0 {
			return false
		}
	}
	return true
}

func (f *fakeBackend) running(r role) bool {
	e, _ := f.empty(r)
	return !e
}

func probeReadyAfter(n int) func(int) (bool, error) {
	return func(attempt int) (bool, error) {
		if attempt < n {
			return true, errors.New("l1 not ready")
		}
		return true, nil
	}
}

// supervisor derives the deadline through originDeadline from an origin that
// leaves `remaining` of the original window.
func supervisor(t *testing.T, f *fakeBackend, remaining time.Duration, tm timing) *Supervisor {
	t.Helper()
	deadline, err := originDeadline(time.Now().Add(remaining - StartupWindow))
	if err != nil {
		t.Fatal(err)
	}
	return newSupervisor(f, deadline, tm)
}

type result struct {
	st  State
	err error
}

func runAsync(s *Supervisor) <-chan result {
	ch := make(chan result, 1)
	go func() { st, err := s.Run(context.Background()); ch <- result{st, err} }()
	return ch
}

func await(t *testing.T, ch <-chan result) State {
	t.Helper()
	select {
	case r := <-ch:
		if r.err != nil {
			t.Fatal(r.err)
		}
		return r.st
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return")
		return State{}
	}
}

func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	limit := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(limit) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func wantOrder(t *testing.T, f *fakeBackend, want ...role) {
	t.Helper()
	if got := f.order(); !slices.Equal(got, want) {
		t.Fatalf("start order %v, want %v", got, want)
	}
}

func wantFinal(t *testing.T, st State, outcome Outcome, cleanup Cleanup, started bool) {
	t.Helper()
	if st.Phase != PhaseTerminated || st.Outcome != outcome || st.Cleanup != cleanup || st.ClientsStarted != started {
		t.Fatalf("final state %+v, want outcome %s cleanup %s clientsStarted %v", st, outcome, cleanup, started)
	}
}

func TestFixedRoleGraphConstants(t *testing.T) {
	if got := argv(roleBase); !slices.Equal(got, []string{"/usr/bin/python3", "-I", "-B", "/opt/enclave-rpc/chain_service.py", "base"}) {
		t.Fatalf("base argv %v", got)
	}
	if got := argv(roleProbe); got[len(got)-1] != "l1-ready" {
		t.Fatalf("probe argv %v", got)
	}
	var sum uint64
	for _, r := range allRoles {
		sum += roleLimits[r].memory
	}
	if sum > parentMemory || roleLimits[roleProbe].memory != 128<<20 || roleLimits[roleCL].memory != 7<<30 {
		t.Fatalf("role budgets %v exceed or differ from the fixed parent budget", roleLimits)
	}
	if c := roleControls(roleEL); c[0] != [2]string{"memory.max", "5368709120"} || c[1] != [2]string{"memory.swap.max", "0"} || c[2] != [2]string{"memory.oom.group", "1"} {
		t.Fatalf("el controls %v", c)
	}
}

func TestOriginValidation(t *testing.T) {
	now := time.Now()
	for name, origin := range map[string]time.Time{
		"zero":         {},
		"future":       now.Add(time.Minute),
		"expired":      now.Add(-StartupWindow - time.Second),
		"no monotonic": now.Add(-time.Second).Round(0),
	} {
		if _, err := originDeadline(origin); err == nil {
			t.Errorf("%s origin accepted", name)
		}
	}
	origin := time.Now().Add(-time.Minute)
	d, err := originDeadline(origin)
	if err != nil || !d.Equal(origin.Add(StartupWindow)) {
		t.Fatalf("deadline %v %v, want exactly origin+900s", d, err)
	}
}

func TestNewRefusesMissingCapabilities(t *testing.T) {
	if _, err := New(Request{Origin: time.Now()}); err == nil {
		t.Fatal("New accepted absent cgroup descriptors")
	}
	if _, err := New(Request{}); err == nil {
		t.Fatal("New accepted a zero origin")
	}
}

func TestBaseOnlyAfterSuccessfulProbe(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(2)}
	s := supervisor(t, f, time.Minute, testTiming)
	if s.State().Phase != PhaseNew || len(f.order()) != 0 {
		t.Fatal("construction launched work")
	}
	ch := runAsync(s)
	eventually(t, "clients started", func() bool { return s.State().ClientsStarted })
	if s.State().Phase != PhaseClientsStarted {
		t.Fatalf("phase %s", s.State().Phase)
	}
	wantOrder(t, f, roleEL, roleCL, roleProbe, roleProbe, roleProbe, roleBase)
	s.Stop()
	wantFinal(t, await(t, ch), OutcomeStopped, CleanupConfirmed, true)
	if !f.allEmpty() {
		t.Fatal("stop left role groups populated")
	}
}

func TestNoBaseWhenProbeNeverSucceedsBeforeDeadline(t *testing.T) {
	f := &fakeBackend{probe: func(int) (bool, error) { return true, errors.New("l1 syncing") }}
	s := supervisor(t, f, 150*time.Millisecond, testTiming)
	st := await(t, runAsync(s))
	wantFinal(t, st, OutcomeDeadline, CleanupConfirmed, false)
	if slices.Contains(f.order(), roleBase) || !f.allEmpty() {
		t.Fatalf("base launched or groups populated: %v", f.order())
	}
}

func TestOriginalDeadlineTerminatesStartedClients(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, 200*time.Millisecond, testTiming)
	st := await(t, runAsync(s))
	if time.Now().Before(s.deadline) {
		t.Fatal("Run returned before the original deadline")
	}
	wantFinal(t, st, OutcomeDeadline, CleanupConfirmed, true)
	if !f.allEmpty() {
		t.Fatal("deadline left clients running")
	}
}

func TestLateEntryLaunchesNothing(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, 10*time.Millisecond, testTiming)
	time.Sleep(20 * time.Millisecond)
	wantFinal(t, await(t, runAsync(s)), OutcomeDeadline, CleanupConfirmed, false)
	wantOrder(t, f)
}

func TestLateProbeKilledAtOriginalDeadline(t *testing.T) {
	f := &fakeBackend{} // probe hangs; its own timeout exceeds the remaining window
	s := supervisor(t, f, 150*time.Millisecond, testTiming)
	st := await(t, runAsync(s))
	if time.Now().After(s.deadline.Add(testTiming.cleanupBound + time.Second)) {
		t.Fatal("probe extended the original deadline")
	}
	wantFinal(t, st, OutcomeDeadline, CleanupConfirmed, false)
	wantOrder(t, f, roleEL, roleCL, roleProbe)
	if !f.allEmpty() {
		t.Fatal("late probe survived")
	}
}

func TestProbeTimeoutKillsProbeBeforeRetry(t *testing.T) {
	tm := testTiming
	tm.probeTimeout = 30 * time.Millisecond
	f := &fakeBackend{}
	f.probe = func(attempt int) (bool, error) { return attempt > 0, nil }
	var overlap bool
	f.hook = func(r role) {
		if r == roleProbe && f.running(roleProbe) {
			overlap = true
		}
	}
	s := supervisor(t, f, time.Minute, tm)
	ch := runAsync(s)
	eventually(t, "clients started", func() bool { return s.State().ClientsStarted })
	s.Stop()
	wantFinal(t, await(t, ch), OutcomeStopped, CleanupConfirmed, true)
	wantOrder(t, f, roleEL, roleCL, roleProbe, roleProbe, roleBase)
	if overlap {
		t.Fatal("probe retried while the previous probe group was populated")
	}
}

func TestStopDuringBlockedStartUnresolved(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	entered, release := make(chan struct{}), make(chan struct{})
	f.hook = func(r role) {
		if r == roleCL {
			close(entered)
			<-release
		}
	}
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	<-entered
	s.Stop()
	st := await(t, ch)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, false)
	if !strings.Contains(st.Reason, "unresolved") {
		t.Fatalf("reason %q", st.Reason)
	}
	close(release)
	eventually(t, "late cl start killed", func() bool { return len(f.order()) == 2 && f.allEmpty() })
	time.Sleep(20 * time.Millisecond)
	wantOrder(t, f, roleEL, roleCL)
	if s.State() != st {
		t.Fatal("terminal state changed after Run returned")
	}
}

func TestStopDuringBlockedStartResolvedInCleanup(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	entered, release := make(chan struct{}), make(chan struct{})
	f.hook = func(r role) {
		if r == roleCL {
			close(entered)
			<-release
		}
	}
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	<-entered
	s.Stop()
	time.AfterFunc(30*time.Millisecond, func() { close(release) })
	wantFinal(t, await(t, ch), OutcomeStopped, CleanupConfirmed, false)
	wantOrder(t, f, roleEL, roleCL)
	if !f.allEmpty() {
		t.Fatal("process placed by the drained start survived")
	}
}

func TestStopDuringProbe(t *testing.T) {
	f := &fakeBackend{}
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	eventually(t, "probe running", func() bool { return f.running(roleProbe) })
	s.Stop()
	wantFinal(t, await(t, ch), OutcomeStopped, CleanupConfirmed, false)
	wantOrder(t, f, roleEL, roleCL, roleProbe)
	if !f.allEmpty() {
		t.Fatal("stop left work running")
	}
}

func TestSpontaneousELExitKillsGroups(t *testing.T) {
	f := &fakeBackend{}
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	eventually(t, "probe running", func() bool { return f.running(roleProbe) })
	f.exit(roleEL, errors.New("crashed"))
	st := await(t, ch)
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	if !strings.Contains(st.Reason, "el wrapper exited") || !f.allEmpty() || slices.Contains(f.order(), roleBase) {
		t.Fatalf("state %+v order %v", st, f.order())
	}
}

func TestSpontaneousCLExitAfterClientsStarted(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	eventually(t, "clients started", func() bool { return s.State().ClientsStarted })
	f.exit(roleCL, nil)
	st := await(t, ch)
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, true)
	if !strings.Contains(st.Reason, "cl wrapper exited") || !f.allEmpty() {
		t.Fatalf("state %+v", st)
	}
}

func TestPartialStartupFailure(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	f.startErr[roleCL] = errors.New("clone3: operation not supported")
	st := await(t, runAsync(supervisor(t, f, time.Minute, testTiming)))
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	if !strings.Contains(st.Reason, "start cl") || !f.allEmpty() {
		t.Fatalf("state %+v", st)
	}
	wantOrder(t, f, roleEL, roleCL)
}

func TestBaseStartFailure(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	f.startErr[roleBase] = errors.New("exec format error")
	st := await(t, runAsync(supervisor(t, f, time.Minute, testTiming)))
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	wantOrder(t, f, roleEL, roleCL, roleProbe, roleBase)
	if !f.allEmpty() {
		t.Fatal("L1 clients survived a failed Base start")
	}
}

func TestOneShot(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, time.Minute, testTiming)
	s.Stop()
	st, err := s.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	wantFinal(t, st, OutcomeStopped, CleanupConfirmed, false)
	if _, err := s.Run(context.Background()); !errors.Is(err, ErrUsed) {
		t.Fatalf("second Run: %v", err)
	}
	wantOrder(t, f)

	f2 := &fakeBackend{}
	f2.startErr[roleEL] = errors.New("no")
	s2 := supervisor(t, f2, time.Minute, testTiming)
	await(t, runAsync(s2))
	if _, err := s2.Run(context.Background()); !errors.Is(err, ErrUsed) {
		t.Fatalf("Run after failure: %v", err)
	}
	wantOrder(t, f2, roleEL)
}

func TestCleanupUncertainWhenGroupStaysPopulated(t *testing.T) {
	f := &fakeBackend{}
	f.stuck[roleEL] = true
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	eventually(t, "probe running", func() bool { return f.running(roleProbe) })
	s.Stop()
	st := await(t, ch)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, false)
	if !strings.Contains(st.Reason, "el cgroup still populated") {
		t.Fatalf("reason %q", st.Reason)
	}
}

func TestCleanupUncertainWhenKillFails(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	f.killErr[roleBase] = errors.New("bad file descriptor")
	s := supervisor(t, f, time.Minute, testTiming)
	ch := runAsync(s)
	eventually(t, "clients started", func() bool { return s.State().ClientsStarted })
	s.Stop()
	st := await(t, ch)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, true)
	if !strings.Contains(st.Reason, "base cgroup.kill") {
		t.Fatalf("reason %q", st.Reason)
	}
}

func TestCallerContextCancelStops(t *testing.T) {
	f := &fakeBackend{}
	s := supervisor(t, f, time.Minute, testTiming)
	ctx, cancel := context.WithCancel(context.Background())
	ch := make(chan result, 1)
	go func() { st, err := s.Run(ctx); ch <- result{st, err} }()
	eventually(t, "probe running", func() bool { return f.running(roleProbe) })
	cancel()
	wantFinal(t, await(t, ch), OutcomeStopped, CleanupConfirmed, false)
	if !f.allEmpty() {
		t.Fatal("cancel left work running")
	}
}
