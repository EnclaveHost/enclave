// monitor: the one privileged component inside an M3 guest (isolation/m3/PLAN.md).
//
// M1 and M2 put one app inside one measured guest, so a verifier learned which app it was talking to
// from the launch measurement alone. M3 puts this monitor inside the measured guest and loads apps into
// it afterwards, which is what a VMPL design would also force (PLAN.md section 3: under IGVM the launch
// measurement covers the monitor and firmware, not the app). So identity moves:
//
//	the hardware signs the report -> the report's measurement names THIS monitor
//	                              -> the monitor names the app it loaded and hashed itself.
//
// Which makes three rules non-negotiable here:
//  1. the monitor is the ONLY holder of the report interface. No domain can see /sys, so no domain can
//     ask the hardware anything directly.
//  2. the app hash in a report comes from the monitor's OWN table, keyed by the kernel credentials of
//     the socket the request arrived on. A domain cannot ask for a report naming another app, because
//     the request has no field in which to say one.
//  3. the host chooses which app to load, but cannot misreport it: the monitor hashes the bytes it
//     received and names that hash.
//
// Two things follow from the monitor being privileged and shared, and both are handled here rather than
// assumed away:
//   - EVERY domain ends exactly once, however it ends. A crashed workload, a killed process tree and an
//     explicit destroy all run the same reclamation, which is idempotent and waits for the processes to
//     be gone before unmounting. A domain that died must not stay in the table, keep its port answering,
//     or hold its mounts and cgroup.
//   - work a domain asks of the monitor is BOUNDED. Callers are authenticated before their bytes are
//     parsed, requests are read under a size cap and a deadline, and reports are admitted under a global
//     and a per-domain limit. Otherwise a domain could move memory and work into the monitor, which runs
//     outside that domain's cgroup, and starve every other domain's reports.
//
// What separates one domain from another in THIS build is the guest kernel: namespaces, a uid and a
// cgroup each (see domexec.c). That is WEAKER than the VMPL separation M3b would give, and it puts the
// guest kernel inside the TCB for app-vs-app isolation — the set of things that must be correct for one
// app to stay protected from another. SNP still excludes the host from all of it.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"enclave.host/isolation/m2/vsock"
)

// Bounds. A domain is untrusted, and the host is trusted only to choose what to load, so everything
// either of them sends is read under a cap and a clock.
const (
	maxReportRequest  = 1 << 10 // a request is a 64-hex binding in a small JSON object
	reportDeadline    = 20 * time.Second
	drainAfterRefusal = 1 << 10 // read this much of a refused caller's bytes so it sees the refusal, not a reset
	maxReportsTotal   = 16      // reports in flight across all domains
	maxReportsPerDom  = 2       // ...and from any one domain, so one cannot crowd out the rest
	maxCommandLine    = 64 << 10
	maxAppBytes       = 64 << 20
	maxControlConns   = 4
	controlDeadline   = 5 * time.Minute
	exitGrace         = 15 * time.Second // how long to wait for a killed domain's processes to go
)

type domain struct {
	ID     int    `json:"id"`
	Label  string `json:"label"`
	AppSha string `json:"appSha256"`
	Port   uint32 `json:"port"`
	UID    int    `json:"uid"`
	CPU    int    `json:"cpuPercent"`
	MemMiB int    `json:"memMiB"`

	dir     string
	cgroup  string
	cmd     *exec.Cmd
	ln      *vsock.Listener
	appHash [32]byte

	exited   chan struct{} // closed when the process tree is gone
	reclaim  sync.Once     // listener, mounts, directory and cgroup are released exactly once
	inFlight chan struct{} // this domain's share of concurrent report work
}

type reporter func(rd []byte) (report, certs []byte, err error)

type monitor struct {
	mu      sync.Mutex
	doms    map[int]*domain
	byUID   map[int]*domain
	next    int
	snp     bool
	plat    string
	root    string
	basePrt uint32
	baseUID int

	report  reporter      // the hardware path, or a stand-in under test
	tsmMu   sync.Mutex    // one configfs entry at a time
	reports chan struct{} // global admission for report work
}

