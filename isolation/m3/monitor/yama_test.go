package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// raisePtraceScope raises a lower scope to the floor, never lowers a higher one, and states an absent Yama without failing.
func TestRaisePtraceScope(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "ptrace_scope")
	for _, c := range []struct{ was, want, line string }{
		{"0\n", "2", "yama ptrace_scope=0 -> 2"},
		{"1\n", "2", "yama ptrace_scope=1 -> 2"},
		{"2\n", "2", "yama ptrace_scope=2 (already >= 2)"},
		{"3\n", "3", "yama ptrace_scope=3 (already >= 2)"},
	} {
		if err := os.WriteFile(f, []byte(c.was), 0o644); err != nil {
			t.Fatal(err)
		}
		if got := raisePtraceScope(f, 2); got != c.line {
			t.Fatalf("from %q: %q, want %q", c.was, got, c.line)
		}
		b, _ := os.ReadFile(f)
		if strings.TrimSpace(string(b)) != c.want {
			t.Fatalf("from %q the file holds %q, want %s", c.was, b, c.want)
		}
	}
	if got := raisePtraceScope(filepath.Join(dir, "absent"), 2); !strings.HasPrefix(got, "yama absent") {
		t.Fatalf("an absent Yama: %q", got)
	}
}
