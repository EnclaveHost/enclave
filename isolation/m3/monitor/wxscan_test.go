package main

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// A child of this test binary standing in for a domain's runtime: MONITOR_WX_CHILD=rwx maps one page writable AND
// executable, =clean does not; it says "ready" and waits for its stdin to close.
func TestMain(m *testing.M) {
	switch os.Getenv("MONITOR_WX_CHILD") {
	case "rwx":
		if _, err := syscall.Mmap(-1, 0, 4096, syscall.PROT_READ|syscall.PROT_WRITE|syscall.PROT_EXEC, syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS); err != nil {
			os.Exit(2)
		}
		fallthrough
	case "clean":
		os.Stdout.WriteString("ready\n")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func wxChild(t *testing.T, kind string) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "MONITOR_WX_CHILD="+kind)
	in, _ := cmd.StdinPipe()
	out, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close(); cmd.Wait() })
	if line, _ := bufio.NewReader(out).ReadString('\n'); line != "ready\n" {
		t.Fatalf("the %s child did not start: %q", kind, line)
	}
	return cmd.Process.Pid
}

// a domain whose cgroup (a stand-in directory) lists pids; the children run as this test's uid, which is the domain's
// RUNTIME uid here, so they are counted as the runtime
func wxDomain(t *testing.T, pids ...int) *domain {
	dir := filepath.Join(t.TempDir(), "dom4")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	var b strings.Builder
	for _, p := range pids {
		b.WriteString(strconv.Itoa(p) + "\n")
	}
	if err := os.WriteFile(filepath.Join(dir, "cgroup.procs"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	return &domain{ID: 4, UID: os.Getuid(), FrontUID: os.Getuid() + frontUIDOffset, cgroup: dir}
}

// The monitor measures the RUNTIME it can read (the front, on its own uid, cannot): a clean runtime is counted and named,
// a W+X mapping PLANTED in the runtime is found, and a process it cannot read fails the scan instead of being skipped.
func TestTheMonitorMeasuresTheRuntime(t *testing.T) {
	m := newMonitor(false, "/plat", t.TempDir(), 40000, 5000)
	clean := wxChild(t, "clean")
	if got := m.scanDomainWX(wxDomain(t, clean)); got != "wx=clean maps=1 runtime=1 scope=cgroup:/dom4" {
		t.Fatalf("a clean runtime: %q", got)
	}
	rwx := wxChild(t, "rwx")
	if got := m.scanDomainWX(wxDomain(t, clean, rwx)); !strings.HasPrefix(got, "wx=found pid "+strconv.Itoa(rwx)+" (runtime): ") || !strings.Contains(got, "rwxp") {
		t.Fatalf("a W+X mapping planted in the runtime: %q", got)
	}
	if os.Getuid() != 0 {
		if _, err := os.Open("/proc/1/maps"); err != nil {
			if got := m.scanDomainWX(wxDomain(t, clean, 1)); !strings.HasPrefix(got, "wx=error: ") || !strings.Contains(got, "cannot vouch") {
				t.Fatalf("an unreadable process in the domain: %q", got)
			}
		}
	}
	if got := m.scanDomainWX(&domain{cgroup: filepath.Join(t.TempDir(), "absent")}); !strings.HasPrefix(got, "wx=error: ") {
		t.Fatalf("no cgroup: %q", got)
	}
}

// ...and it goes to the FRONT with the report, in the same answer. (registerSelf makes this test's uid the domain's
// FRONT, so the child, running as that uid, is counted as the front, and runtime=0 - which the judge rejects.)
func TestTheReportAnswerCarriesTheScan(t *testing.T) {
	m, sock := testMonitor(t, okReport)
	d := registerSelf(m, 1)
	d.cgroup = wxDomain(t, wxChild(t, "clean")).cgroup
	got := mustAsk(t, sock, goodBind)
	if got["report"] == "" || got["wx"] != "wx=clean maps=1 runtime=0 front=1 scope=cgroup:/dom4" {
		t.Fatalf("the answer: %v", got)
	}
}