var errNoHardwareReport = errors.New("no hardware report on this tier")

func main() {
	snp := flag.Bool("snp", false, "this guest is an SEV-SNP guest: hardware reports are available")
	control := flag.Uint("control-port", 9000, "vsock port the host loads domains on")
	sock := flag.String("report-sock", "/run/monitor.sock", "unix socket domains ask for reports on")
	plat := flag.String("plat", "/plat", "read-only platform tree bind-mounted into every domain")
	root := flag.String("domains", "/domains", "directory holding one subtree per domain")
	basePort := flag.Uint("base-port", 40000, "domain N serves on this vsock port + N")
	baseUID := flag.Int("base-uid", 5000, "domain N runs as this uid + N")
	flag.Parse()

	m := newMonitor(*snp, *plat, *root, uint32(*basePort), *baseUID)
	must(os.MkdirAll(m.root, 0o755))
	must(os.MkdirAll(filepath.Dir(*sock), 0o755))
	os.Remove(*sock)

	rl, err := net.Listen("unix", *sock)
	must(err)
	must(os.Chmod(*sock, 0o666)) // every domain uid may ask; who is asking comes from the kernel, not the request
	go m.serveReports(rl)

	cl, err := vsock.Listen(uint32(*control))
	must(err)
	fmt.Printf("MON ready control_port=%d snp=%v\n", *control, m.snp)
	slots := make(chan struct{}, maxControlConns)
	for {
		c, err := cl.Accept()
		if err != nil {
			fmt.Printf("MON ERROR control accept: %v\n", err)
			return
		}
		select {
		case slots <- struct{}{}:
			go func() { defer func() { <-slots }(); m.serveControl(c) }()
		default:
			c.Close() // the host is not owed unbounded concurrency either
		}
	}
}

func newMonitor(snp bool, plat, root string, basePort uint32, baseUID int) *monitor {
	m := &monitor{doms: map[int]*domain{}, byUID: map[int]*domain{}, next: 1, snp: snp,
		plat: plat, root: root, basePrt: basePort, baseUID: baseUID,
		reports: make(chan struct{}, maxReportsTotal)}
	m.report = m.tsmReport
	return m
}

// --- the host's control channel ----------------------------------------------------------------
// One JSON request per line. `load` is followed by exactly Size bytes of Wasm. The host picks what to
// load; it cannot choose what the monitor then says the app is.

type request struct {
	Cmd    string `json:"cmd"`
	Label  string `json:"label"`
	Size   int    `json:"size"`
	CPU    int    `json:"cpu"`
	MemMiB int    `json:"mem"`
	ID     int    `json:"id"`
}

func (m *monitor) serveControl(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	enc := json.NewEncoder(c)
	for {
		c.SetDeadline(time.Now().Add(controlDeadline))
		line, err := readLine(br, maxCommandLine)
		if err != nil {
			return
		}
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			enc.Encode(map[string]string{"error": "bad request: " + err.Error()})
			return
		}
		switch req.Cmd {
		case "load":
			d, err := m.load(br, req)
			if err != nil {
				fmt.Printf("MON ERROR load: %v\n", err)
				enc.Encode(map[string]string{"error": err.Error()})
				return // the stream position is no longer known: this connection is finished
			}
			enc.Encode(d)
		case "list":
			enc.Encode(map[string]any{"domains": m.snapshot()})
		case "state":
			enc.Encode(m.state())
		case "destroy":
			if err := m.destroy(req.ID); err != nil {
				enc.Encode(map[string]string{"error": err.Error()})
				continue
			}
			enc.Encode(map[string]any{"destroyed": req.ID})
		default:
			enc.Encode(map[string]string{"error": "unknown command " + req.Cmd})
		}
	}
}

// readLine reads one newline-terminated command, refusing anything longer than the cap rather than
// growing a buffer to fit whatever arrives.
func readLine(br *bufio.Reader, max int) ([]byte, error) {
	var out []byte
	for {
		chunk, err := br.ReadSlice('\n')
		out = append(out, chunk...)
		if len(out) > max {
			return nil, fmt.Errorf("command exceeds %d bytes", max)
		}
		if err == nil {
			return out, nil
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return nil, err
		}
	}
}

