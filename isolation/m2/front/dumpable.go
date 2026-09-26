package main

import (
	"fmt"
	"syscall"
)

// notDumpable makes this process NOT DUMPABLE (prctl PR_SET_DUMPABLE 0), first thing in main, before the domain's TLS key
// exists: then a process of the same uid - the tenant runtime, which runs as the domain's uid too - cannot ptrace this
// one, take its descriptors (pidfd_getfd) or read its memory, and /proc/<pid> becomes root's. enclave-b4's review of
// 683798d0: without it, a runtime escape could lift the front's console descriptor and its key. It is checked back with
// PR_GET_DUMPABLE; a front that cannot make itself non-dumpable does not serve.
func notDumpable() error {
	if _, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_SET_DUMPABLE, 0, 0); e != 0 {
		return fmt.Errorf("prctl(PR_SET_DUMPABLE, 0): %v", e)
	}
	v, _, e := syscall.RawSyscall(syscall.SYS_PRCTL, syscall.PR_GET_DUMPABLE, 0, 0)
	if e != 0 {
		return fmt.Errorf("prctl(PR_GET_DUMPABLE): %v", e)
	}
	if v != 0 {
		return fmt.Errorf("still dumpable (%d) after PR_SET_DUMPABLE 0", v)
	}
	return nil
}
