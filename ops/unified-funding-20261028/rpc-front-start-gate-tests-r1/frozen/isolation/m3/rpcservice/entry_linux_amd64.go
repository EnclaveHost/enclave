//go:build linux && amd64

package rpcservice

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

const (
	entryMagic     = "ERPCONE3"
	entryFrameSize = 40
	entrySeals     = 15 // SEAL_SEAL | SHRINK | GROW | WRITE
	fAddSeals      = 1033
	fGetSeals      = 1034
	sysMemfdCreate = 319 // Linux amd64
	procMagic      = 0x9fa0
)

// MonotonicNow is for the trusted monitor to capture admission time BEFORE
// preparation. Calling it later does not authorize a new startup window.
func MonotonicNow() (uint64, error) {
	var t syscall.Timespec
	_, _, e := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&t)), 0)
	if e != 0 {
		return 0, e
	}
	if t.Sec < 0 || t.Nsec < 0 || t.Nsec >= int64(time.Second) || uint64(t.Sec) > uint64(math.MaxInt64)/uint64(time.Second) {
		return 0, errors.New("invalid monotonic clock")
	}
	n := uint64(t.Sec)*uint64(time.Second) + uint64(t.Nsec)
	if n > math.MaxInt64 {
		return 0, errors.New("monotonic clock overflow")
	}
	return n, nil
}

func entryBoot() ([16]byte, error) {
	var boot [16]byte
	var fs syscall.Statfs_t
	if err := syscall.Statfs("/proc", &fs); err != nil {
		return boot, err
	}
	if fs.Type != procMagic {
		return boot, errors.New("kernel proc view required")
	}
	// A boot UUID alone does not bind CLOCK_MONOTONIC across time namespaces.
	// Both producer and consumer require the unshifted kernel clock domain.
	timeView, err := os.Open("/proc/self/timens_offsets")
	if err != nil {
		return boot, err
	}
	offsets, err := io.ReadAll(io.LimitReader(timeView, 4097))
	timeView.Close()
	if err != nil || len(offsets) > 4096 || !unshiftedTime(string(offsets)) {
		return boot, errors.New("unshifted kernel time namespace required")
	}
	f, err := os.Open("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return boot, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 38))
	if err != nil {
		return boot, err
	}
	if len(b) != 37 || b[36] != '\n' || b[8] != '-' || b[13] != '-' || b[18] != '-' || b[23] != '-' {
		return boot, errors.New("invalid kernel boot identity")
	}
	n, err := hex.Decode(boot[:], []byte(strings.ReplaceAll(string(b[:36]), "-", "")))
	if err != nil || n != len(boot) || boot == [16]byte{} {
		return boot, errors.New("invalid kernel boot identity")
	}
	return boot, nil
}

func unshiftedTime(raw string) bool {
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(raw), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || (f[0] != "monotonic" && f[0] != "boottime") || f[1] != "0" || f[2] != "0" || seen[f[0]] {
			return false
		}
		seen[f[0]] = true
	}
	return len(seen) == 2
}

func encodeEntry(boot [16]byte, origin uint64) ([]byte, error) {
	if boot == [16]byte{} || origin > uint64(math.MaxInt64)-uint64(StartupWindow) {
		return nil, errors.New("invalid entry origin")
	}
	b := make([]byte, entryFrameSize)
	copy(b, entryMagic)
	copy(b[8:24], boot[:])
	binary.LittleEndian.PutUint64(b[24:32], origin)
	binary.LittleEndian.PutUint64(b[32:40], origin+uint64(StartupWindow))
	return b, nil
}

// decodeEntry returns the original origin and deadline, never a new interval.
func decodeEntry(b []byte, boot [16]byte, now uint64) (uint64, uint64, error) {
	if len(b) != entryFrameSize || string(b[:8]) != entryMagic || boot == [16]byte{} || string(b[8:24]) != string(boot[:]) {
		return 0, 0, errors.New("entry contract identity mismatch")
	}
	o, d := binary.LittleEndian.Uint64(b[24:32]), binary.LittleEndian.Uint64(b[32:40])
	if o > uint64(math.MaxInt64)-uint64(StartupWindow) || d != o+uint64(StartupWindow) || now < o || now >= d {
		return 0, 0, errors.New("entry outside original startup window")
	}
	return o, d, nil
}