func (m *monitor) load(br *bufio.Reader, req request) (*domain, error) {
	if req.Size <= 0 || req.Size > maxAppBytes {
		return nil, fmt.Errorf("size %d out of range (max %d)", req.Size, maxAppBytes)
	}
	app := make([]byte, req.Size)
	if _, err := io.ReadFull(br, app); err != nil {
		return nil, fmt.Errorf("reading app: %w", err)
	}
	// The monitor hashes what it actually received. This hash, not anything the host said, is what
	// every report for this domain will name.
	sum := sha256.Sum256(app)

	m.mu.Lock()
	id := m.next
	m.next++
	m.mu.Unlock()

	d := &domain{ID: id, Label: req.Label, AppSha: hex.EncodeToString(sum[:]), appHash: sum,
		Port: m.basePrt + uint32(id), UID: m.baseUID + id, CPU: req.CPU, MemMiB: req.MemMiB,
		dir: filepath.Join(m.root, strconv.Itoa(id)), cgroup: "/sys/fs/cgroup/dom" + strconv.Itoa(id),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	if d.CPU <= 0 {
		d.CPU = 100
	}
	if d.MemMiB <= 0 {
		d.MemMiB = 256
	}
	if err := m.start(d, app); err != nil {
		m.retire(d, "failed to start: "+err.Error())
		return nil, err
	}
	fmt.Printf("MON domain %d loaded label=%s app_sha256=%s port=%d uid=%d cpu=%d%% mem=%dMiB\n",
		d.ID, d.Label, d.AppSha, d.Port, d.UID, d.CPU, d.MemMiB)
	return d, nil
}

// start builds the domain's root, its share, and the process tree that runs it. The domain is in the
// table BEFORE its first instruction, so however it ends — including during startup — the reaper can
// find it and retire it.
func (m *monitor) start(d *domain, app []byte) error {
	for _, sub := range []string{"plat", "run", "tmp", "proc"} {
		if err := os.MkdirAll(filepath.Join(d.dir, sub), 0o755); err != nil {
			return err
		}
	}
	// The app is read-only to the domain, and so is its hash: the domain may read what it runs but
	// cannot change what the monitor will name.
	if err := os.WriteFile(filepath.Join(d.dir, "app.wasm"), app, 0o444); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(d.dir, "app.sha256"), []byte(d.AppSha), 0o444); err != nil {
		return err
	}
	// the platform tree (runtime, front, domexec) read-only, and the monitor's socket, are all the
	// domain gets from outside itself
	platAt := filepath.Join(d.dir, "plat")
	if err := syscall.Mount(m.plat, platAt, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fmt.Errorf("bind %s: %w", m.plat, err)
	}
	if err := syscall.Mount("", platAt, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_REC, ""); err != nil {
		return fmt.Errorf("remount ro %s: %w", platAt, err)
	}
	sockAt := filepath.Join(d.dir, "run", "monitor.sock")
	if f, err := os.OpenFile(sockAt, os.O_CREATE|os.O_RDONLY, 0o600); err == nil {
		f.Close()
	}
	if err := syscall.Mount("/run/monitor.sock", sockAt, "", syscall.MS_BIND, ""); err != nil {
		return fmt.Errorf("bind report socket: %w", err)
	}
	// the front creates its own socket in /run, so that directory belongs to the domain
	if err := os.Chown(filepath.Join(d.dir, "run"), d.UID, d.UID); err != nil {
		return err
	}
	if err := m.cgroup(d); err != nil {
		return err
	}
	// CLONE_INTO_CGROUP: the domain is inside its share before its first instruction. Writing
	// cgroup.procs after starting it would race the workloads domexec forks, and whatever won that race
	// would run outside the limit.
	cgFD, err := os.Open(d.cgroup)
	if err != nil {
		return fmt.Errorf("opening cgroup: %w", err)
	}
	defer cgFD.Close()

	ln, err := vsock.Listen(d.Port)
	if err != nil {
		return fmt.Errorf("vsock port %d: %w", d.Port, err)
	}
	d.ln = ln

	cmd := exec.Command("/plat/domexec", strconv.Itoa(d.ID), strconv.Itoa(d.UID))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Chroot: d.dir,
		// its own mount, process, network, IPC and hostname namespaces. The network namespace is why
		// every domain can use 127.0.0.1:8080 without collision or reach.
		Cloneflags:   syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS,
		Unshareflags: syscall.CLONE_NEWNS,
		Setpgid:      true,
		UseCgroupFD:  true,
		CgroupFD:     int(cgFD.Fd()),
	}
	d.cmd = cmd
	m.register(d) // in the table first: a domain that dies during startup must still be reclaimed
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting domain: %w", err)
	}
	go func() {
		err := cmd.Wait()
		close(d.exited)
		// Whatever ended it — a crashed runtime, a killed front, domexec itself — the domain is over,
		// and everything it held goes back now rather than at some later destroy that may never come.
		m.retire(d, exitReason(err))
	}()

	// The monitor relays the domain's one port. TLS ends INSIDE the domain, so what passes here is
	// ciphertext: the monitor moves the bytes without being able to read them.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return // the listener is closed when the domain is retired
			}
			go relay(c, filepath.Join(d.dir, "run", "front.sock"))
		}
	}()
	return nil
}

