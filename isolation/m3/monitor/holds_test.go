package main

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// holdSysctl: set, read back, never move a value already on the right side, and FAIL CLOSED on anything else - in both
// directions (user.max_user_namespaces at most 0, kernel.io_uring_disabled at least 2). enclave-87, for the next NucBox
// build: the same two holds as the SNP guest's m2/dominit.c.
func TestHoldSysctl(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "sysctl")
	const r = "domains refused (test)"
	for _, c := range []struct {
		name       string
		want       int
		atLeast    bool
		was, after string
		line       string
		ok         bool
	}{
		{"user.max_user_namespaces", 0, false, "511143\n", "0", "user.max_user_namespaces=511143 -> 0", true},
		{"user.max_user_namespaces", 0, false, "0\n", "0", "user.max_user_namespaces=0 (already <= 0)", true},
		{"kernel.io_uring_disabled", 2, true, "0\n", "2", "kernel.io_uring_disabled=0 -> 2", true},
		{"kernel.io_uring_disabled", 2, true, "1\n", "2", "kernel.io_uring_disabled=1 -> 2", true},
		{"kernel.io_uring_disabled", 2, true, "2\n", "2", "kernel.io_uring_disabled=2 (already >= 2)", true},
		{"kernel.io_uring_disabled", 2, true, "x\n", "x", `kernel.io_uring_disabled unparsable ("x"): ` + r, false},
	} {
		if err := os.WriteFile(f, []byte(c.was), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, ok := holdSysctl(c.name, f, c.want, c.atLeast, r, os.WriteFile); got != c.line || ok != c.ok {
			t.Fatalf("%s from %q: %q %v, want %q %v", c.name, c.was, got, ok, c.line, c.ok)
		}
		if b, _ := os.ReadFile(f); strings.TrimSpace(string(b)) != c.after {
			t.Fatalf("%s from %q: the file holds %q, want %s", c.name, c.was, b, c.after)
		}
	}
	if got, ok := holdSysctl("user.max_user_namespaces", filepath.Join(dir, "absent"), 0, false, r, os.WriteFile); ok ||
		!strings.HasPrefix(got, "user.max_user_namespaces absent: "+r) {
		t.Fatalf("an absent sysctl: %q %v", got, ok)
	}
	// a write that "succeeds" and does not stick, in each direction: only the read-back sees it
	noop := func(string, []byte, os.FileMode) error { return nil }
	for _, c := range []struct {
		name    string
		want    int
		atLeast bool
		was     string
	}{{"user.max_user_namespaces", 0, false, "5\n"}, {"kernel.io_uring_disabled", 2, true, "0\n"}} {
		if err := os.WriteFile(f, []byte(c.was), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, ok := holdSysctl(c.name, f, c.want, c.atLeast, r, noop); ok || !strings.HasSuffix(got, "not the "+strconv.Itoa(c.want)+" asked: "+r) {
			t.Fatalf("%s: a write that did not stick: %q %v", c.name, got, ok)
		}
	}
	if os.Getuid() != 0 {
		ro := filepath.Join(dir, "ro")
		if err := os.WriteFile(ro, []byte("5\n"), 0o444); err != nil {
			t.Fatal(err)
		}
		if got, ok := holdSysctl("user.max_user_namespaces", ro, 0, false, r, os.WriteFile); ok ||
			!strings.HasPrefix(got, "user.max_user_namespaces=5, NOT set to 0") {
			t.Fatalf("a refused write: %q %v", got, ok)
		}
	}
}

// The table main holds: exactly these two, in these directions.
func TestKernelHoldsTable(t *testing.T) {
	want := map[string]struct {
		path    string
		want    int
		atLeast bool
	}{
		"user.max_user_namespaces": {"/proc/sys/user/max_user_namespaces", 0, false},
		"kernel.io_uring_disabled": {"/proc/sys/kernel/io_uring_disabled", 2, true},
	}
	if len(kernelHolds) != len(want) {
		t.Fatalf("kernelHolds has %d entries, want %d", len(kernelHolds), len(want))
	}
	for _, h := range kernelHolds {
		w, ok := want[h.name]
		if !ok || h.path != w.path || h.want != w.want || h.atLeast != w.atLeast || !strings.HasPrefix(h.refused, "domains refused") {
			t.Fatalf("kernelHolds entry %+v, want %+v", h, w)
		}
	}
}

// main, from its source: Yama, then the kernel holds (each failing closed: noDomains, power off), all before `ready`.
func TestMainHoldsBeforeReady(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	yama := strings.Index(src, `yama, ok := raisePtraceScope(`)
	loop := strings.Index(src, "for _, h := range kernelHolds {")
	hold := strings.Index(src, "line, held := holdSysctl(h.name, h.path, h.want, h.atLeast, h.refused, os.WriteFile)")
	transport := strings.Index(src, "transport := vsockTransport()")
	if yama < 0 || loop < 0 || hold < 0 || transport < 0 || !(yama < loop && loop < hold && hold < transport) {
		t.Fatalf("main's order: yama %d, holds loop %d, hold %d, vsock/ready %d", yama, loop, hold, transport)
	}
	body := src[hold:transport]
	for _, must := range []string{"if !held {", "m.noDomains = line", "LINUX_REBOOT_CMD_POWER_OFF", "os.Exit(1)"} {
		if !strings.Contains(body, must) {
			t.Fatalf("a kernel hold that fails does not %q before ready", must)
		}
	}
}
