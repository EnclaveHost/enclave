package main

import (
	"os"
	"regexp"
	"testing"
)

// After notDumpable, the kernel's own record of this process says Dumpable 0 (/proc/self/status), not only prctl's
// answer: the property the runtime (same uid) is kept out by.
func TestTheFrontIsNotDumpable(t *testing.T) {
	if err := notDumpable(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile("/proc/self/status")
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`(?m)^Dumpable:\s*(\d+)$`).FindSubmatch(b)
	if m == nil {
		t.Skip("this kernel's /proc/self/status has no Dumpable line")
	}
	if string(m[1]) != "0" {
		t.Fatalf("/proc/self/status says Dumpable %s", m[1])
	}
}
