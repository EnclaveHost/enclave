// Package rpcservice supervises the fixed native chain wrappers of the RPC
// companion INSIDE the attested dedicated CPU app domain. It is a process
// control adapter, not a host launcher, an external provider proxy, or proof of
// an attested deployment. Nothing runs on import; New only validates borrowed
// capabilities and Run launches at most once.
//
// The supervisor classifies startup qualification only. It emits
// PhaseClientsStarted (all three wrapper processes launched, the Base launch
// preceded by a successful local l1-ready probe) and never claims serving
// readiness. Whole-stack readiness belongs to the portable controller. No
// deadline handoff exists: every launched process is terminated at the
// original origin+900s deadline.
package rpcservice

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// StartupWindow is the contract's original startup policy. The deadline is
// fixed at origin+StartupWindow and is never reset by a launch, probe or gate.
const StartupWindow = 900 * time.Second

// The maintained wrapper retains chain identity, snapshot, pruning, Base
// coverage and local-L1-only checks, then execs the pinned clients. This
// package adds no client flags. The interpreter, its standard library and the
// wrapper must be on the measured read-only root; New only checks read-only.
const (
	interpreter = "/usr/bin/python3"
	wrapper     = "/opt/enclave-rpc/chain_service.py"
	workDir     = "/"
)

const (
	controllerRuntimeDir = "/plat/rt"
	controllerLoader     = controllerRuntimeDir + "/ld-linux-x86-64.so.2"
	controllerRuntime    = controllerRuntimeDir + "/wasmtime"
	controllerWasm       = "/app.wasm"
)

func cleanEnv() []string { return []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"} }

type role int

const (
	roleEL role = iota
	roleCL
	roleBase
	roleProbe
	roleController
	roleFront
	roleCount
)

var allRoles = []role{roleEL, roleCL, roleBase, roleProbe, roleController, roleFront}
var roleNames = [roleCount]string{"el", "cl", "base", "probe", "controller", "front"}
var roleArgs = [roleCount]string{"el", "cl", "base", "l1-ready"}

func (r role) String() string { return roleNames[r] }

// argv is fixed per role. -I ignores PYTHON* environment and user site; -B
// writes no bytecode. No exported value can change it.
func argv(r role) []string {
	if r == roleFront {
		return []string{"/plat/front", "-listen-unix", "/run/front/front.sock", "-report-unix", "/run/front/monitor.sock", "-runtime-identity", "/plat/rt/runtime.json", "-app-mode", "run", "-upstream", "127.0.0.1:8000"}
	}
	if r == roleController {
		// Same measured loader/runtime layout as domexec, but no filesystem,
		// environment, DNS or UDP capability is granted to this fixed controller.
		return []string{controllerLoader, "--library-path", controllerRuntimeDir,
			controllerRuntime, "run", "-S", "cli,tcp=y,udp=n,inherit-network=y,allow-ip-name-lookup=n",
			"-C", "cache=n,parallel-compilation=n", "-W", "max-memory-size=67108864", controllerWasm}
	}
	return []string{interpreter, "-I", "-B", wrapper, roleArgs[r]}
}

// Fixed budgets. The trusted monitor creates and configures these cgroups;
// New verifies exact readback only. They are proposals, not measured fit.
const parentMemory = 19 << 30
const parentCPUMax = "400000 100000"
const roleCPUMax = "max 100000" // every role is bounded by the parent's 400% cap

var roleLimits = [roleCount]struct {
	memory uint64
	pids   int
}{
	roleEL:         {5 << 30, 1024},
	roleCL:         {7 << 30, 1024},
	roleBase:       {5 << 30, 1024},
	roleProbe:      {128 << 20, 64},
	roleController: {256 << 20, 128},
	roleFront:      {256 << 20, 128},
}

func roleControls(r role) [][2]string {
	l := roleLimits[r]
	return [][2]string{{"memory.max", fmt.Sprint(l.memory)}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"cpu.max", roleCPUMax}, {"pids.max", fmt.Sprint(l.pids)}}
}

func parentControls() [][2]string {
	return [][2]string{{"memory.max", fmt.Sprint(uint64(parentMemory))}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"pids.max", "4096"}, {"cgroup.type", "domain"}, {"cpu.max", parentCPUMax}}
}

// Groups are cgroup v2 directory descriptors already created, configured and
// held by the trusted monitor: the shared parent and one direct child per
// role. They are borrowed. The supervisor never closes them; the caller may
// release them only after Run returns CleanupConfirmed and must retain them
// (and poison the domain) after CleanupUncertain.
type Groups struct {
	Parent, EL, CL, Base, Probe, Controller, Front *os.File
}

// Request carries no commands, paths or budgets. Origin is the trusted
// caller's original startup time, taken from time.Now in this process.
type Request struct {
	Origin time.Time
	Groups Groups
}

