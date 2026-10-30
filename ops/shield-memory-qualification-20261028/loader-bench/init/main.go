// Loader-only SNP bench /init. Runs only as PID 1 inside the guest. It mounts
// proc, sysfs, devtmpfs and cgroup2 (never a host filesystem), runs
// /bin/shieldmodel once in a fresh 45 GiB memory cgroup, prints timestamped
// before/after memory metrics on the console, and powers off. There is no
// shell, module loading, network or inference.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	loaderPath     = "/bin/shieldmodel"
	reclaimMarker  = "/rt/shield-original-source-reclaim.enabled"
	dropMarker     = "/rt/shield-model-drop-cache.enabled"
	modelDir       = "/models/qwen3.8-27b-mtp-q4-vl-gguf"
	modelDevice    = "vda"
	modelSize      = 17559178144
	modelSHA256    = "3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e"
	cgroupRoot     = "/sys/fs/cgroup"
	childCgroup    = "shieldmodel"
	childMemoryMax = 45 << 30
	// Below the host unit's RuntimeMaxSec=180, so a slow load is reported
	// by the guest as a timeout instead of being cut off silently.
	childTimeout  = 150 * time.Second
	maxChildLines = 64
	maxLineBytes  = 4096
)

func main() {
	if os.Getpid() != 1 {
		// Never mount, create cgroups or power off anything outside the guest.
		fmt.Fprintln(os.Stderr, "bench init: refusing to run as pid", os.Getpid())
		os.Exit(2)
	}
	e := &emitter{w: os.Stdout, now: boottimeNS}
	func() {
		defer func() {
			if p := recover(); p != nil {
				e.emit("result", "status", "error", "reason", fmt.Sprint("init_panic: ", p))
			}
		}()
		run(e)
	}()
	syscall.Sync()
	// The poweroff record is always last; the host requires it.
	e.emit("poweroff")
	err := syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	fmt.Fprintln(os.Stderr, "bench init: poweroff failed:", err)
	// PID 1 must not exit. The host unit's RuntimeMaxSec ends the VM, and the
	// host never reports success for a unit that did not exit cleanly.
	for {
		time.Sleep(time.Hour)
	}
}

func run(e *emitter) {
	fail := func(stage string, err error) {
		e.emit("result", "status", "error", "reason", stage+": "+err.Error(), "digest_verified", "false")
	}
	if err := mountAll(); err != nil {
		fail("mount", err)
		return
	}
	if f, err := os.OpenFile("/dev/console", os.O_WRONLY, 0); err == nil {
		e.setWriter(f)
	}
	e.emit("boot", "cmdline", readValue("/proc/cmdline"), "osrelease", readValue("/proc/sys/kernel/osrelease"),
		"modules_disabled", disableModules())
	arm, info, err := preflight()
	e.emit("preflight", append([]string{"arm", arm}, info...)...)
	if err != nil {
		fail("preflight", err)
		return
	}
	emitMetrics(e, "boot")
	cgfd, swap, err := setupChildCgroup(cgroupRoot, childCgroup)
	if err != nil {
		e.emit("cgroup-setup", "status", "error")
		fail("cgroup_setup", err)
		return
	}
	e.emit("cgroup-setup", "status", "ok", "path", cgroupRoot+"/"+childCgroup,
		"memory.max", strconv.FormatInt(childMemoryMax, 10), "memory.swap.max", swap)
	emitMetrics(e, "before")
	e.emit("child-start", "path", loaderPath, "arm", arm)
	c := runChild(e, cgfd)
	syscall.Close(cgfd)
	e.emit("child-exit", "exit", strconv.Itoa(c.exitCode), "signal", c.signal,
		"timed_out", strconv.FormatBool(c.timedOut), "wall_ms", strconv.FormatInt(c.wallMS, 10),
		"cgroup", c.cgroup)
	emitMetrics(e, "after")
	m, found := parseModelLine(c.stdout)
	status, reason, verified := classify(arm, c, m, found)
	if status == "ok" {
		if err := checkPrivateCopy(); err != nil {
			status, reason = "error", "private_copy: "+err.Error()
		}
	}
	e.emit("result", "status", status, "reason", reason, "arm", arm,
		"digest_verified", strconv.FormatBool(verified),
		"model_bytes", strconv.FormatInt(m.bytes, 10), "model_sha256", m.sha256,
		"copy_verify_ms", strconv.FormatInt(m.copyMS, 10),
		"advised_bytes", strconv.FormatInt(m.advised, 10), "advice_failures", strconv.FormatInt(m.failures, 10),
		"child_exit", strconv.Itoa(c.exitCode), "child_wall_ms", strconv.FormatInt(c.wallMS, 10))
}

