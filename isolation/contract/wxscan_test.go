package contract

import (
	"bufio"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
)

// A child of this test binary that stands in for a runtime: WXSCAN_CHILD=rwx maps one page writable AND executable (a
// W^X violation), =clean maps nothing unusual. It says "ready" and waits for its stdin to close.
func TestMain(m *testing.M) {
	switch os.Getenv("WXSCAN_CHILD") {
	case "rwx":
		if _, err := syscall.Mmap(-1, 0, 4096, syscall.PROT_READ|syscall.PROT_WRITE|syscall.PROT_EXEC, syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS); err != nil {
			os.Stdout.WriteString("mmap: " + err.Error() + "\n")
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

func child(t *testing.T, kind string) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "WXSCAN_CHILD="+kind)
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

func asRuntime(int) (string, error) { return "runtime", nil }

// A W+X mapping PLANTED in the runtime is found, and named with its role.
func TestScanWXFindsAPlantedMapping(t *testing.T) {
	pid := child(t, "rwx")
	s, err := ScanWX("test", []int{pid}, asRuntime)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s.Found, "pid "+strconv.Itoa(pid)+" (runtime):") || !strings.Contains(s.Found, "rwxp") {
		t.Fatalf("the planted mapping was not found: %+v", s)
	}
}

// A clean runtime is counted as the runtime, and the result says so.
func TestScanWXCountsTheRuntime(t *testing.T) {
	pid := child(t, "clean")
	s, err := ScanWX("cgroup:/dom1", []int{pid}, asRuntime)
	if err != nil || s.Found != "" {
		t.Fatalf("%+v %v", s, err)
	}
	if got := s.Clean(); got != "wx=clean maps=1 runtime=1 scope=cgroup:/dom1" {
		t.Fatalf("Clean() = %q", got)
	}
	// roles after the runtime in a fixed order, and the counts add up
	s.Roles["init"], s.Roles["front"] = 1, 1
	if got := s.Clean(); got != "wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1" {
		t.Fatalf("Clean() = %q", got)
	}
}

// Only a process PROVEN gone is skipped; one whose mappings cannot be READ fails the scan (enclave-bf's finding: EACCES
// treated as "ended" let a scan that read only its own process say clean). pid 1 (root) is unreadable to a non-root test.
func TestScanWXFailsOnAnUnreadableProcess(t *testing.T) {
	pid := child(t, "clean")
	gone := 1 << 22
	for ; gone < 1<<23; gone++ {
		if _, err := os.Stat("/proc/" + strconv.Itoa(gone)); os.IsNotExist(err) {
			break
		}
	}
	s, err := ScanWX("t", []int{gone, pid}, asRuntime)
	if err != nil || s.Total() != 1 {
		t.Fatalf("a pid that does not exist must be skipped as gone: %+v %v", s, err)
	}
	if os.Getuid() == 0 {
		t.Skip("as root every process is readable; the unreadable case needs a non-root test")
	}
	if _, err := os.Open("/proc/1/maps"); err == nil {
		t.Skip("/proc/1/maps is readable here")
	}
	if _, err := ScanWX("t", []int{pid, 1}, asRuntime); err == nil || !strings.Contains(err.Error(), "cannot vouch") {
		t.Fatalf("an unreadable process did not fail the scan: %v", err)
	}
}

func TestScanWXOfNothingIsNotClean(t *testing.T) {
	if _, err := ScanWX("t", nil, asRuntime); err == nil {
		t.Fatal("a scan that saw nothing passed")
	}
}

func TestUIDOf(t *testing.T) {
	if uid, err := UIDOf(os.Getpid()); err != nil || uid != os.Getuid() {
		t.Fatalf("%d %v", uid, err)
	}
}
