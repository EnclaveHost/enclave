// Windows supervisor for the Enclave host-service runner (work/hosted-services-activation): the systemd unit's semantics
// on Windows. This file is platform-neutral (tested on any OS); job_windows.go supplies the real launcher.
//
//   - the runner and every role it starts run inside ONE Job Object (job_windows.go): a job-wide committed-memory limit
//     (JOB_OBJECT_LIMIT_JOB_MEMORY - the cgroup MemoryMax equivalent; the roles' heapMiB stays a V8 heap cap only), an
//     active-process limit, a hard CPU-rate cap, and KILL_ON_JOB_CLOSE (if this supervisor dies, the whole tree dies);
//   - Restart=on-failure: a clean exit (0) is final; any other exit restarts after RestartSec, at most StartLimitBurst
//     starts per StartLimitIntervalSec, after which the supervisor gives up (exit 3), like systemd's start limit;
//   - stop: a graceful request (CTRL_BREAK -> the runner's SIGBREAK: it stops every role and exits 0), then after
//     StopTimeoutSec the whole job is terminated (KillMode=mixed + TimeoutStopSec).
//
// A platform-policy refusal is NOT a failure: the runner keeps running with every role stopped (sticky until the admin's
// authenticated admit), exactly as under systemd.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Config is supervisor.json. Every path is absolute; nothing here is secret.
type Config struct {
	Node                  string   `json:"node"`            // node.exe (>= 22)
	NodeArgs              []string `json:"nodeArgs"`        // e.g. ["--max-old-space-size=128"]: the RUNNER's V8 heap cap
	Runner                string   `json:"runner"`          // bin\host-services-runner.mjs
	Config                string   `json:"config"`          // host-services.json
	WorkDir               string   `json:"workDir"`         // the writable state directory
	JobMemoryMiB          int      `json:"jobMemoryMiB"`    // job-wide committed memory (runner + roles)
	CPUPercent            int      `json:"cpuPercent"`      // of ONE logical CPU (150 = CPUQuota=150%)
	ActiveProcesses       int      `json:"activeProcesses"` // runner + roles + headroom
	RestartSec            int      `json:"restartSec"`
	StartLimitBurst       int      `json:"startLimitBurst"`
	StartLimitIntervalSec int      `json:"startLimitIntervalSec"`
	StopTimeoutSec        int      `json:"stopTimeoutSec"`
	StopEvent             string   `json:"stopEvent"` // Global\... named event an administrator sets to stop
	Log                   string   `json:"log"`
}

var heapArg = regexp.MustCompile(`^--max-old-space-size=[0-9]{2,5}$`)
var eventName = regexp.MustCompile(`^Global\\Enclave-host-services-[A-Za-z0-9-]{1,32}-stop$`)

func isAbs(p string) bool {
	return filepath.IsAbs(p) || regexp.MustCompile(`^[A-Za-z]:\\`).MatchString(p)
}

// Validate refuses anything outside the reviewed shape (no extra node flags, no relative paths, sane limits).
func (c *Config) Validate() error {
	for name, p := range map[string]string{"node": c.Node, "runner": c.Runner, "config": c.Config, "workDir": c.WorkDir, "log": c.Log} {
		if p == "" || !isAbs(p) || strings.ContainsAny(p, "\"\x00\r\n") {
			return fmt.Errorf("%s must be an absolute path", name)
		}
	}
	for _, a := range c.NodeArgs {
		if !heapArg.MatchString(a) {
			return fmt.Errorf("nodeArgs: only --max-old-space-size=N (a V8 heap cap) is allowed, got %q", a)
		}
	}
	switch {
	case c.JobMemoryMiB < 256 || c.JobMemoryMiB > 16384:
		return errors.New("jobMemoryMiB: 256 to 16384")
	case c.CPUPercent < 10 || c.CPUPercent > 6400:
		return errors.New("cpuPercent: 10 to 6400 (percent of one logical CPU)")
	case c.ActiveProcesses < 2 || c.ActiveProcesses > 64:
		return errors.New("activeProcesses: 2 to 64")
	case c.RestartSec < 1 || c.RestartSec > 600:
		return errors.New("restartSec: 1 to 600")
	case c.StartLimitBurst < 1 || c.StartLimitBurst > 100 || c.StartLimitIntervalSec < 1 || c.StartLimitIntervalSec > 86400:
		return errors.New("startLimitBurst 1-100, startLimitIntervalSec 1-86400")
	case c.StopTimeoutSec < 1 || c.StopTimeoutSec > 600:
		return errors.New("stopTimeoutSec: 1 to 600")
	case !eventName.MatchString(c.StopEvent):
		return errors.New(`stopEvent: Global\Enclave-host-services-<label>-stop`)
	}
	return nil
}