// emitter writes one console record per call:
//
//	BENCH seq=N t_ns=BOOTTIME kind=K k=v ... crc=CRC32
//
// Keys and values are query-escaped, so no field contains a space. crc is
// CRC-32 (IEEE) of everything before " crc=", so a record torn by
// interleaved kernel messages is rejected by the host parser.
type emitter struct {
	mu  sync.Mutex
	w   io.Writer
	now func() int64
	seq int
}

func (e *emitter) setWriter(w io.Writer) {
	e.mu.Lock()
	e.w = w
	e.mu.Unlock()
}

func (e *emitter) emit(kind string, kv ...string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.seq++
	var b strings.Builder
	fmt.Fprintf(&b, "BENCH seq=%d t_ns=%d kind=%s", e.seq, e.now(), url.QueryEscape(kind))
	for i := 0; i+1 < len(kv); i += 2 {
		b.WriteString(" " + url.QueryEscape(kv[i]) + "=" + url.QueryEscape(kv[i+1]))
	}
	line := b.String()
	fmt.Fprintf(e.w, "%s crc=%08x\n", line, crc32.ChecksumIEEE([]byte(line)))
}

// boottimeNS is CLOCK_BOOTTIME, so the host can line records up with the
// guest's own uptime across phases.
func boottimeNS() int64 {
	const clockBoottime = 7
	var ts syscall.Timespec
	if _, _, e := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, clockBoottime, uintptr(unsafe.Pointer(&ts)), 0); e != 0 {
		return -1
	}
	return ts.Nano()
}

func mountAll() error {
	const hardened = syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC
	for _, m := range []struct {
		src, dst, fs string
		flags        uintptr
		data         string
	}{
		{"proc", "/proc", "proc", hardened, ""},
		{"sysfs", "/sys", "sysfs", hardened, ""},
		{"devtmpfs", "/dev", "devtmpfs", syscall.MS_NOSUID | syscall.MS_NOEXEC, "mode=0755"},
		{"cgroup2", cgroupRoot, "cgroup2", hardened, ""},
	} {
		if err := syscall.Mount(m.src, m.dst, m.fs, m.flags, m.data); err != nil {
			return fmt.Errorf("%s: %w", m.dst, err)
		}
	}
	return nil
}

// disableModules latches module loading off for this boot. A kernel built
// without modules has no such file, which is equally fine.
func disableModules() string {
	switch err := writeCtl("/proc/sys/kernel/modules_disabled", "1"); {
	case err == nil:
		return "1"
	case errors.Is(err, os.ErrNotExist):
		return "absent"
	default:
		return "error"
	}
}

