package main

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
	"syscall"
)

// notDumpable makes this process NOT DUMPABLE (prctl PR_SET_DUMPABLE 0), first thing in main, before the domain's TLS key
// exists: then a process of the same uid - the tenant runtime, which runs as the domain's uid too - cannot ptrace this
// one, take its descriptors (pidfd_getfd) or read its memory, and /proc/<pid> becomes root's. enclave-b4's review of
// 683798d0: without it, a runtime escape could lift the front's console descriptor and its key. It is checked back with
// PR_GET_DUMPABLE.
//
// Non-dumpable does NOT detach a tracer that attached BEFORE it (enclave-bf): domexec starts the runtime first, as the same
// uid in the same PID namespace, so a runtime compromised at load could attach during this process's start-up and stay
// attached to read the key once it exists. So it then reads its own TracerPid: tracer > 0 is a front that must refuse to
// start (main: "DOM front: traced at start (pid N): refusing"). -> (tracer pid, error)
func notDumpable() (int, error) {
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0); e != 0 {
		return 0, fmt.Errorf("prctl(PR_SET_DUMPABLE, 0): %v", e)
	}
	v, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_GET_DUMPABLE, 0, 0)
	if e != 0 {
		return 0, fmt.Errorf("prctl(PR_GET_DUMPABLE): %v", e)
	}
	if v != 0 {
		return 0, fmt.Errorf("still dumpable (%d) after PR_SET_DUMPABLE 0", v)
	}
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0, fmt.Errorf("reading /proc/self/status to check for a tracer: %v", err)
	}
	return tracerOf(b)
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