func LoadConfig(file string) (*Config, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	var c Config
	if err := dec.Decode(&c); err != nil {
		return nil, fmt.Errorf("supervisor.json: %w", err)
	}
	return &c, c.Validate()
}

// CPURate is JOBOBJECT_CPU_RATE_CONTROL_INFORMATION.CpuRate: hundredths of a percent of ALL logical CPUs.
func CPURate(percentOfOneCPU, logicalCPUs int) uint32 {
	if logicalCPUs < 1 {
		logicalCPUs = 1
	}
	r := percentOfOneCPU * 100 / logicalCPUs
	if r < 1 {
		r = 1
	}
	if r > 10000 {
		r = 10000
	}
	return uint32(r)
}

// Process is one started runner (inside its own job on Windows).
type Process interface {
	Wait() (exitCode int, err error) // blocks until the runner exits
	Interrupt() error                // graceful stop request (CTRL_BREAK)
	Kill() error                     // terminate the whole job (runner + every role)
	Close()                          // release the job (KILL_ON_JOB_CLOSE ends anything left)
}

// Launcher starts the runner; Clock lets the tests run the restart policy without real time.
type Launcher interface {
	Start(c *Config) (Process, error)
}
type Clock interface {
	Now() time.Time
	After(d time.Duration) <-chan time.Time
}
type realClock struct{}

func (realClock) Now() time.Time                         { return time.Now() }
func (realClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

const (
	ExitStopped    = 0 // stopped on request, or the runner exited cleanly
	ExitStartLimit = 3 // too many failed starts (systemd's start-limit-hit)
)

// Supervise runs the restart policy until a clean exit, a stop request or the start limit. logf records every decision.
func Supervise(c *Config, l Launcher, stop <-chan struct{}, clk Clock, logf func(string, ...any)) int {
	var starts []time.Time
	for {
		now := clk.Now()
		window := time.Duration(c.StartLimitIntervalSec) * time.Second
		kept := starts[:0]
		for _, t := range starts {
			if now.Sub(t) < window {
				kept = append(kept, t)
			}
		}
		starts = kept
		if len(starts) >= c.StartLimitBurst {
			logf("start limit hit: %d starts within %ds; giving up (no restart until an administrator starts it again)", len(starts), c.StartLimitIntervalSec)
			return ExitStartLimit
		}
		starts = append(starts, now)
		p, err := l.Start(c)
		if err != nil {
			logf("runner could not start: %v", err)
		} else {
			done := make(chan int, 1)
			go func() {
				code, werr := p.Wait()
				if werr != nil {
					logf("wait: %v", werr)
					code = -1
				}
				done <- code
			}()
			select {
			case code := <-done:
				p.Close()
				if code == 0 {
					logf("runner exited cleanly (0): not restarted (Restart=on-failure)")
					return ExitStopped
				}
				logf("runner exited with %d", code)
			case <-stop:
				logf("stop requested: CTRL_BREAK to the runner, %ds before the job is terminated", c.StopTimeoutSec)
				if err := p.Interrupt(); err != nil {
					logf("interrupt failed (%v): terminating the job now", err)
					_ = p.Kill()
					<-done
				} else {
					select {
					case code := <-done:
						logf("runner stopped (%d)", code)
					case <-clk.After(time.Duration(c.StopTimeoutSec) * time.Second):
						logf("runner still running after %ds: terminating the job", c.StopTimeoutSec)
						_ = p.Kill()
						<-done
					}
				}
				p.Close()
				return ExitStopped
			}
		}
		logf("restarting in %ds", c.RestartSec)
		select {
		case <-clk.After(time.Duration(c.RestartSec) * time.Second):
		case <-stop:
			logf("stop requested while waiting to restart: not started again")
			return ExitStopped
		}
	}
}