// preflight checks the guest matches the plan: the reclaim marker is present,
// the arm comes only from the drop-cache marker, the loader exists, the only
// disk is a read-only vda large enough for the model, there is no network
// interface besides lo, and the models directory is empty.
func preflight() (string, []string, error) {
	var info []string
	if _, err := os.Stat(reclaimMarker); err != nil {
		return "", info, fmt.Errorf("reclaim marker: %w", err)
	}
	arm := "A"
	if _, err := os.Stat(dropMarker); err == nil {
		arm = "B"
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", info, fmt.Errorf("drop-cache marker: %w", err)
	}
	if st, err := os.Stat(loaderPath); err != nil {
		return arm, info, err
	} else if !st.Mode().IsRegular() || st.Mode().Perm()&0111 == 0 {
		return arm, info, errors.New("loader is not an executable file")
	}
	disks, err := listNames("/sys/block")
	info = append(info, "block", strings.Join(disks, ","))
	if err != nil {
		return arm, info, err
	}
	for _, d := range disks {
		if d != modelDevice && !strings.HasPrefix(d, "loop") && !strings.HasPrefix(d, "ram") {
			return arm, info, fmt.Errorf("unexpected block device %s", d)
		}
	}
	ro := readValue("/sys/block/" + modelDevice + "/ro")
	sectors, _ := strconv.ParseInt(readValue("/sys/block/"+modelDevice+"/size"), 10, 64)
	info = append(info, "vda_ro", ro, "vda_bytes", strconv.FormatInt(sectors*512, 10))
	if ro != "1" {
		return arm, info, errors.New("model device is not read-only")
	}
	if sectors*512 < modelSize {
		return arm, info, errors.New("model device smaller than the pinned model")
	}
	if st, err := os.Stat("/dev/" + modelDevice); err != nil || st.Mode()&os.ModeDevice == 0 || st.Mode()&os.ModeCharDevice != 0 {
		return arm, info, errors.New("/dev/vda is not a block device")
	}
	nets, err := listNames("/sys/class/net")
	info = append(info, "net", strings.Join(nets, ","))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return arm, info, err
	}
	for _, n := range nets {
		if n != "lo" {
			return arm, info, fmt.Errorf("unexpected network interface %s", n)
		}
	}
	if names, err := listNames(modelDir); err != nil {
		return arm, info, err
	} else if len(names) != 0 {
		return arm, info, errors.New("models directory is not empty")
	}
	return arm, info, nil
}

func listNames(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	names := make([]string, 0, len(ents))
	for _, d := range ents {
		names = append(names, d.Name())
	}
	return names, err
}

// setupChildCgroup creates root/name with memory.max=45 GiB and, if the
// kernel accounts swap, memory.swap.max=0. Any failure is fatal: the loader
// never runs outside a configured cgroup. It returns an O_DIRECTORY fd for
// clone3(CLONE_INTO_CGROUP) and the swap setting applied.
func setupChildCgroup(root, name string) (int, string, error) {
	ctl, err := os.ReadFile(root + "/cgroup.controllers")
	if err != nil {
		return -1, "", fmt.Errorf("cgroup2 controllers: %w", err)
	}
	if !hasWord(string(ctl), "memory") {
		return -1, "", errors.New("memory controller unavailable")
	}
	if err := writeCtl(root+"/cgroup.subtree_control", "+memory"); err != nil {
		return -1, "", fmt.Errorf("enable memory controller: %w", err)
	}
	if sub, err := os.ReadFile(root + "/cgroup.subtree_control"); err != nil || !hasWord(string(sub), "memory") {
		return -1, "", errors.New("memory controller not enabled for children")
	}
	dir := root + "/" + name
	if err := os.Mkdir(dir, 0755); err != nil {
		return -1, "", err
	}
	swap, err := configureChild(dir)
	if err != nil {
		return -1, "", err
	}
	fd, err := syscall.Open(dir, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return -1, "", fmt.Errorf("open cgroup: %w", err)
	}
	return fd, swap, nil
}

func configureChild(dir string) (string, error) {
	if err := setCtl(dir+"/memory.max", strconv.FormatInt(childMemoryMax, 10)); err != nil {
		return "", err
	}
	switch err := setCtl(dir+"/memory.swap.max", "0"); {
	case err == nil:
		return "0", nil
	case errors.Is(err, os.ErrNotExist):
		return "unsupported", nil
	default:
		return "", err
	}
}

// setCtl writes a cgroup control file and reads the value back.
func setCtl(path, v string) error {
	if err := writeCtl(path, v); err != nil {
		return err
	}
	if got := readValue(path); got != v {
		return fmt.Errorf("%s reads %q, want %q", path, got, v)
	}
	return nil
}

// writeCtl never creates files: a missing control file is an error.
func writeCtl(path, v string) error {
	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		return err
	}
	_, err = f.WriteString(v)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func hasWord(s, w string) bool {
	for _, f := range strings.Fields(s) {
		if f == w {
			return true
		}
	}
	return false
}

func readValue(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return "absent"
		}
		return "error"
	}
	return strings.TrimSpace(string(b))
}

