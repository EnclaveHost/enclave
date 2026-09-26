package contract

import (
	"bufio"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

// allowAllFilter puts THIS process (every thread: SECCOMP_FILTER_FLAG_TSYNC) under a one-instruction allow-all seccomp
// filter, so /proc/<pid>/status says "Seccomp: 2" - what a runtime under the app filter shows the scan.
func allowAllFilter() error {
	runtime.LockOSThread()
	if _, _, e := syscall.RawSyscall6(syscall.SYS_PRCTL, 38 /* PR_SET_NO_NEW_PRIVS */, 1, 0, 0, 0, 0); e != 0 {
		return e
	}
	prog := [1]struct {
		code   uint16
		jt, jf uint8
		k      uint32
	}{{0x06, 0, 0, 0x7fff0000}} // BPF_RET|BPF_K: SECCOMP_RET_ALLOW
	fprog := struct {
		n      uint16
		_      [6]byte
		filter uintptr
	}{n: 1, filter: uintptr(unsafe.Pointer(&prog[0]))}
	if _, _, e := syscall.RawSyscall(317 /* SYS_seccomp */, 1 /* SECCOMP_SET_MODE_FILTER */, 1 /* SECCOMP_FILTER_FLAG_TSYNC */, uintptr(unsafe.Pointer(&fprog))); e != 0 {
		return e
	}
	return nil
}

// A child of this test binary that stands in for a runtime: WXSCAN_CHILD=rwx maps one page writable AND executable (a
// W^X violation), =clean maps nothing unusual. It says "ready" and waits for its stdin to close.
func TestMain(m *testing.M) {
	switch os.Getenv("WXSCAN_CHILD") {
	case "filtered":
		if err := allowAllFilter(); err != nil {
			os.Stdout.WriteString("filter: " + err.Error() + "\n")
			os.Exit(2)
		}
		os.Stdout.WriteString("ready\n")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(0)
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

// A maps line the scan cannot parse fails it (fail closed), rather than being skipped as if it were not there.
func TestAnUnparsableMapsLineFails(t *testing.T) {
	for _, bad := range []string{"7f00-7f01\n", "7f00-7f01 rw\n", "\n"} {
		if _, _, err := firstWX(strings.NewReader("7f00-7f01 r-xp 0 00:00 0\n" + bad)); err == nil {
			t.Fatalf("%q was skipped", bad)
		}
	}
	if line, mapped, err := firstWX(strings.NewReader("7f00-7f01 r-xp 0 00:00 0\n7f02-7f03 rwxp 0 00:00 0\n")); err != nil || !mapped || !strings.Contains(line, "rwxp") {
		t.Fatalf("%q %v %v", line, mapped, err)
	}
}

func TestUIDOf(t *testing.T) {
	if uid, err := UIDOf(os.Getpid()); err != nil || uid != os.Getuid() {
		t.Fatalf("%d %v", uid, err)
	}
}

// The runtime's seccomp filter is MEASURED at the scan: a runtime process under a filter passes, one without fails the
// scan's claim, and the mode is read from the kernel (/proc/<pid>/status), not from anything the process says.
func TestTheRuntimeMustBeUnderAFilter(t *testing.T) {
	filtered, bare := child(t, "filtered"), child(t, "clean")
	for pid, want := range map[int]int{filtered: 2, bare: 0} {
		if mode, err := SeccompMode(pid); err != nil || mode != want {
			t.Fatalf("pid %d: Seccomp %d %v, want %d", pid, mode, err, want)
		}
	}
	ok, err := ScanWX("t", []int{filtered}, asRuntime)
	if err != nil || len(ok.RuntimePids) != 1 || ok.CheckRuntimeFiltered() != nil {
		t.Fatalf("a filtered runtime: %+v %v %v", ok, err, ok.CheckRuntimeFiltered())
	}
	for _, pids := range [][]int{{bare}, {filtered, bare}} {
		s, err := ScanWX("t", pids, asRuntime)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.CheckRuntimeFiltered(); err == nil || !strings.Contains(err.Error(), "not under a seccomp filter") {
			t.Fatalf("an unfiltered runtime in %v passed: %v", pids, err)
		}
	}
	// only the RUNTIME's processes are held to it: the front and init are not filtered, and need not be
	s, _ := ScanWX("t", []int{bare}, func(int) (string, error) { return "front", nil })
	if len(s.RuntimePids) != 0 || s.CheckRuntimeFiltered() != nil {
		t.Fatalf("a non-runtime process was held to the filter: %+v", s)
	}
}

func TestTheSeccompStatementIsExact(t *testing.T) {
	h := strings.Repeat("ab", 32)
	if got, err := ParseSeccompStatement([]byte("seccomp sha256=" + h + " rules=76\n")); err != nil || got != h {
		t.Fatalf("%q %v", got, err)
	}
	for _, bad := range []string{"", "seccomp sha256=" + h + " rules=76", "seccomp sha256=" + h + " rules=0\n",
		"seccomp sha256=" + strings.ToUpper(h) + " rules=76\n", "seccomp sha256=" + h[:62] + " rules=76\n",
		"seccomp sha256=" + h + " rules=76 extra\n", "seccomp sha256=" + h + " rules=76\nseccomp sha256=" + h + " rules=76\n",
		"seccomp  sha256=" + h + " rules=76\n", "seccomp sha256=" + h + "zz rules=76\n"} {
		if _, err := ParseSeccompStatement([]byte(bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	s := WXScan{Scope: "cgroup:/dom1", Roles: map[string]int{"runtime": 1}, Seccomp: h}
	if got := s.Clean(); got != "wx=clean maps=1 runtime=1 seccomp="+h+" scope=cgroup:/dom1" {
		t.Fatalf("Clean() = %q", got)
	}
}