func fcntl(fd, command, arg uintptr) (uintptr, error) {
	r, _, e := syscall.Syscall(syscall.SYS_FCNTL, fd, command, arg)
	if e != 0 {
		return 0, e
	}
	return r, nil
}

// NewEntryContract transports an original monitor admission timestamp across
// exec on the same kernel boot. Sealing prevents mutation, NOT replay or an
// unauthorized monitor. The monitor owns the one-shot claim and app/storage
// authority and must retain its original timestamp through all preparation.
func NewEntryContract(originalOrigin uint64) (*os.File, error) {
	boot, err := entryBoot()
	if err != nil {
		return nil, err
	}
	b, err := encodeEntry(boot, originalOrigin)
	if err != nil {
		return nil, err
	}
	now, err := MonotonicNow()
	if err != nil {
		return nil, err
	}
	if _, _, err = decodeEntry(b, boot, now); err != nil {
		return nil, err
	}
	name := []byte("enclave-rpc-entry\x00")
	fd, _, e := syscall.Syscall(sysMemfdCreate, uintptr(unsafe.Pointer(&name[0])), 3, 0) // CLOEXEC|ALLOW_SEALING
	if e != 0 {
		return nil, e
	}
	f := os.NewFile(fd, "rpc-entry-contract")
	good := false
	defer func() {
		if !good {
			f.Close()
		}
	}()
	if n, err := f.Write(b); err != nil || n != len(b) {
		return nil, errors.New("entry contract write failed")
	}
	if _, err := fcntl(fd, fAddSeals, entrySeals); err != nil {
		return nil, err
	}
	if _, _, _, err := readEntry(f); err != nil {
		return nil, err
	}
	good = true
	return f, nil
}

func readEntry(f *os.File) (time.Time, uint64, uint64, error) {
	var zero time.Time
	if f == nil {
		return zero, 0, 0, errors.New("missing entry contract")
	}
	st, err := f.Stat()
	if err != nil {
		return zero, 0, 0, err
	}
	if !st.Mode().IsRegular() || st.Size() != entryFrameSize {
		return zero, 0, 0, errors.New("bounded sealed entry contract required")
	}
	seals, err := fcntl(f.Fd(), fGetSeals, 0)
	if err != nil || seals&entrySeals != entrySeals {
		return zero, 0, 0, errors.New("entry contract is not fully sealed")
	}
	b := make([]byte, entryFrameSize)
	if n, err := syscall.Pread(int(f.Fd()), b, 0); err != nil || n != len(b) {
		return zero, 0, 0, errors.New("entry contract read failed")
	}
	boot, err := entryBoot()
	if err != nil {
		return zero, 0, 0, err
	}
	// Using the earlier Go time makes the reconstructed deadline conservative:
	// time spent between the samples cannot extend the original deadline.
	before := time.Now()
	now, err := MonotonicNow()
	if err != nil {
		return zero, 0, 0, err
	}
	origin, deadline, err := decodeEntry(b, boot, now)
	if err != nil {
		return zero, 0, 0, err
	}
	return before.Add(-time.Duration(now - origin)), origin, deadline, nil
}

type entryPollFD struct {
	FD              int32
	Events, Revents int16
}

func pollOwner(fd int, duration time.Duration) (bool, error) {
	p := entryPollFD{FD: int32(fd), Events: 1} // POLLIN
	t := syscall.NsecToTimespec(int64(duration))
	n, _, e := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&p)), 1, uintptr(unsafe.Pointer(&t)), 0, 0, 0)
	if e == syscall.EINTR {
		return false, nil
	} // next iteration rechecks original time
	if e != 0 {
		return false, e
	}
	// Any event, including POLLNVAL/HUP/ERR, closes the gate.
	return n != 0 || p.Revents != 0, nil
}

