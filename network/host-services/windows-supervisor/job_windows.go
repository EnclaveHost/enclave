//go:build windows

package main

// The Job Object launcher (the same CreateProcess(SUSPENDED) -> job -> resume pattern as
// network/windows-firewall/sandbox_windows.go, with JOB-wide limits instead of a per-process one):
//   - the runner starts SUSPENDED, is assigned to a fresh job, then resumed: it and every role it ever spawns are in the
//     job before a single instruction runs (no breakaway is permitted);
//   - JOB_OBJECT_LIMIT_JOB_MEMORY: committed memory of the WHOLE tree (runner + roles) - allocation beyond it fails, the
//     runner or role dies, and the restart policy applies (the cgroup MemoryMax equivalent);
//   - JOB_OBJECT_LIMIT_ACTIVE_PROCESS, a hard CPU-rate cap, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION (no WER hang);
//   - JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: when this supervisor exits or is killed, the whole tree ends;
//   - a new process group, so CTRL_BREAK reaches the runner's group only (the runner's SIGBREAK: graceful stop).
import (
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	jobObjectCPURateControlInformation = 15 // JOBOBJECTINFOCLASS
	cpuRateControlEnable               = 0x1
	cpuRateControlHardCap              = 0x4
)

type cpuRateControl struct {
	ControlFlags uint32
	CPURate      uint32
}

type jobProcess struct {
	job     windows.Handle
	process windows.Handle
	pid     uint32
	logf    func(string, ...any)
}

type jobLauncher struct{ lg *log.Logger }

func newLauncher(lg *log.Logger) Launcher { return jobLauncher{lg} }

func wide(s string) *uint16 { p, _ := windows.UTF16PtrFromString(s); return p }

// the runner's whole environment: the two OS directory names Winsock and the crypto provider need, and the system PATH
func runnerEnv() []uint16 {
	root := os.Getenv("SystemRoot")
	if root == "" {
		root = `C:\Windows`
	}
	var b []uint16
	for _, kv := range []string{"PATH=" + root + `\System32`, "SystemRoot=" + root, "WINDIR=" + root} {
		u, _ := windows.UTF16FromString(kv)
		b = append(b, u...)
	}
	return append(b, 0)
}

func (l jobLauncher) Start(c *Config) (Process, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return nil, fmt.Errorf("CreateJobObject: %w", err)
	}
	fail := func(e error) (Process, error) { windows.CloseHandle(job); return nil, e }
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_JOB_MEMORY |
		windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | windows.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
	limits.BasicLimitInformation.ActiveProcessLimit = uint32(c.ActiveProcesses)
	limits.JobMemoryLimit = uintptr(c.JobMemoryMiB) << 20
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		return fail(fmt.Errorf("job limits: %w", err))
	}
	rate := cpuRateControl{ControlFlags: cpuRateControlEnable | cpuRateControlHardCap, CPURate: CPURate(c.CPUPercent, runtime.NumCPU())}
	if _, err := windows.SetInformationJobObject(job, jobObjectCPURateControlInformation, uintptr(unsafe.Pointer(&rate)), uint32(unsafe.Sizeof(rate))); err != nil {
		return fail(fmt.Errorf("job CPU rate: %w", err))
	}
	// stdout/stderr -> the log file; stdin -> NUL. Only these handles are inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST).
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	out, err := windows.CreateFile(wide(c.Log), windows.FILE_APPEND_DATA, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_ALWAYS, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return fail(fmt.Errorf("log: %w", err))
	}
	defer windows.CloseHandle(out)
	null, err := windows.CreateFile(wide("NUL"), windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, sa, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return fail(fmt.Errorf("NUL: %w", err))
	}
	defer windows.CloseHandle(null)
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return fail(err)
	}
	defer attrs.Delete()
	handles := []windows.Handle{null, out}
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])); err != nil {
		return fail(err)
	}
	si := windows.StartupInfoEx{ProcThreadAttributeList: attrs.List()}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput, si.StdOutput, si.StdErr = null, out, out
	args := append([]string{c.Node}, c.NodeArgs...)
	args = append(args, c.Runner, "run", c.Config)
	for i := range args {
		args[i] = windows.EscapeArg(args[i])
	}
	env := runnerEnv()
	var pi windows.ProcessInformation
	flags := uint32(windows.CREATE_SUSPENDED | windows.CREATE_NEW_PROCESS_GROUP | windows.CREATE_UNICODE_ENVIRONMENT | windows.EXTENDED_STARTUPINFO_PRESENT)
	if err := windows.CreateProcess(wide(c.Node), wide(strings.Join(args, " ")), nil, nil, true, flags, &env[0], wide(c.WorkDir), &si.StartupInfo, &pi); err != nil {
		return fail(fmt.Errorf("CreateProcess: %w", err))
	}
	defer windows.CloseHandle(pi.Thread)
	if err := windows.AssignProcessToJobObject(job, pi.Process); err != nil {
		_ = windows.TerminateProcess(pi.Process, 1)
		windows.CloseHandle(pi.Process)
		return fail(fmt.Errorf("AssignProcessToJobObject: %w", err))
	}
	if _, err := windows.ResumeThread(pi.Thread); err != nil {
		_ = windows.TerminateJobObject(job, 1)
		windows.CloseHandle(pi.Process)
		return fail(fmt.Errorf("ResumeThread: %w", err))
	}
	l.lg.Printf("runner started (pid %d) in a job: %d MiB job memory, %d%% of one CPU (hard cap), %d processes, kill-on-close",
		pi.ProcessId, c.JobMemoryMiB, c.CPUPercent, c.ActiveProcesses)
	return &jobProcess{job: job, process: pi.Process, pid: pi.ProcessId, logf: l.lg.Printf}, nil
}