type Phase string

const (
	PhaseNew                Phase = "new"
	PhaseAuthorizingOwner   Phase = "authorizing-owner"
	PhaseStartingController Phase = "starting-controller"
	PhaseStartingL1         Phase = "starting-l1"
	PhaseProbingL1          Phase = "probing-l1"
	PhaseStartingBase       Phase = "starting-base"
	PhaseClientsStarted     Phase = "clients-started" // processes launched; not serving readiness
	PhaseTerminated         Phase = "terminated"
)

type Outcome string

const (
	OutcomeDeadline Outcome = "deadline" // original deadline reached; see ClientsStarted
	OutcomeStopped  Outcome = "stopped"
	OutcomeFailed   Outcome = "failed"
)

type Cleanup string

const (
	CleanupConfirmed Cleanup = "confirmed" // no start in flight and every role cgroup reported populated 0
	CleanupUncertain Cleanup = "uncertain" // retain every resource; never reuse the domain
)

// State is a snapshot. ClientsStarted records that startup qualified before
// the original deadline; it never implies RPC readiness or later liveness.
type State struct {
	Phase          Phase
	ClientsStarted bool
	Outcome        Outcome
	Cleanup        Cleanup
	Reason         string
}

var ErrUsed = errors.New("rpcservice: supervisor is single-use")
var errClosed = errors.New("supervisor is stopping")
var errPopulated = errors.New("cgroup still populated")

// backend is the internal OS capability: fixed-role launch into a role cgroup,
// cgroup.kill, and kernel population readback. Tests inject a fake.
type backend interface {
	start(r role) (process, error)
	ownerApproval(context.Context) error
	kill(r role) error
	empty(r role) (bool, error)
}

type process interface{ Wait() error }

type timing struct {
	probeTimeout, probeInterval, probeSettle, cleanupBound, poll time.Duration
}

// The probe timeout is not measured against l1_ready's worst case; every
// attempt is additionally cut off by the original deadline.
var defaultTiming = timing{probeTimeout: 150 * time.Second, probeInterval: 10 * time.Second, probeSettle: 2 * time.Second, cleanupBound: 15 * time.Second, poll: 20 * time.Millisecond}

type Supervisor struct {
	be       backend
	deadline time.Time
	t        timing

	used     atomic.Bool
	stopOnce sync.Once
	stop     chan struct{}

	mu       sync.Mutex
	state    State
	stopped  bool
	closing  bool          // cleanup began: no further start permit
	starting chan struct{} // non-nil while a Start call is unresolved
}

// New validates the origin and the borrowed cgroup capabilities. It launches
// nothing.
func New(req Request) (*Supervisor, error) {
	deadline, err := originDeadline(req.Origin)
	if err != nil {
		return nil, err
	}
	be, err := openBackend(req.Groups)
	if err != nil {
		return nil, err
	}
	return newSupervisor(be, deadline, defaultTiming), nil
}

func newSupervisor(be backend, deadline time.Time, t timing) *Supervisor {
	return &Supervisor{be: be, deadline: deadline, t: t, stop: make(chan struct{}), state: State{Phase: PhaseNew}}
}

// originDeadline requires a monotonic reading so clock steps cannot move the
// deadline, and an origin inside the window. A late entry is refused here and
// again by every launch.
func originDeadline(origin time.Time) (time.Time, error) {
	// == compares the monotonic reading too; Round(0) strips it.
	if origin.IsZero() || origin == origin.Round(0) {
		return time.Time{}, errors.New("rpcservice: origin must carry this process's monotonic clock reading")
	}
	elapsed := time.Since(origin)
	if elapsed < 0 || elapsed >= StartupWindow {
		return time.Time{}, errors.New("rpcservice: origin is outside the original startup window")
	}
	return origin.Add(StartupWindow), nil
}

func (s *Supervisor) State() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// Stop requests termination of all launched work. It does not wait; Run
// returns the final State. Stop before Run makes Run launch nothing.
func (s *Supervisor) Stop() {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()
	s.stopOnce.Do(func() { close(s.stop) })
}

// Run executes the fixed role graph once and returns after bounded cleanup.
// Cancelling ctx is equivalent to Stop.
func (s *Supervisor) Run(ctx context.Context) (State, error) {
	if !s.used.CompareAndSwap(false, true) {
		return s.State(), ErrUsed
	}
	return s.run(ctx), nil
}