func validateOwner(fd int) error {
	if fd < 0 || fd > math.MaxInt32 {
		return errors.New("invalid owner descriptor")
	}
	link, err := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fd))
	if err != nil || link != "anon_inode:[pidfd]" {
		return errors.New("kernel owner pidfd required")
	}
	dead, err := pollOwner(fd, 0)
	if err != nil {
		return err
	}
	if dead {
		return errors.New("owner is not live")
	}
	return nil
}

// watchEntry observes only a held owner descriptor. It never signals another
// process. Production terminate is os.Exit: exiting namespace PID1 makes the
// kernel terminate its descendants. This is separate from New/Run/cleanup.
// A trusted outer guardian remains required for stalled kernel termination.
func watchEntry(fd int, deadline uint64, armed chan<- struct{}, terminate func(int)) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	close(armed)
	for {
		now, err := MonotonicNow()
		if err != nil || now >= deadline {
			terminate(124)
			return
		}
		wait := time.Duration(deadline - now)
		if wait > 20*time.Millisecond {
			wait = 20 * time.Millisecond
		}
		dead, err := pollOwner(fd, wait)
		if err != nil || dead {
			terminate(124)
			return
		}
	}
}

func entryControl(control *os.File, g Groups) error {
	id, err := cgroupDir(control)
	if err != nil {
		return err
	}
	parent, err := cgroupDir(g.Parent)
	if err != nil {
		return err
	}
	if up, err := dotdot(control); err != nil || up != parent {
		return errors.New("control group must be a direct child")
	}
	for _, other := range []*os.File{g.Parent, g.EL, g.CL, g.Base, g.Probe, g.Controller, g.Front} {
		x, err := cgroupDir(other)
		if err != nil || id == x {
			return errors.New("distinct control group required")
		}
	}
	if err := expectControls(control, [][2]string{{"cgroup.type", "domain"}, {"memory.max", "134217728"}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"pids.max", "128"}, {"cpu.max", "max 100000"}, {"cgroup.procs", fmt.Sprint(os.Getpid())}}); err != nil {
		return err
	}
	return nil
}

// EnterInherited is a fixed executable boundary for a measured namespace
// bootstrap. It does NOT authenticate the root, app bundle, storage, one-shot
// claim, mount write scopes, JWT or network policy; the trusted monitor must
// establish those before invoking it. There is deliberately no host CLI mode.
//
// FD3 owner pidfd, FD4 sealed original deadline, FD5 parent cgroup, FD6..9
// EL/CL/Base/probe, FD10 supervisor control, FD11 controller, FD12 front cgroup. All are process-lifetime
// capabilities. The monitor must transfer its OWN pidfd, not a host-selected
// unrelated process. The control group is a sibling of all role groups,
// inside the aggregate 19 GiB budget; an internal domain node stays empty.
func EnterInherited() int {
	if len(os.Args) != 1 || os.Getpid() != 1 || os.Getuid() != 0 || os.Geteuid() != 0 {
		return 126
	}
	if err := validateOwner(3); err != nil {
		return 126
	}
	files := make([]*os.File, 10)
	for i := range files {
		fd := 3 + i
		if _, err := fcntl(uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); err != nil {
			return 126
		}
		files[i] = os.NewFile(uintptr(fd), "rpc-entry-inherited")
	}
	// Keep every descriptor, including contract/control, alive until exit. An
	// uncertain cleanup never closes capabilities out from under in-flight work.
	defer runtime.KeepAlive(files)
	origin, _, deadline, err := readEntry(files[1])
	if err != nil {
		return 126
	}
	armed := make(chan struct{})
	go watchEntry(3, deadline, armed, os.Exit)
	<-armed
	g := Groups{Parent: files[2], EL: files[3], CL: files[4], Base: files[5], Probe: files[6], Controller: files[8], Front: files[9]}
	if err := entryControl(files[7], g); err != nil {
		return 126
	}
	s, err := New(Request{Origin: origin, Groups: g})
	if err != nil {
		return 126
	}
	if err := validateOwner(3); err != nil {
		return 126
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	state, err := s.Run(ctx)
	if err == nil && state.Outcome == OutcomeStopped && state.Cleanup == CleanupConfirmed {
		return 0
	}
	return 125
}
