//go:build linux && amd64

package rpcservice

import (
	"bufio"
	"encoding/binary"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestEntryFrameRejectsChangedIdentityOrDeadline(t *testing.T) {
	boot := [16]byte{1, 2, 3}
	b, err := encodeEntry(boot, 123)
	if err != nil {
		t.Fatal(err)
	}
	if o, d, e := decodeEntry(b, boot, 124); e != nil || o != 123 || d != 123+uint64(StartupWindow) {
		t.Fatal(o, d, e)
	}
	for _, change := range []func([]byte){
		func(b []byte) { b[0]++ }, func(b []byte) { b[8]++ },
		func(b []byte) { binary.LittleEndian.PutUint64(b[32:], 123+uint64(StartupWindow)+1) },
		func(b []byte) { binary.LittleEndian.PutUint64(b[24:], math.MaxUint64) },
	} {
		copyB := append([]byte(nil), b...)
		change(copyB)
		if _, _, err := decodeEntry(copyB, boot, 124); err == nil {
			t.Fatal("changed frame accepted")
		}
	}
	for _, now := range []uint64{122, 123 + uint64(StartupWindow), math.MaxUint64} {
		if _, _, err := decodeEntry(b, boot, now); err == nil {
			t.Fatal("invalid clock accepted", now)
		}
	}
	if _, err := encodeEntry(boot, math.MaxUint64); err == nil {
		t.Fatal("overflow accepted")
	}
	if _, err := encodeEntry([16]byte{}, 123); err == nil {
		t.Fatal("zero boot accepted")
	}
	if _, _, err := decodeEntry(b[:39], boot, 124); err == nil {
		t.Fatal("short frame accepted")
	}
}

func TestEntryTimeNamespaceMustBeUnshifted(t *testing.T) {
	if !unshiftedTime("monotonic 0 0\nboottime 0 0\n") {
		t.Fatal("zero offsets refused")
	}
	for _, b := range []string{"", "monotonic 0 0", "monotonic 1 0\nboottime 0 0", "monotonic 0 1\nboottime 0 0", "monotonic 0 0\nboottime -1 0", "monotonic 0 0\nmonotonic 0 0", "monotonic 0 0\nboottime 0 0\nextra 0 0"} {
		if unshiftedTime(b) {
			t.Fatal("shift/missing/duplicate accepted", b)
		}
	}
}

func TestActualEntryMemfdSealsAndOriginalTime(t *testing.T) {
	now, err := MonotonicNow()
	if err != nil {
		t.Fatal(err)
	}
	original := now - uint64(37*time.Millisecond)
	f, err := NewEntryContract(original)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	goOrigin, rawOrigin, deadline, err := readEntry(f)
	if err != nil || rawOrigin != original || deadline != original+uint64(StartupWindow) {
		t.Fatal(rawOrigin, deadline, err)
	}
	if goOrigin == goOrigin.Round(0) || time.Since(goOrigin) < 37*time.Millisecond {
		t.Fatal("origin reset or monotonic reading lost")
	}
	if _, err := f.WriteAt([]byte{0}, 0); err == nil {
		t.Fatal("sealed bytes writable")
	}
	if err := f.Truncate(0); err == nil {
		t.Fatal("sealed length writable")
	}
	if _, err := fcntl(f.Fd(), fAddSeals, 16); err == nil {
		t.Fatal("sealed seal set mutable")
	}
	if _, err := NewEntryContract(math.MaxUint64); err == nil {
		t.Fatal("future contract accepted")
	}
}

func TestEntryOrdinaryFileCannotImpersonateContractOrOwner(t *testing.T) {
	path := filepath.Join(t.TempDir(), "contract")
	if err := os.WriteFile(path, make([]byte, entryFrameSize), 0600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, _, _, err := readEntry(f); err == nil {
		t.Fatal("ordinary file accepted")
	}
	if err := validateOwner(int(f.Fd())); err == nil {
		t.Fatal("ordinary file accepted as owner")
	}
}

func openTestPidfd(t *testing.T, pid int) *os.File {
	t.Helper()
	fd, _, e := syscall.Syscall(434, uintptr(pid), 0, 0) // pidfd_open, amd64
	if e != 0 {
		t.Fatal(e)
	}
	return os.NewFile(fd, "test-owned-pidfd")
}

func TestEntryOwnerHelper(t *testing.T) {
	if os.Getenv("RPC_ENTRY_OWNED_HELPER") != "1" {
		return
	}
	if _, err := os.Stdout.WriteString("ready\n"); err != nil {
		os.Exit(2)
	}
	var b [1]byte
	_, _ = os.Stdin.Read(b[:]) // EOF from the owning test releases this process.
	os.Exit(0)
}

func TestWatchdogObservesExactHeldOwnerDeath(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestEntryOwnerHelper$")
	cmd.Env = []string{"RPC_ENTRY_OWNED_HELPER=1"}
	in, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		in.Close()
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	ready := make(chan bool, 1)
	go func() { line, err := bufio.NewReader(out).ReadString('\n'); ready <- err == nil && line == "ready\n" }()
	select {
	case ok := <-ready:
		if !ok {
			t.Fatal("helper did not become ready")
		}
	case <-time.After(time.Second):
		t.Fatal("helper readiness timed out")
	}
	fd := openTestPidfd(t, cmd.Process.Pid)
	defer fd.Close()
	if err := validateOwner(int(fd.Fd())); err != nil {
		t.Fatal(err)
	}
	now, err := MonotonicNow()
	if err != nil {
		t.Fatal(err)
	}
	armed, done, finished := make(chan struct{}), make(chan int, 1), make(chan struct{})
	go func() {
		defer close(finished)
		watchEntry(int(fd.Fd()), now+uint64(2*time.Second), armed, func(code int) { done <- code })
	}()
	defer func() { <-finished }() // Drain before the descriptor can be closed/reused.
	<-armed
	start := time.Now()
	in.Close()
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != 124 || time.Since(start) >= time.Second {
			t.Fatal("owner death not observed promptly", code)
		}
	case <-time.After(time.Second):
		t.Fatal("watchdog did not observe exact owner exit")
	}
	if err := validateOwner(int(fd.Fd())); err == nil {
		t.Fatal("exited owner accepted")
	}
}

func TestWatchdogOriginalDeadlineIndependentOfBlockedCaller(t *testing.T) {
	fd := openTestPidfd(t, os.Getpid())
	defer fd.Close()
	now, err := MonotonicNow()
	if err != nil {
		t.Fatal(err)
	}
	armed, done, finished := make(chan struct{}), make(chan int, 1), make(chan struct{})
	go func() {
		defer close(finished)
		watchEntry(int(fd.Fd()), now+uint64(25*time.Millisecond), armed, func(code int) { done <- code })
	}()
	defer func() { <-finished }()
	<-armed
	select {
	case code := <-done:
		if code != 124 {
			t.Fatal(code)
		}
	case <-time.After(time.Second):
		t.Fatal("deadline watchdog blocked")
	}
}

func TestEntryRefusesOrdinaryHostProcess(t *testing.T) {
	if os.Getpid() == 1 {
		t.Fatal("this test must not run as namespace init")
	}
	old := os.Args
	os.Args = []string{"rpc-native-init"}
	defer func() { os.Args = old }()
	if code := EnterInherited(); code != 126 {
		t.Fatal("host-mode entry accepted", code)
	}
}