func (s *Supervisor) run(parent context.Context) State {
	// The deadline timer and this loop are the watchdog. Both are armed before
	// the first launch and neither depends on the launching goroutine, which
	// may be stuck inside a Start system call that no context can interrupt.
	ctx, cancel := context.WithDeadline(parent, s.deadline)
	defer cancel()
	exits := make(chan role, roleCount)
	driven := make(chan error, 1)
	driveDone := make(chan struct{})
	go func() { defer close(driveDone); driven <- s.drive(ctx, exits) }()
	var outcome Outcome
	var reason string
	for outcome == "" {
		select {
		case <-s.stop:
			outcome, reason = OutcomeStopped, "stop requested"
		case <-ctx.Done():
			outcome, reason = s.ended()
		case r := <-exits:
			outcome, reason = OutcomeFailed, r.String()+" wrapper exited"
		case err := <-driven:
			driven = nil
			if err == nil {
				continue // clients started; supervise until the original deadline
			}
			outcome, reason = OutcomeFailed, err.Error()
			if s.isStopped() {
				outcome, reason = OutcomeStopped, "stop requested"
			} else if ctx.Err() != nil {
				outcome, reason = s.ended()
			}
		}
	}
	cancel()
	// Kernel control operations can themselves stall. Bound the caller's wait,
	// retain every descriptor on uncertainty, and never infer death from timeout.
	type cleanupResult struct {
		status Cleanup
		detail string
	}
	cleaned := make(chan cleanupResult, 1)
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	go func() { c, d := s.cleanup(driveDone); cleaned <- cleanupResult{c, d} }()
	cleanup, detail := CleanupUncertain, "cleanup did not complete within its bound"
	bound := time.NewTimer(s.t.cleanupBound + s.t.poll)
	select {
	case c := <-cleaned:
		cleanup, detail = c.status, c.detail
	case <-bound.C:
	}
	bound.Stop()
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Phase = PhaseTerminated
	s.state.Outcome = outcome
	s.state.Cleanup = cleanup
	s.state.Reason = reason
	if detail != "" {
		s.state.Reason += "; cleanup uncertain: " + detail
	}
	return s.state
}

func (s *Supervisor) ended() (Outcome, string) {
	if !time.Now().Before(s.deadline) {
		return OutcomeDeadline, "original startup deadline reached"
	}
	return OutcomeStopped, "caller context ended"
}

func (s *Supervisor) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

func (s *Supervisor) setPhase(p Phase) {
	s.mu.Lock()
	if !s.closing {
		s.state.Phase = p
	}
	s.mu.Unlock()
}

// drive is the fixed graph: front and owner approval, controller once, EL and CL once, then l1-ready observation, then
// exactly one Base launch. No start is ever retried.
func (s *Supervisor) drive(ctx context.Context, exits chan<- role) error {
	s.setPhase(PhaseAuthorizingOwner)
	if err := s.launchClient(ctx, roleFront, exits); err != nil {
		return err
	}
	if err := s.be.ownerApproval(ctx); err != nil {
		return fmt.Errorf("owner startup approval: %w", err)
	}
	s.setPhase(PhaseStartingController)
	if err := s.launchClient(ctx, roleController, exits); err != nil {
		return err
	}
	s.setPhase(PhaseStartingL1)
	for _, r := range []role{roleEL, roleCL} {
		if err := s.launchClient(ctx, r, exits); err != nil {
			return err
		}
	}
	s.setPhase(PhaseProbingL1)
	if err := s.awaitL1(ctx); err != nil {
		return err
	}
	s.setPhase(PhaseStartingBase)
	if err := s.launchClient(ctx, roleBase, exits); err != nil {
		return err
	}
	s.mu.Lock()
	if !s.closing && !s.stopped && time.Now().Before(s.deadline) {
		s.state.Phase = PhaseClientsStarted
		s.state.ClientsStarted = true
	}
	s.mu.Unlock()
	return nil
}

type child struct {
	done chan struct{}
	err  error // valid after done closes
}

func (s *Supervisor) launchClient(ctx context.Context, r role, exits chan<- role) error {
	c, err := s.launch(ctx, r)
	if err != nil {
		return err
	}
	go func() { <-c.done; exits <- r }() // buffered: one send per client role
	return nil
}

// launch holds the start permit. Cleanup sets closing under the same lock and
// treats a non-nil starting channel as an unresolved start that may still
// place a process after a kill.
func (s *Supervisor) launch(ctx context.Context, r role) (*child, error) {
	s.mu.Lock()
	if s.closing || s.stopped || ctx.Err() != nil || !time.Now().Before(s.deadline) {
		s.mu.Unlock()
		return nil, fmt.Errorf("refusing %s start: %w", r, errClosed)
	}
	pending := make(chan struct{})
	s.starting = pending
	s.mu.Unlock()

	p, err := s.be.start(r)

	s.mu.Lock()
	s.starting = nil
	late := s.closing || s.stopped
	s.mu.Unlock()
	close(pending)
	if err != nil {
		return nil, fmt.Errorf("start %s: %w", r, err)
	}
	c := &child{done: make(chan struct{})}
	go func() { c.err = p.Wait(); close(c.done) }()
	if late {
		_ = s.be.kill(r) // cleanup owns the verdict; this only shortens a late start
		return nil, fmt.Errorf("%s started after stop: %w", r, errClosed)
	}
	return c, nil
}