// kvLines parses "key value [unit]" files: /proc/meminfo ("MemFree: 12 kB"),
// memory.stat and memory.events ("anon 12").
func kvLines(text string) []string {
	var kv []string
	for _, l := range strings.Split(text, "\n") {
		f := strings.Fields(l)
		if len(f) >= 2 {
			kv = append(kv, strings.TrimSuffix(f[0], ":"), f[1])
		}
	}
	return kv
}

func prefixed(p string, kv []string) []string {
	out := make([]string, len(kv))
	for i, s := range kv {
		if i%2 == 0 {
			s = p + s
		}
		out[i] = s
	}
	return out
}

func emitMetrics(e *emitter, phase string) {
	if b, err := os.ReadFile("/proc/meminfo"); err != nil {
		e.emit("meminfo", "phase", phase, "status", "error")
	} else {
		e.emit("meminfo", append([]string{"phase", phase, "status", "ok", "unit", "kB"}, prefixed("m.", kvLines(string(b)))...)...)
	}
	emitCgroup(e, phase, "root", cgroupRoot)
	emitCgroup(e, phase, "child", cgroupRoot+"/"+childCgroup)
}

// emitCgroup reports whichever memory files this kernel provides; the root
// cgroup has no memory.current or memory.peak, which is reported as absent.
func emitCgroup(e *emitter, phase, scope, dir string) {
	kv := []string{"phase", phase, "scope", scope}
	for _, f := range []string{"memory.current", "memory.peak", "memory.max", "memory.swap.current", "memory.swap.max"} {
		kv = append(kv, f, readValue(dir+"/"+f))
	}
	e.emit("cgroup", kv...)
	for _, f := range []string{"memory.stat", "memory.events"} {
		b, err := os.ReadFile(dir + "/" + f)
		if err != nil {
			e.emit("cgroupfile", "phase", phase, "scope", scope, "file", f, "status", readValue(dir+"/"+f))
			continue
		}
		e.emit("cgroupfile", append([]string{"phase", phase, "scope", scope, "file", f, "status", "ok"}, prefixed("s.", kvLines(string(b)))...)...)
	}
}

type childResult struct {
	exitCode int // -1 when signalled or never started
	signal   string
	timedOut bool
	wallMS   int64
	cgroup   string
	stdout   []string
	err      error
}

// runChild starts the loader directly inside the configured cgroup with an
// empty environment, relays its output, and kills it after childTimeout.
func runChild(e *emitter, cgfd int) childResult {
	c := childResult{exitCode: -1}
	outR, outW, err := os.Pipe()
	if err != nil {
		c.err = err
		return c
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		outR.Close()
		outW.Close()
		c.err = err
		return c
	}
	cmd := &exec.Cmd{
		Path:        loaderPath,
		Args:        []string{"shieldmodel"},
		Env:         []string{},
		Dir:         "/",
		Stdout:      outW,
		Stderr:      errW,
		SysProcAttr: &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: cgfd},
	}
	start := time.Now()
	err = cmd.Start()
	outW.Close()
	errW.Close()
	if err != nil {
		outR.Close()
		errR.Close()
		c.err = err
		return c
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); c.stdout = relay(e, "child-stdout", outR) }()
	go func() { defer wg.Done(); relay(e, "child-stderr", errR) }()
	var timedOut atomic.Bool
	timer := time.AfterFunc(childTimeout, func() { timedOut.Store(true); cmd.Process.Kill() })
	c.cgroup = readValue(fmt.Sprintf("/proc/%d/cgroup", cmd.Process.Pid))
	if c.cgroup != "0::/"+childCgroup {
		cmd.Process.Kill()
	}
	werr := cmd.Wait()
	timer.Stop()
	wg.Wait()
	outR.Close()
	errR.Close()
	c.wallMS = time.Since(start).Milliseconds()
	c.timedOut = timedOut.Load()
	if ws, ok := cmd.ProcessState.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			c.signal = strconv.Itoa(int(ws.Signal()))
		} else {
			c.exitCode = ws.ExitStatus()
		}
	} else if werr != nil {
		c.err = werr
	}
	return c
}

