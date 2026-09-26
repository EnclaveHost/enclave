package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// raisePtraceScope sets 2 and reads it back, never lowers a higher value, and FAILS CLOSED on anything else: Yama absent,
// unparsable, the write refused (enclave-bf's F1/F2 on d9176ed5; enclave-87's ruling).
func TestRaisePtraceScope(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "ptrace_scope")
	for _, c := range []struct {
		was, want, line string
		ok              bool
	}{
		{"0\n", "2", "yama ptrace_scope=0 -> 2", true},
		{"1\n", "2", "yama ptrace_scope=1 -> 2", true},
		{"2\n", "2", "yama ptrace_scope=2 (already >= 2)", true},
		{"3\n", "3", "yama ptrace_scope=3 (already >= 2)", true},
		{"x\n", "x", `yama ptrace_scope unparsable ("x"): ` + yamaRefused, false},
	} {
		if err := os.WriteFile(f, []byte(c.was), 0o644); err != nil {
			t.Fatal(err)
		}
		if got, ok := raisePtraceScope(f, 2); got != c.line || ok != c.ok {
			t.Fatalf("from %q: %q %v, want %q %v", c.was, got, ok, c.line, c.ok)
		}
		b, _ := os.ReadFile(f)
		if strings.TrimSpace(string(b)) != c.want {
			t.Fatalf("from %q the file holds %q, want %s", c.was, b, c.want)
		}
	}
	if got, ok := raisePtraceScope(filepath.Join(dir, "absent"), 2); ok || !strings.HasPrefix(got, "yama absent: "+yamaRefused) {
		t.Fatalf("an absent Yama: %q %v", got, ok)
	}
	// a write that "succeeds" and does not stick: only the read-back sees it
	if err := os.WriteFile(f, []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	noop := func(string, []byte, os.FileMode) error { return nil }
	if got, ok := raisePtraceScopeWith(f, 2, noop); ok || got != `yama ptrace_scope=1 -> "1", not the 2 asked: `+yamaRefused {
		t.Fatalf("a write that did not stick: %q %v", got, ok)
	}
	// the write refused: a read-only file (not as root, which writes it anyway)
	if os.Getuid() != 0 {
		ro := filepath.Join(dir, "ro")
		if err := os.WriteFile(ro, []byte("1\n"), 0o444); err != nil {
			t.Fatal(err)
		}
		if got, ok := raisePtraceScope(ro, 2); ok || !strings.HasPrefix(got, "yama ptrace_scope=1, NOT raised to 2") || !strings.HasSuffix(got, yamaRefused) {
			t.Fatalf("a refused write: %q %v", got, ok)
		}
	}
}

// Without Yama held at 2 the monitor loads NO domain, a probe included, and reads none of the app's bytes; with it, a load
// gets past the gate (and fails here only on its empty bundle).
func TestNoYamaNoDomains(t *testing.T) {
	m := newMonitor(false, "/plat", t.TempDir(), 40000, 5000)
	m.noDomains = "yama absent: " + yamaRefused
	for _, probe := range []bool{false, true} {
		app := strings.NewReader("0123456789")
		d, err := m.load(bufio.NewReader(app), request{Cmd: "load", Label: "x", Size: 10, Probe: probe})
		if d != nil || err == nil || err.Error() != "refused: yama absent: "+yamaRefused {
			t.Fatalf("probe=%v: loaded without Yama: %v %v", probe, d, err)
		}
		if app.Len() != 10 {
			t.Fatalf("probe=%v: the refused load read %d of the app's bytes", probe, 10-app.Len())
		}
	}
	m.noDomains = ""
	_, err := m.load(bufio.NewReader(strings.NewReader("0123456789")), request{Cmd: "load", Label: "x", Size: 10})
	if err == nil || strings.Contains(err.Error(), yamaRefused) {
		t.Fatalf("with Yama held, the load was refused for it (or loaded ten bytes of junk): %v", err)
	}
	t.Logf("with Yama held, past the gate: %v", err)
}
