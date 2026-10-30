package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func goodConfig() *Config {
	return &Config{Node: `C:\Program Files\nodejs\node.exe`, NodeArgs: []string{"--max-old-space-size=128"},
		Runner: `C:\Program Files\Enclave\host-services\hs1\bin\host-services-runner.mjs`, Config: `C:\ProgramData\Enclave\host-services\hs1\config\host-services.json`,
		WorkDir: `C:\ProgramData\Enclave\host-services\hs1\state`, JobMemoryMiB: 1024, CPUPercent: 150, ActiveProcesses: 16, RestartSec: 10,
		StartLimitBurst: 5, StartLimitIntervalSec: 600, StopTimeoutSec: 30, StopEvent: `Global\Enclave-host-services-hs1-stop`, Log: `C:\ProgramData\Enclave\host-services\hs1\state\supervisor.log`}
}

// a clock whose restart delays elapse at once (advancing Now) and whose stop timeout fires only when the test says so
type fakeClock struct {
	mu      sync.Mutex
	now     time.Time
	delays  []time.Duration
	stopFor time.Duration
	stopCh  chan time.Time
}

func newClock(stopTimeout int) *fakeClock {
	return &fakeClock{now: time.Unix(1_800_000_000, 0), stopFor: time.Duration(stopTimeout) * time.Second, stopCh: make(chan time.Time, 1)}
}
func (c *fakeClock) Now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if d == c.stopFor {
		return c.stopCh
	}
	c.delays = append(c.delays, d)
	c.now = c.now.Add(d)
	ch := make(chan time.Time, 1)
	ch <- c.now
	return ch
}

type fakeProc struct {
	exit        chan int
	interrupted bool
	killed      bool
	closed      bool
	onInterrupt func(p *fakeProc) error
	mu          sync.Mutex
}

func (p *fakeProc) Wait() (int, error) { return <-p.exit, nil }
func (p *fakeProc) Interrupt() error {
	p.mu.Lock()
	p.interrupted = true
	p.mu.Unlock()
	if p.onInterrupt != nil {
		return p.onInterrupt(p)
	}
	return nil
}
func (p *fakeProc) Kill() error { p.mu.Lock(); p.killed = true; p.mu.Unlock(); p.exit <- 1; return nil }
func (p *fakeProc) Close()      { p.closed = true }

// each start pops the next scripted outcome: an exit code (the process exits at once), "run" (it keeps running), or an error
type fakeLauncher struct {
	script []any
	procs  []*fakeProc
	starts int
	tweak  func(p *fakeProc)
}

func (l *fakeLauncher) Start(*Config) (Process, error) {
	l.starts++
	if len(l.script) == 0 {
		return nil, errors.New("script exhausted")
	}
	next := l.script[0]
	l.script = l.script[1:]
	if e, ok := next.(error); ok {
		return nil, e
	}
	p := &fakeProc{exit: make(chan int, 2)}
	if l.tweak != nil {
		l.tweak(p)
	}
	if code, ok := next.(int); ok {
		p.exit <- code
	}
	l.procs = append(l.procs, p)
	return p, nil
}

func run(t *testing.T, l *fakeLauncher, stop chan struct{}, clk *fakeClock) (int, []string) {
	t.Helper()
	var logs []string
	var mu sync.Mutex
	code := Supervise(goodConfig(), l, stop, clk, func(f string, a ...any) { mu.Lock(); logs = append(logs, f); mu.Unlock() })
	return code, logs
}

func TestCleanExitIsFinal(t *testing.T) {
	l := &fakeLauncher{script: []any{0}}
	code, _ := run(t, l, make(chan struct{}), newClock(30))
	if code != ExitStopped || l.starts != 1 || !l.procs[0].closed {
		t.Fatalf("code %d starts %d", code, l.starts)
	}
}

func TestFailureRestartsAfterRestartSec(t *testing.T) {
	l := &fakeLauncher{script: []any{1, errors.New("CreateProcess: access denied"), 137, 0}}
	clk := newClock(30)
	code, _ := run(t, l, make(chan struct{}), clk)
	if code != ExitStopped || l.starts != 4 {
		t.Fatalf("code %d starts %d", code, l.starts)
	}
	for _, d := range clk.delays {
		if d != 10*time.Second {
			t.Fatalf("restart delay %v, want 10s", d)
		}
	}
	if len(clk.delays) != 3 {
		t.Fatalf("%d restart delays, want 3", len(clk.delays))
	}
}

func TestStartLimitGivesUp(t *testing.T) {
	l := &fakeLauncher{script: []any{1, 1, 1, 1, 1, 1, 1, 1}}
	code, logs := run(t, l, make(chan struct{}), newClock(30))
	if code != ExitStartLimit || l.starts != 5 {
		t.Fatalf("code %d starts %d, want start-limit after exactly 5 starts", code, l.starts)
	}
	if !strings.Contains(logs[len(logs)-1], "start limit hit") {
		t.Fatalf("last log %q", logs[len(logs)-1])
	}
}

func TestStartLimitWindowSlides(t *testing.T) {
	c := goodConfig()
	c.RestartSec, c.StartLimitBurst, c.StartLimitIntervalSec = 200, 3, 600
	l := &fakeLauncher{script: []any{1, 1, 1, 1, 1, 0}}
	clk := newClock(30)
	code := Supervise(c, l, make(chan struct{}), clk, func(string, ...any) {})
	if code != ExitStopped || l.starts != 6 {
		t.Fatalf("failures spaced beyond the window must keep restarting: code %d starts %d", code, l.starts)
	}
}