// awaitL1 retries observation only, at a finite interval, while the original
// window remains.
func (s *Supervisor) awaitL1(ctx context.Context) error {
	for {
		ok, err := s.probeOnce(ctx)
		if err != nil || ok {
			return err
		}
		t := time.NewTimer(s.t.probeInterval)
		select {
		case <-ctx.Done():
			t.Stop()
			return ctx.Err()
		case <-t.C:
		}
	}
}

func (s *Supervisor) probeOnce(ctx context.Context) (bool, error) {
	c, err := s.launch(ctx, roleProbe)
	if err != nil {
		return false, err
	}
	t := time.NewTimer(s.t.probeTimeout)
	defer t.Stop()
	select {
	case <-c.done:
		clean, err := s.settleProbe(ctx, c, true)
		return err == nil && clean && c.err == nil, err
	case <-t.C:
		_, err := s.settleProbe(ctx, c, false)
		return false, err
	case <-ctx.Done():
		return false, ctx.Err() // Run's cleanup kills the probe group
	}
}

// settleProbe confirms that no probe process or descendant survives an
// attempt before success counts or another attempt starts. clean is false if
// a kill was needed; such an attempt never counts as success.
func (s *Supervisor) settleProbe(ctx context.Context, c *child, exited bool) (bool, error) {
	if exited && s.waitEmpty(ctx, s.t.probeSettle, roleProbe) == nil {
		return true, nil
	}
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if err := s.be.kill(roleProbe); err != nil {
		return false, fmt.Errorf("probe cgroup.kill: %w", err)
	}
	t := time.NewTimer(s.t.cleanupBound)
	defer t.Stop()
	select {
	case <-c.done:
	case <-ctx.Done():
		return false, ctx.Err()
	case <-t.C:
		return false, errors.New("probe did not exit after cgroup.kill")
	}
	return false, s.waitEmpty(ctx, s.t.cleanupBound, roleProbe)
}

func (s *Supervisor) waitEmpty(ctx context.Context, bound time.Duration, roles ...role) error {
	limit := time.Now().Add(bound)
	for {
		populated := ""
		for _, r := range roles {
			empty, err := s.be.empty(r)
			if err != nil {
				return fmt.Errorf("%s cgroup.events: %w", r, err)
			}
			if !empty && populated == "" {
				populated = r.String()
			}
		}
		if populated == "" {
			return nil
		}
		if !time.Now().Before(limit) {
			return fmt.Errorf("%s %w", populated, errPopulated)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.t.poll):
		}
	}
}

func (s *Supervisor) killAll() error {
	// A stalled control write for one role must not prevent attempts to kill
	// the other roles. The outer cleanup timer bounds waiting for all replies.
	results := make(chan error, roleCount)
	for _, r := range allRoles {
		go func(r role) {
			err := s.be.kill(r)
			if err != nil {
				err = fmt.Errorf("%s cgroup.kill: %w", r, err)
			}
			results <- err
		}(r)
	}
	var errs []error
	for range allRoles {
		if err := <-results; err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// cleanup revokes the start permit, kills every role group (launched or not),
// drains any in-flight start, kills again, and claims success only when every
// role group reports populated 0 within the bound.
func (s *Supervisor) cleanup(driveDone <-chan struct{}) (Cleanup, string) {
	s.mu.Lock()
	s.closing = true
	pending := s.starting
	s.mu.Unlock()
	limit := time.Now().Add(s.t.cleanupBound)
	err := s.killAll()
	if pending != nil {
		t := time.NewTimer(time.Until(limit))
		select {
		case <-pending:
			t.Stop()
		case <-t.C:
			return CleanupUncertain, "a process start is still unresolved"
		}
		// The resolved start may have placed a process after the first kill.
		err = errors.Join(err, s.killAll())
	}
	// A drained Start alone is insufficient: drive may still be killing or
	// observing a probe or a late child. No capability may be released while
	// that routine can use it, even if cgroup.events already says empty.
	t := time.NewTimer(time.Until(limit))
	select {
	case <-driveDone:
		t.Stop()
	case <-t.C:
		return CleanupUncertain, "launch/probe routine is still unresolved"
	}
	err = errors.Join(err, s.killAll())
	if err != nil {
		return CleanupUncertain, err.Error()
	}
	if err := s.waitEmpty(context.Background(), time.Until(limit), allRoles...); err != nil {
		return CleanupUncertain, err.Error()
	}
	return CleanupConfirmed, ""
}
