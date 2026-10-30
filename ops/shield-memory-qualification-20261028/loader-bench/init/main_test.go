package main

import (
	"bytes"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEmitRecordFormat(t *testing.T) {
	var buf bytes.Buffer
	e := &emitter{w: &buf, now: func() int64 { return 42 }}
	e.emit("result", "status", "ok", "reason", "a b=c", "m.Active(anon)", "7")
	e.emit("poweroff")
	lines := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("records %q", lines)
	}
	body := "BENCH seq=1 t_ns=42 kind=result status=ok reason=a+b%3Dc m.Active%28anon%29=7"
	if want := fmt.Sprintf("%s crc=%08x", body, crc32.ChecksumIEEE([]byte(body))); lines[0] != want {
		t.Fatalf("got  %q\nwant %q", lines[0], want)
	}
	if !strings.HasPrefix(lines[1], "BENCH seq=2 t_ns=42 kind=poweroff crc=") {
		t.Fatalf("second record %q", lines[1])
	}
}

func TestKVLinesMeminfoAndStat(t *testing.T) {
	got := kvLines("MemTotal:       49283072 kB\nActive(anon):  12 kB\n\nHugePages_Total:       0\n")
	want := []string{"MemTotal", "49283072", "Active(anon)", "12", "HugePages_Total", "0"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("meminfo %v", got)
	}
	got = prefixed("s.", kvLines("anon 4096\nfile 17559178144\n"))
	if strings.Join(got, ",") != "s.anon,4096,s.file,17559178144" {
		t.Fatalf("stat %v", got)
	}
}

const (
	lineA = "MODEL verified bytes=17559178144 sha256=" + modelSHA256 + " copy_verify_ms=31000"
	lineB = lineA + " source_dontneed_advised_bytes=17559178144 source_dontneed_failures=0"
)

func TestParseModelLine(t *testing.T) {
	m, ok := parseModelLine([]string{"noise", lineA})
	if !ok || m.bytes != modelSize || m.sha256 != modelSHA256 || m.copyMS != 31000 || m.hasAdvice {
		t.Fatalf("arm A line: %+v %v", m, ok)
	}
	m, ok = parseModelLine([]string{lineB})
	if !ok || !m.hasAdvice || m.advised != modelSize || m.failures != 0 {
		t.Fatalf("arm B line: %+v %v", m, ok)
	}
	for name, lines := range map[string][]string{
		"none":         {"MODEL ERROR hash mismatch"},
		"duplicate":    {lineA, lineA},
		"half-advice":  {lineA + " source_dontneed_failures=0"},
		"bad-number":   {strings.Replace(lineA, "bytes=17559178144", "bytes=x", 1)},
		"no-sha":       {"MODEL verified bytes=1 copy_verify_ms=2"},
		"bare-field":   {lineA + " junk"},
		"spoof-prefix": {"xMODEL verified bytes=17559178144 sha256=" + modelSHA256 + " copy_verify_ms=1"},
	} {
		if _, ok := parseModelLine(lines); ok {
			t.Errorf("%s: accepted %q", name, lines)
		}
	}
}