func exitReason(err error) string {
	if err == nil {
		return "its process tree exited"
	}
	return "its process tree exited: " + err.Error()
}

func (m *monitor) register(d *domain) {
	m.mu.Lock()
	m.doms[d.ID] = d
	m.byUID[d.UID] = d
	m.mu.Unlock()
}

// retire ends a domain exactly once, from whichever direction it ended: a crash, a destroy, or a failed
// start. It leaves the table first, so no new report request can find it while it is being reclaimed,
// and a request already in flight finishes against the domain it was admitted for.
func (m *monitor) retire(d *domain, why string) {
	m.mu.Lock()
	_, listed := m.doms[d.ID]
	if m.doms[d.ID] == d {
		delete(m.doms, d.ID)
	}
	if m.byUID[d.UID] == d {
		delete(m.byUID, d.UID)
	}
	m.mu.Unlock()
	if listed {
		fmt.Printf("MON domain %d ended: %s\n", d.ID, why)
	}
	d.release()
}

// release frees everything the domain holds. It runs once however often it is called, and it does not
// unmount until the processes are actually gone, because a live process holds those mounts busy.
func (d *domain) release() {
	d.reclaim.Do(func() {
		if d.ln != nil {
			d.ln.Close() // the port stops answering at once, ahead of the slower cleanup below
		}
		if d.cmd != nil && d.cmd.Process != nil {
			// the whole group; killing the init of a PID namespace takes its children with it
			syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
			d.cmd.Process.Kill()
			select {
			case <-d.exited:
			case <-time.After(exitGrace):
				fmt.Printf("MON WARN domain %d did not exit within %s; reclaiming anyway\n", d.ID, exitGrace)
			}
		}
		for _, mp := range []string{filepath.Join(d.dir, "run", "monitor.sock"), filepath.Join(d.dir, "plat")} {
			if err := syscall.Unmount(mp, syscall.MNT_DETACH); err != nil &&
				!errors.Is(err, syscall.EINVAL) && !errors.Is(err, syscall.ENOENT) {
				fmt.Printf("MON WARN domain %d unmount %s: %v\n", d.ID, mp, err)
			}
		}
		if err := os.RemoveAll(d.dir); err != nil {
			fmt.Printf("MON WARN domain %d removing %s: %v\n", d.ID, d.dir, err)
		}
		// a cgroup can only be removed once the kernel has reaped the last process in it
		for i := 0; ; i++ {
			err := os.Remove(d.cgroup)
			if err == nil || errors.Is(err, syscall.ENOENT) || os.IsNotExist(err) {
				break
			}
			if i == 50 {
				fmt.Printf("MON WARN domain %d cgroup %s not removed: %v\n", d.ID, d.cgroup, err)
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
}

func relay(c net.Conn, frontSock string) {
	defer c.Close()
	up, err := net.DialTimeout("unix", frontSock, 5*time.Second)
	if err != nil {
		return // the domain is not serving (yet, or any more): the client sees a closed connection
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, c); done <- struct{}{} }()
	go func() { io.Copy(c, up); done <- struct{}{} }()
	<-done
}

func (m *monitor) cgroup(d *domain) error {
	if err := os.MkdirAll(d.cgroup, 0o755); err != nil {
		return err
	}
	// cpu.max is "quota period": the ledger's cpuShare lands here, as in M1
	writes := [][2]string{
		{"cpu.max", fmt.Sprintf("%d 100000", d.CPU*1000)},
		{"memory.max", strconv.Itoa(d.MemMiB << 20)},
		{"pids.max", "128"},
	}
	for _, w := range writes {
		if err := os.WriteFile(filepath.Join(d.cgroup, w[0]), []byte(w[1]), 0); err != nil {
			return fmt.Errorf("%s: %w", w[0], err)
		}
	}
	return nil
}

func (m *monitor) destroy(id int) error {
	m.mu.Lock()
	d := m.doms[id]
	m.mu.Unlock()
	if d == nil {
		return fmt.Errorf("no domain %d", id)
	}
	m.retire(d, "destroyed at lease end")
	return nil
}

func (m *monitor) snapshot() []*domain {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*domain, 0, len(m.doms))
	for _, d := range m.doms {
		out = append(out, d)
	}
	return out
}

// state is what the guest looks like from inside: enough for the harness to prove that a domain which
// crashed or was destroyed left nothing behind.
func (m *monitor) state() map[string]any {
	names := []string{}
	if dirs, err := os.ReadDir(m.root); err == nil {
		for _, e := range dirs {
			names = append(names, e.Name())
		}
	}
	cgroups := 0
	if cg, err := os.ReadDir("/sys/fs/cgroup"); err == nil {
		for _, e := range cg {
			if e.IsDir() && strings.HasPrefix(e.Name(), "dom") {
				cgroups++
			}
		}
	}
	mounts := 0
	if mi, err := os.ReadFile("/proc/self/mountinfo"); err == nil {
		for _, line := range strings.Split(string(mi), "\n") {
			if strings.Contains(line, m.root+"/") {
				mounts++
			}
		}
	}
	procs := 0
	if pd, err := os.ReadDir("/proc"); err == nil {
		for _, e := range pd {
			if _, err := strconv.Atoi(e.Name()); err != nil {
				continue
			}
			// userspace processes only: kernel threads have an empty cmdline
			if b, err := os.ReadFile("/proc/" + e.Name() + "/cmdline"); err == nil && len(b) > 0 {
				procs++
			}
		}
	}
	m.mu.Lock()
	n := len(m.doms)
	m.mu.Unlock()
	return map[string]any{"domains": n, "dirs": names, "cgroups": cgroups, "mounts": mounts, "userspace_procs": procs}
}

// --- reports ------------------------------------------------------------------------------------
// A domain sends 32 bytes of binding (sha256 of its TLS key SPKI and the verifier's nonce) and nothing
// else. There is no field for the app, because the app is not the domain's to state.

type reportReq struct {
	Bind string `json:"bind"`
}

func (m *monitor) serveReports(l net.Listener) {
	for {
		c, err := l.Accept()
		if err != nil {
			return
		}
		// Admission BEFORE a goroutine exists: a flood must not make the monitor allocate one stack per
		// connection. A caller that arrives when the monitor is full is told so and closed.
		select {
		case m.reports <- struct{}{}:
			go func() { defer func() { <-m.reports }(); m.oneReport(c) }()
		default:
			busy(c, "monitor is at its report limit")
		}
	}
}

func busy(c net.Conn, why string) {
	c.SetDeadline(time.Now().Add(2 * time.Second))
	json.NewEncoder(c).Encode(map[string]string{"error": why})
	drain(c)
	c.Close()
}

// drain reads a bounded amount of whatever the peer was still sending, so that closing the connection
// delivers the answer instead of resetting it.
func drain(c net.Conn) {
	c.SetReadDeadline(time.Now().Add(2 * time.Second))
	io.Copy(io.Discard, io.LimitReader(c, drainAfterRefusal))
}

func (m *monitor) oneReport(c net.Conn) {
	defer c.Close()
	c.SetDeadline(time.Now().Add(reportDeadline))
	enc := json.NewEncoder(c)

	// 1. WHO, before anything the caller sent is parsed. Peer credentials come from the kernel and cost
	//    one syscall; parsing first would let an unauthenticated caller spend the monitor's memory.
	uid, err := peerUID(c)
	if err != nil {
		enc.Encode(map[string]string{"error": "no peer credentials: " + err.Error()})
		drain(c)
		return
	}
	m.mu.Lock()
	d := m.byUID[uid]
	m.mu.Unlock()
	if d == nil {
		// nothing else on this guest runs as a domain uid, so this is either a bug or an attempt to
		// obtain a report without being a domain
		fmt.Printf("MON refused report request from uid %d (not a domain)\n", uid)
		enc.Encode(map[string]string{"error": "caller is not a domain"})
		drain(c)
		return
	}

	// 2. this domain's own share of concurrent work, so one domain cannot crowd out the others
	select {
	case d.inFlight <- struct{}{}:
		defer func() { <-d.inFlight }()
	default:
		enc.Encode(map[string]string{"error": "too many concurrent report requests from this domain"})
		drain(c)
		return
	}

	// 3. only now, and only a bounded number of bytes
	var req reportReq
	if err := json.NewDecoder(io.LimitReader(c, maxReportRequest)).Decode(&req); err != nil {
		enc.Encode(map[string]string{"error": "bad request: " + err.Error()})
		return
	}
	bind, err := hex.DecodeString(req.Bind)
	if err != nil || len(bind) != 32 {
		enc.Encode(map[string]string{"error": "bind must be 32 bytes of hex"})
		return
	}
	if !m.snp {
		enc.Encode(map[string]string{"error": errNoHardwareReport.Error()})
		return
	}
	rd := make([]byte, 64)
	copy(rd, bind)              // [0:32] the domain's own key, bound to the verifier's challenge
	copy(rd[32:], d.appHash[:]) // [32:64] the app THIS monitor loaded for THIS domain
	rep, certs, err := m.report(rd)
	if err != nil {
		enc.Encode(map[string]string{"error": err.Error()})
		return
	}
	out := map[string]string{"report": base64.StdEncoding.EncodeToString(rep)}
	if len(certs) > 0 {
		out["certs"] = base64.StdEncoding.EncodeToString(certs)
	}
	enc.Encode(out)
}

func peerUID(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, fmt.Errorf("not a unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *syscall.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if serr != nil {
		return 0, serr
	}
	return int(cred.Uid), nil
}

// tsmReport asks the PSP through configfs-tsm. One entry per request, used under a lock, so an outblob
// always belongs to the inblob just written. No domain can reach this: /sys is not in any domain's
// mount namespace.
func (m *monitor) tsmReport(rd []byte) ([]byte, []byte, error) {
	m.tsmMu.Lock()
	defer m.tsmMu.Unlock()
	dir := fmt.Sprintf("/sys/kernel/config/tsm/report/mon%d", time.Now().UnixNano())
	if err := os.Mkdir(dir, 0o755); err != nil {
		return nil, nil, err
	}
	defer os.Remove(dir)
	if err := os.WriteFile(dir+"/inblob", rd, 0); err != nil {
		return nil, nil, err
	}
	rep, err := os.ReadFile(dir + "/outblob")
	if err != nil {
		return nil, nil, err
	}
	certs, _ := os.ReadFile(dir + "/auxblob")
	return rep, certs, nil
}

func must(err error) {
	if err != nil {
		fmt.Printf("MON ERROR %v\n", err)
		os.Exit(1)
	}
}
