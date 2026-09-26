package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
	"testing"
)

// After notDumpable the KERNEL treats this process as non-dumpable: the files in its /proc/<pid> become root's (proc(5);
// fs/proc/base.c task_dump_owner - the directory itself keeps the task's owner), which is observable apart from prctl's
// own answer. (Linux's /proc/<pid>/status has no Dumpable line to read instead.)
func TestTheFrontIsNotDumpable(t *testing.T) {
	var before syscall.Stat_t
	if err := syscall.Stat("/proc/self/status", &before); err != nil {
		t.Fatal(err)
	}
	tracer, err := notDumpable()
	if err != nil {
		t.Fatal(err)
	}
	if tracer != 0 {
		t.Skipf("this test process is traced (TracerPid %d): run it untraced", tracer)
	}
	if os.Getuid() == 0 {
		t.Skip("running as root: /proc/self/status is root's either way, so ownership cannot show the change (prctl said 0)")
	}
	var after syscall.Stat_t
	if err := syscall.Stat("/proc/self/status", &after); err != nil {
		t.Fatal(err)
	}
	if before.Uid != uint32(os.Getuid()) || after.Uid != 0 {
		t.Fatalf("/proc/self/status owner %d before, %d after: the kernel does not treat this process as non-dumpable", before.Uid, after.Uid)
	}
}

// A TRACED start refuses and an untraced one proceeds (enclave-bf's race, enclave-87): a child runs the front's own
// check; this test PTRACE_ATTACHes to it first (as a runtime compromised at load could, before PR_SET_DUMPABLE 0), and
// the check must then report the tracer.
func TestATracedStartRefuses(t *testing.T) {
	if os.Getenv("FRONT_TRACER_HELPER") == "1" {
		bufio.NewReader(os.Stdin).ReadString('\n') // wait until the parent has attached (or decided not to)
		tracer, err := notDumpable()
		if err != nil {
			fmt.Println("error", err)
			os.Exit(2)
		}
		fmt.Printf("tracer=%d\n", tracer)
		if tracer != 0 {
			os.Exit(3) // what main does: "DOM front: traced at start (pid N): refusing", exit non-zero
		}
		os.Exit(0)
	}
	run := func(attach bool) (int, string) {
		runtime.LockOSThread() // ptrace requests must come from the attaching thread
		defer runtime.UnlockOSThread()
		cmd := exec.Command(os.Args[0], "-test.run=^TestATracedStartRefuses$")
		cmd.Env = append(os.Environ(), "FRONT_TRACER_HELPER=1")
		in, _ := cmd.StdinPipe()
		var out strings.Builder
		cmd.Stdout = &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		pid := cmd.Process.Pid
		if attach {
			if err := syscall.PtraceAttach(pid); err != nil {
				cmd.Process.Kill()
				cmd.Wait()
				t.Skipf("ptrace attach refused here (%v; Yama ptrace_scope?): the traced case cannot run on this host", err)
			}
		}
		in.Write([]byte("go\n"))
		in.Close()
		if !attach {
			cmd.Wait()
			return cmd.ProcessState.ExitCode(), out.String()
		}
		// the tracer's loop: continue every stop, passing its signal on, until the child exits
		for {
			var ws syscall.WaitStatus
			if _, err := syscall.Wait4(pid, &ws, 0, nil); err != nil {
				t.Fatalf("wait4: %v", err)
			}
			if ws.Exited() || ws.Signaled() {
				cmd.Wait() // reaps nothing more; lets cmd collect its output
				code := -1
				if ws.Exited() {
					code = ws.ExitStatus()
				}
				return code, out.String()
			}
			sig := 0
			if ws.Stopped() && ws.StopSignal() != syscall.SIGSTOP && ws.StopSignal() != syscall.SIGTRAP {
				sig = int(ws.StopSignal())
			}
			syscall.PtraceCont(pid, sig)
		}
	}
	if code, out := run(false); code != 0 || !strings.Contains(out, "tracer=0") {
		t.Fatalf("an untraced start did not proceed: exit %d, %q", code, out)
	}
	code, out := run(true)
	if code != 3 || strings.Contains(out, "tracer=0") || !strings.Contains(out, "tracer=") {
		t.Fatalf("a traced start did not refuse: exit %d, %q", code, out)
	}
	t.Logf("traced start: exit %d, %s", code, strings.TrimSpace(out))
}

// TracerPid is read from the kernel's status text exactly; a status without it cannot rule a tracer out.
func TestTracerOf(t *testing.T) {
	for in, want := range map[string]int{"TracerPid:\t0\n": 0, "TracerPid:\t4242\n": 4242, "Name:\tx\nTracerPid: 7\nUid:\t1\n": 7} {
		if got, err := tracerOf([]byte(in)); err != nil || got != want {
			t.Fatalf("%q: %d %v, want %d", in, got, err, want)
		}
	}
	if _, err := tracerOf([]byte("Name:\tx\n")); err == nil {
		t.Fatal("a status without TracerPid was accepted")
	}
}
