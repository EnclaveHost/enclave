package main

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// After notDumpable the KERNEL treats this process as non-dumpable: the files in its /proc/<pid> become root's (proc(5);
// fs/proc/base.c task_dump_owner - the directory itself keeps the task's owner), which is observable apart from prctl's
// own answer. (Linux's /proc/<pid>/status has no Dumpable line to read instead.)
func TestTheFrontIsNotDumpable(t *testing.T) {
	var before syscall.Stat_t
	if err := syscall.Stat("/proc/self/status", &before); err != nil {
		t.Fatal(err)
	}
	_, tracer, _, err := notDumpable()
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
// check; this test PTRACE_ATTACHes first (as a runtime compromised at load could, before PR_SET_DUMPABLE 0) to the
// child's LEADER, or to one of the threads the Go runtime starts before main.main (enclave-bf's F1 on d9176ed5: the
// leader's status alone reported tracer 0 while such a thread was traced), and the check must name that thread.
func TestATracedStartRefuses(t *testing.T) {
	if os.Getenv("FRONT_TRACER_HELPER") == "1" {
		bufio.NewReader(os.Stdin).ReadString('\n') // wait until the parent has attached (or decided not to)
		tid, tracer, threads, err := notDumpable()
		if err != nil {
			fmt.Println("error", err)
			os.Exit(2)
		}
		fmt.Printf("tid=%d tracer=%d threads=%d\n", tid, tracer, threads)
		if tracer != 0 {
			os.Exit(3) // what main does: "DOM front: traced at start (thread T, tracer P): refusing", exit non-zero
		}
		os.Exit(0)
	}
	// run starts the helper, attaches to the thread pick chooses (nil: none), and returns its exit code, its output, the
	// thread attached to, and the tracer as TracerPid names it: the attaching THREAD's id, not this process's.
	run := func(pick func(pid int) int) (int, string, int, int) {
		runtime.LockOSThread() // ptrace requests must come from the attaching thread
		defer runtime.UnlockOSThread()
		me := syscall.Gettid()
		cmd := exec.Command(os.Args[0], "-test.run=^TestATracedStartRefuses$")
		cmd.Env = append(os.Environ(), "FRONT_TRACER_HELPER=1")
		in, _ := cmd.StdinPipe()
		var out strings.Builder
		cmd.Stdout = &out
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		pid, tid := cmd.Process.Pid, 0
		if pick != nil {
			tid = pick(pid)
			if err := syscall.PtraceAttach(tid); err != nil {
				cmd.Process.Kill()
				cmd.Wait()
				t.Skipf("ptrace attach refused here (%v; Yama ptrace_scope?): the traced case cannot run on this host", err)
			}
		}
		in.Write([]byte("go\n"))
		in.Close()
		if pick == nil {
			cmd.Wait()
			return cmd.ProcessState.ExitCode(), out.String(), 0, me
		}
		// the tracer's loop: continue every stop of the traced thread, passing its signal on, until the process exits
		for {
			var ws syscall.WaitStatus
			w, err := syscall.Wait4(-1, &ws, syscall.WALL, nil)
			if err != nil {
				t.Fatalf("wait4: %v", err)
			}
			if w == pid && (ws.Exited() || ws.Signaled()) {
				cmd.Wait() // reaps nothing more; lets cmd collect its output
				code := -1
				if ws.Exited() {
					code = ws.ExitStatus()
				}
				return code, out.String(), tid, me
			}
			if ws.Stopped() {
				sig := 0
				if s := ws.StopSignal(); s != syscall.SIGSTOP && s != syscall.SIGTRAP {
					sig = int(s)
				}
				syscall.PtraceCont(w, sig)
			}
		}
	}
	leader := func(pid int) int { return pid }
	// a thread other than the leader: the Go runtime starts several before main.main
	other := func(pid int) int {
		for i := 0; i < 400; i++ {
			ents, _ := os.ReadDir(fmt.Sprintf("/proc/%d/task", pid))
			for _, e := range ents {
				if n, _ := strconv.Atoi(e.Name()); n != 0 && n != pid {
					return n
				}
			}
			time.Sleep(5 * time.Millisecond)
		}
		t.Fatal("the helper never started a thread besides its leader")
		return 0
	}
	if code, out, _, _ := run(nil); code != 0 || !strings.Contains(out, "tracer=0 ") {
		t.Fatalf("an untraced start did not proceed: exit %d, %q", code, out)
	}
	for name, pick := range map[string]func(int) int{"the leader": leader, "a non-leader thread": other} {
		code, out, tid, me := run(pick)
		if code != 3 || !strings.Contains(out, fmt.Sprintf("tid=%d tracer=%d ", tid, me)) {
			t.Fatalf("a start traced on %s (thread %d, by %d) did not refuse naming it: exit %d, %q", name, tid, me, code, out)
		}
		t.Logf("traced on %s: exit %d, %s", name, code, strings.TrimSpace(out))
	}
}

// The thread scan settles only on a round that read every listed thread (a fake /proc/<pid>/task): a traced thread
// anywhere is named; a missing TracerPid, an empty task list, or a thread whose status never reads is an error.
func TestTracedThread(t *testing.T) {
	mk := func(threads map[string]string) string {
		dir := t.TempDir()
		for tid, status := range threads {
			if err := os.MkdirAll(filepath.Join(dir, tid), 0o755); err != nil {
				t.Fatal(err)
			}
			if status != "" {
				if err := os.WriteFile(filepath.Join(dir, tid, "status"), []byte(status), 0o644); err != nil {
					t.Fatal(err)
				}
			}
		}
		return dir
	}
	clean := "Name:\tfront\nTracerPid:\t0\n"
	if tid, tr, n, err := tracedThread(mk(map[string]string{"10": clean, "11": clean, "12": clean})); err != nil || tid != 0 || tr != 0 || n != 3 {
		t.Fatalf("three clean threads: %d %d %d %v", tid, tr, n, err)
	}
	if tid, tr, _, err := tracedThread(mk(map[string]string{"10": clean, "11": clean, "12": "TracerPid:\t99\n"})); err != nil || tid != 12 || tr != 99 {
		t.Fatalf("thread 12 traced by 99: %d %d %v", tid, tr, err)
	}
	for name, threads := range map[string]map[string]string{
		"no TracerPid":         {"10": clean, "11": "Name:\tx\n"},
		"no thread":            {},
		"a status never reads": {"10": clean, "11": ""},
	} {
		if tid, tr, _, err := tracedThread(mk(threads)); err == nil {
			t.Fatalf("%s: judged clean (%d %d)", name, tid, tr)
		}
	}
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