func (p *jobProcess) Wait() (int, error) {
	if _, err := windows.WaitForSingleObject(p.process, windows.INFINITE); err != nil {
		return -1, err
	}
	var code uint32
	if err := windows.GetExitCodeProcess(p.process, &code); err != nil {
		return -1, err
	}
	return int(int32(code)), nil
}

// CTRL_BREAK to the runner's process group (the runner's SIGBREAK). The group shares this supervisor's console.
func (p *jobProcess) Interrupt() error {
	return windows.GenerateConsoleCtrlEvent(windows.CTRL_BREAK_EVENT, p.pid)
}
func (p *jobProcess) Kill() error { return windows.TerminateJobObject(p.job, 1) }
func (p *jobProcess) Close() {
	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(p.job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil); err == nil {
		p.logf("job peak committed memory %d MiB", info.PeakJobMemoryUsed>>20)
	}
	windows.CloseHandle(p.process)
	windows.CloseHandle(p.job) // KILL_ON_JOB_CLOSE: nothing of the tree outlives this
}

// Only SYSTEM, Administrators and LOCAL SERVICE (the task's account) may open or set the stop event.
const stopEventSDDL = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)"

func stopChannel(name string) (<-chan struct{}, error) {
	sd, err := windows.SecurityDescriptorFromString(stopEventSDDL)
	if err != nil {
		return nil, err
	}
	sa := &windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	ev, err := windows.CreateEvent(sa, 1, 0, wide(name))
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) { // x/sys returns the handle AND this error
		windows.CloseHandle(ev)
		return nil, fmt.Errorf("%s already exists: another supervisor of this stage is running", name)
	}
	if err != nil {
		return nil, fmt.Errorf("CreateEvent %s: %w", name, err)
	}
	// the console the runner's group shares, for CTRL_BREAK (no-op if this process already has one)
	_, _, _ = windows.NewLazySystemDLL("kernel32.dll").NewProc("AllocConsole").Call()
	ch := make(chan struct{})
	go func() { _, _ = windows.WaitForSingleObject(ev, windows.INFINITE); close(ch) }()
	return ch, nil
}

func signalStop(name string) error {
	ev, err := windows.OpenEvent(windows.EVENT_MODIFY_STATE, false, wide(name))
	if err != nil {
		return fmt.Errorf("OpenEvent %s (is the supervisor running?): %w", name, err)
	}
	defer windows.CloseHandle(ev)
	return windows.SetEvent(ev)
}