func TestClassify(t *testing.T) {
	good := childResult{exitCode: 0, cgroup: "0::/shieldmodel"}
	a, _ := parseModelLine([]string{lineA})
	b, _ := parseModelLine([]string{lineB})
	wrongSHA, _ := parseModelLine([]string{strings.Replace(lineA, modelSHA256, strings.Repeat("0", 64), 1)})
	wrongSize, _ := parseModelLine([]string{strings.Replace(lineA, "17559178144", "17559178143", 1)})
	mod := func(f func(*childResult)) childResult { c := good; f(&c); return c }
	for _, tc := range []struct {
		name, arm string
		c         childResult
		m         modelLine
		found     bool
		status    string
		reason    string
		verified  bool
	}{
		{"ok-A", "A", good, a, true, "ok", "loaded", true},
		{"ok-B", "B", good, b, true, "ok", "loaded", true},
		{"B-without-advice", "B", good, a, true, "error", "arm_marker_mismatch", true},
		{"A-with-advice", "A", good, b, true, "error", "arm_marker_mismatch", true},
		{"loader-exit", "A", mod(func(c *childResult) { c.exitCode = 1 }), a, true, "error", "loader_exit_1", false},
		{"signal", "A", mod(func(c *childResult) { c.exitCode, c.signal = -1, "9" }), a, true, "error", "child_signal_9", false},
		{"timeout", "B", mod(func(c *childResult) { c.exitCode, c.signal, c.timedOut = -1, "9", true }), b, true, "error", "child_timeout", false},
		{"cgroup", "A", mod(func(c *childResult) { c.cgroup = "0::/" }), a, true, "error", "child_cgroup_mismatch", false},
		{"start", "A", mod(func(c *childResult) { c.err = errors.New("clone3: ENOSYS") }), a, true, "error", "child_start: clone3: ENOSYS", false},
		{"no-line", "A", good, modelLine{}, false, "error", "no_model_line", false},
		{"wrong-sha", "A", good, wrongSHA, true, "error", "model_line_mismatch", false},
		{"wrong-size", "A", good, wrongSize, true, "error", "model_line_mismatch", false},
	} {
		s, r, v := classify(tc.arm, tc.c, tc.m, tc.found)
		if s != tc.status || r != tc.reason || v != tc.verified {
			t.Errorf("%s: got %s/%s/%v want %s/%s/%v", tc.name, s, r, v, tc.status, tc.reason, tc.verified)
		}
	}
}

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestConfigureChild(t *testing.T) {
	d := t.TempDir()
	writeFiles(t, d, map[string]string{"memory.max": "max\n"})
	if swap, err := configureChild(d); err != nil || swap != "unsupported" {
		t.Fatalf("no swap accounting: %q %v", swap, err)
	}
	if got := readValue(filepath.Join(d, "memory.max")); got != "48318382080" {
		t.Fatalf("memory.max %q", got)
	}
	writeFiles(t, d, map[string]string{"memory.swap.max": "0\n"})
	if swap, err := configureChild(d); err != nil || swap != "0" {
		t.Fatalf("swap accounting: %q %v", swap, err)
	}
	if _, err := configureChild(t.TempDir()); err == nil {
		t.Fatal("missing memory.max did not fail closed")
	}
	if _, err := os.Stat(filepath.Join(d, "memory.high")); !os.IsNotExist(err) {
		t.Fatal("control files must never be created")
	}
}

func TestSetupChildCgroupFailsClosed(t *testing.T) {
	// A regular file is not cgroupfs: writing "+memory" over 8 leading
	// spaces leaves "+memory memory", which reads back as enabled.
	enabled := "        memory\n"
	for name, files := range map[string]map[string]string{
		"no-cgroup2":          {},
		"no-memory":           {"cgroup.controllers": "cpu io pids\n", "cgroup.subtree_control": enabled},
		"no-subtree-file":     {"cgroup.controllers": "cpu memory\n"},
		"subtree-not-enabled": {"cgroup.controllers": "memory\n", "cgroup.subtree_control": ""},
		"child-max-missing":   {"cgroup.controllers": "memory\n", "cgroup.subtree_control": enabled},
	} {
		d := t.TempDir()
		writeFiles(t, d, files)
		if fd, _, err := setupChildCgroup(d, "shieldmodel"); err == nil || fd != -1 {
			t.Errorf("%s: fd=%d err=%v, want failure", name, fd, err)
		}
	}
	d := t.TempDir()
	writeFiles(t, d, map[string]string{"cgroup.controllers": "memory\n", "cgroup.subtree_control": enabled})
	if err := os.Mkdir(filepath.Join(d, "shieldmodel"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := setupChildCgroup(d, "shieldmodel"); err == nil {
		t.Fatal("reused an existing child cgroup")
	}
}

func TestRelayBoundsAndDrains(t *testing.T) {
	var buf bytes.Buffer
	e := &emitter{w: &buf, now: func() int64 { return 0 }}
	var in strings.Builder
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&in, "line %d\n", i)
	}
	r := strings.NewReader(in.String())
	if lines := relay(e, "child-stdout", r); len(lines) != maxChildLines || lines[0] != "line 0" {
		t.Fatalf("got %d lines", len(lines))
	}
	if n, _ := io.Copy(io.Discard, r); n != 0 {
		t.Fatal("relay left unread child output")
	}
	if !strings.Contains(buf.String(), "kind=child-stdout-truncated reason=lines") {
		t.Fatal("truncation not reported")
	}
	buf.Reset()
	long := strings.NewReader(strings.Repeat("x", 2*maxLineBytes) + "\nMODEL verified\n")
	relay(e, "child-stderr", long)
	if !strings.Contains(buf.String(), "reason=long_line") || long.Len() != 0 {
		t.Fatal("long line not reported or not drained")
	}
}