func TestStopIsGracefulWithinTimeout(t *testing.T) {
	l := &fakeLauncher{script: []any{"run"}, tweak: func(p *fakeProc) { p.onInterrupt = func(p *fakeProc) error { p.exit <- 0; return nil } }}
	stop := make(chan struct{})
	go func() { time.Sleep(20 * time.Millisecond); close(stop) }()
	code, _ := run(t, l, stop, newClock(30))
	p := l.procs[0]
	if code != ExitStopped || !p.interrupted || p.killed || !p.closed || l.starts != 1 {
		t.Fatalf("code %d interrupted %v killed %v closed %v starts %d", code, p.interrupted, p.killed, p.closed, l.starts)
	}
}

func TestStopKillsTheJobAfterTimeout(t *testing.T) {
	l := &fakeLauncher{script: []any{"run"}}
	stop := make(chan struct{})
	clk := newClock(30)
	go func() {
		time.Sleep(20 * time.Millisecond)
		close(stop)
		time.Sleep(20 * time.Millisecond)
		clk.stopCh <- time.Now()
	}()
	code, _ := run(t, l, stop, clk)
	p := l.procs[0]
	if code != ExitStopped || !p.interrupted || !p.killed || l.starts != 1 {
		t.Fatalf("code %d interrupted %v killed %v starts %d", code, p.interrupted, p.killed, l.starts)
	}
}

func TestFailedInterruptKillsAtOnce(t *testing.T) {
	l := &fakeLauncher{script: []any{"run"}, tweak: func(p *fakeProc) { p.onInterrupt = func(*fakeProc) error { return errors.New("no console") } }}
	stop := make(chan struct{})
	go func() { time.Sleep(20 * time.Millisecond); close(stop) }()
	code, _ := run(t, l, stop, newClock(30))
	if code != ExitStopped || !l.procs[0].killed {
		t.Fatalf("code %d killed %v", code, l.procs[0].killed)
	}
}

func TestStopWhileWaitingToRestartStartsNothing(t *testing.T) {
	l := &fakeLauncher{script: []any{1, 0}}
	clk := newClock(30)
	clk.stopFor = 10 * time.Second // the restart delay never elapses here: only the stop can end the wait
	stop := make(chan struct{})
	go func() { time.Sleep(50 * time.Millisecond); close(stop) }()
	code, _ := run(t, l, stop, clk)
	if code != ExitStopped || l.starts != 1 {
		t.Fatalf("code %d starts %d, want no second start", code, l.starts)
	}
}

func TestConfigValidation(t *testing.T) {
	if err := goodConfig().Validate(); err != nil {
		t.Fatal(err)
	}
	for name, mut := range map[string]func(c *Config){
		"relative node":      func(c *Config) { c.Node = `node.exe` },
		"quote in path":      func(c *Config) { c.Config = `C:\x" --inspect "y.json` },
		"extra node flag":    func(c *Config) { c.NodeArgs = []string{"--inspect=0.0.0.0:9229"} },
		"tiny job memory":    func(c *Config) { c.JobMemoryMiB = 64 },
		"no cpu":             func(c *Config) { c.CPUPercent = 0 },
		"one process":        func(c *Config) { c.ActiveProcesses = 1 },
		"zero restart":       func(c *Config) { c.RestartSec = 0 },
		"bad event":          func(c *Config) { c.StopEvent = `Global\anything` },
		"local event":        func(c *Config) { c.StopEvent = `Local\Enclave-host-services-hs1-stop` },
		"no stop timeout":    func(c *Config) { c.StopTimeoutSec = 0 },
		"relative log":       func(c *Config) { c.Log = `supervisor.log` },
		"burst out of range": func(c *Config) { c.StartLimitBurst = 0 },
	} {
		c := goodConfig()
		mut(c)
		if c.Validate() == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	dir := t.TempDir()
	f := filepath.Join(dir, "s.json")
	_ = os.WriteFile(f, []byte(`{"node":"C:\\n.exe","unexpected":1}`), 0o600)
	if _, err := LoadConfig(f); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown fields must be refused: %v", err)
	}
}

func TestCPURate(t *testing.T) {
	for _, c := range []struct {
		pct, cpus int
		want      uint32
	}{{150, 8, 1875}, {150, 1, 10000}, {150, 64, 234}, {10, 6400, 1}, {100, 0, 10000}} {
		if got := CPURate(c.pct, c.cpus); got != c.want {
			t.Errorf("CPURate(%d,%d)=%d want %d", c.pct, c.cpus, got, c.want)
		}
	}
}

// the template the Windows stage ships (install.ps1 replaces only "node") passes validation, with the Linux unit's limits
func TestShippedTemplate(t *testing.T) {
	c, err := LoadConfig("supervisor.template.json")
	if err != nil {
		t.Fatal(err)
	}
	if c.JobMemoryMiB != 1024 || c.CPUPercent != 150 || c.RestartSec != 10 || c.StartLimitBurst != 5 || c.StartLimitIntervalSec != 600 || c.StopTimeoutSec != 30 {
		t.Fatalf("limits differ from the Linux unit (MemoryMax=1024M, CPUQuota=150%%, RestartSec=10s, 5 starts/600s, TimeoutStopSec=30s): %+v", c)
	}
}