// relay forwards at most maxChildLines lines of at most maxLineBytes each,
// then drains the rest so the child never blocks on a full pipe.
func relay(e *emitter, kind string, r io.Reader) []string {
	var lines []string
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, maxLineBytes), maxLineBytes)
	for sc.Scan() {
		if len(lines) == maxChildLines {
			e.emit(kind+"-truncated", "reason", "lines")
			break
		}
		lines = append(lines, sc.Text())
		e.emit(kind, "n", strconv.Itoa(len(lines)), "line", sc.Text())
	}
	if sc.Err() != nil {
		e.emit(kind+"-truncated", "reason", "long_line")
	}
	io.Copy(io.Discard, r)
	return lines
}

type modelLine struct {
	bytes, copyMS, advised, failures int64
	sha256                           string
	hasAdvice                        bool
}

// parseModelLine accepts exactly one "MODEL verified" line from the loader,
// in either the legacy or the drop-cache format (loader-candidate/main.go).
func parseModelLine(lines []string) (modelLine, bool) {
	var m modelLine
	found := 0
	for _, l := range lines {
		rest, ok := strings.CutPrefix(l, "MODEL verified ")
		if !ok {
			continue
		}
		found++
		kv := map[string]string{}
		for _, f := range strings.Fields(rest) {
			k, v, ok := strings.Cut(f, "=")
			if !ok {
				return m, false
			}
			kv[k] = v
		}
		var errs [5]error
		m.bytes, errs[0] = strconv.ParseInt(kv["bytes"], 10, 64)
		m.copyMS, errs[1] = strconv.ParseInt(kv["copy_verify_ms"], 10, 64)
		m.sha256 = kv["sha256"]
		_, a := kv["source_dontneed_advised_bytes"]
		_, f := kv["source_dontneed_failures"]
		if a != f {
			return m, false
		}
		if m.hasAdvice = a; a {
			m.advised, errs[2] = strconv.ParseInt(kv["source_dontneed_advised_bytes"], 10, 64)
			m.failures, errs[3] = strconv.ParseInt(kv["source_dontneed_failures"], 10, 64)
		}
		if m.sha256 == "" {
			errs[4] = errors.New("no sha256")
		}
		if errors.Join(errs[:]...) != nil {
			return m, false
		}
	}
	return m, found == 1
}

// classify is the guest verdict. digest_verified needs a clean loader exit
// and its MODEL line naming the pinned size and digest. ok also needs the
// loader format to match the arm's marker.
func classify(arm string, c childResult, m modelLine, found bool) (string, string, bool) {
	verified := c.err == nil && !c.timedOut && c.signal == "" && c.exitCode == 0 &&
		found && m.bytes == modelSize && m.sha256 == modelSHA256
	switch {
	case c.err != nil:
		return "error", "child_start: " + c.err.Error(), false
	case c.cgroup != "0::/"+childCgroup:
		return "error", "child_cgroup_mismatch", false
	case c.timedOut:
		return "error", "child_timeout", false
	case c.signal != "":
		return "error", "child_signal_" + c.signal, false
	case c.exitCode != 0:
		return "error", "loader_exit_" + strconv.Itoa(c.exitCode), false
	case !found:
		return "error", "no_model_line", false
	case !verified:
		return "error", "model_line_mismatch", false
	case (arm == "B") != m.hasAdvice:
		return "error", "arm_marker_mismatch", verified
	}
	return "ok", "loaded", verified
}

// checkPrivateCopy confirms the loader left the verified private copy on its
// tmpfs and both published names, as main.go does after verification.
func checkPrivateCopy() error {
	st, err := os.Stat(modelDir + "/private/model.gguf")
	if err != nil {
		return err
	}
	if st.Size() != modelSize || st.Mode().Perm() != 0444 {
		return fmt.Errorf("size %d mode %v", st.Size(), st.Mode().Perm())
	}
	for _, name := range []string{"model.gguf", "Qwen3.8-27B-UD-Q4_K_XL.gguf"} {
		if got, err := os.Stat(modelDir + "/" + name); err != nil || !os.SameFile(got, st) {
			return fmt.Errorf("%s does not resolve to the private copy", name)
		}
	}
	return nil
}
