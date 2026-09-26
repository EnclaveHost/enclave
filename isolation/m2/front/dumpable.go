package main

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"slices"
	"strconv"
	"syscall"
)

// notDumpable makes this process NOT DUMPABLE (prctl PR_SET_DUMPABLE 0), first thing in main, before the domain's TLS key
// exists, and checks it back with PR_GET_DUMPABLE. That is DEFENCE IN DEPTH. The guard against the tenant runtime (the
// same uid, a SIBLING of this process under domexec) is Yama: the m3 monitor raises ptrace_scope to 2 and refuses every
// domain when it cannot hold it at >= 1 (monitor/main.go raisePtraceScope; enclave-87's ruling on enclave-bf's review of
// d9176ed5). Under Yama >= 1 a sibling can neither PTRACE_ATTACH nor open /proc/<pid>/mem (both PTRACE_MODE_ATTACH).
//
// Without Yama, non-dumpable does NOT close the start-up window, because domexec starts the runtime first:
//   - a tracer that attached before PR_SET_DUMPABLE 0 stays attached (enclave-bf), on ANY thread: the Go runtime starts
//     threads before main.main, and a tracer on one of them reads the whole shared address space (bf's F1);
//   - a /proc/<pid>/mem descriptor opened before it keeps reading after it, and leaves no trace this process can see
//     (bf's F2). No in-process check covers that; only Yama does.
//
// What this CAN see, it refuses: it reads TracerPid for EVERY thread (/proc/self/task/*/status), re-listing until the
// thread set is stable, and main refuses to start on any tracer ("DOM front: traced at start (thread T, tracer P):
// refusing"). -> (the traced thread, its tracer, the number of threads checked, error); tracer 0 = none.
func notDumpable() (tid, tracer, threads int, err error) {
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0); e != 0 {
		return 0, 0, 0, fmt.Errorf("prctl(PR_SET_DUMPABLE, 0): %v", e)
	}
	v, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_GET_DUMPABLE, 0, 0)
	if e != 0 {
		return 0, 0, 0, fmt.Errorf("prctl(PR_GET_DUMPABLE): %v", e)
	}
	if v != 0 {
		return 0, 0, 0, fmt.Errorf("still dumpable (%d) after PR_SET_DUMPABLE 0", v)
	}
	return tracedThread("/proc/self/task")
}

// tracedThread scans every thread under task (a /proc/<pid>/task directory) for a tracer. It settles only on a round that
// read EVERY listed thread and listed the same threads as the round before, so a thread started meanwhile (a traced
// thread's clone can be auto-attached, PTRACE_O_TRACECLONE) is scanned too; a thread that exits mid-scan makes the scan
// run again, and a set that never settles is an error. -> (tid, tracer, threads scanned, error)
func tracedThread(task string) (int, int, int, error) {
	var prev []int
	for round := 0; round < 16; round++ {
		tids, err := threadIDs(task)
		if err != nil {
			return 0, 0, 0, err
		}
		whole := true // every listed thread's status was read
		for _, id := range tids {
			b, err := os.ReadFile(fmt.Sprintf("%s/%d/status", task, id))
			if errors.Is(err, fs.ErrNotExist) {
				whole = false // it exited: this round cannot settle it, so the scan runs again
				continue
			}
			if err != nil {
				return 0, 0, 0, fmt.Errorf("reading thread %d's status to check for a tracer: %v", id, err)
			}
			n, err := tracerOf(b)
			if err != nil {
				return 0, 0, 0, fmt.Errorf("thread %d: %v", id, err)
			}
			if n != 0 {
				return id, n, len(tids), nil
			}
		}
		if whole && slices.Equal(prev, tids) {
			return 0, 0, len(tids), nil
		}
		prev = tids
	}
	return 0, 0, 0, fmt.Errorf("the thread set under %s never settled, so a tracer cannot be ruled out", task)
}

func threadIDs(task string) ([]int, error) {
	ents, err := os.ReadDir(task)
	if err != nil {
		return nil, fmt.Errorf("listing %s to check every thread for a tracer: %v", task, err)
	}
	var ids []int
	for _, e := range ents {
		if n, err := strconv.Atoi(e.Name()); err == nil && n > 0 {
			ids = append(ids, n)
		}
	}
	if len(ids) == 0 {
		return nil, fmt.Errorf("%s lists no thread, so a tracer cannot be ruled out", task)
	}
	slices.Sort(ids)
	return ids, nil
}

var tracerPid = regexp.MustCompile(`(?m)^TracerPid:\s*(\d+)$`)

// tracerOf reads TracerPid out of a /proc/<pid>/status: 0 = not traced. A status without it cannot rule a tracer out.
func tracerOf(status []byte) (int, error) {
	m := tracerPid.FindSubmatch(status)
	if m == nil {
		return 0, fmt.Errorf("the status names no TracerPid, so a tracer cannot be ruled out")
	}
	n, err := strconv.Atoi(string(m[1]))
	if err != nil {
		return 0, fmt.Errorf("TracerPid %q: %v", m[1], err)
	}
	return n, nil
}
