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
	"encoding/binary"
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
	drainAfterRefusal = 1 << 10                // read this much of a refused caller's bytes so it sees the refusal, not a reset
	maxReportsTotal   = 16                     // reports in flight across all domains
	maxReportsPerDom  = 2                      // ...and from any one domain, so one cannot crowd out the rest
	maxRefusals       = 8                      // polite refusals in flight; beyond this, close at once
	drainWindow       = 250 * time.Millisecond // how long a refused peer's remaining bytes are absorbed
	maxCommandLine    = 64 << 10
	maxAppBytes       = 64 << 20
	maxControlConns   = 4
	controlDeadline   = 5 * time.Minute
	exitGrace         = 15 * time.Second // how long to wait for a killed domain's processes to go
)

// A domain's life has four states, and they exist because startup and reclamation can race: a destroy
// can arrive while the domain is still being built, and its process can die during startup. Without an
// explicit state, a reclamation that ran first could consume the one-shot cleanup before the process
// existed — and the domain that then started would never be reclaimable at all.
type domainState int

const (
	domStarting domainState = iota // being built; nothing may reclaim it yet
	domRunning                     // its process tree is live
	domEnding                      // reclamation has begun
	domEnded                       // reclamation finished
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

	probe    bool          // run the measured adversary probe instead of the app, for the isolation tests
	exited   chan struct{} // closed when the process tree is gone
	reclaim  sync.Once     // listener, mounts, directory and cgroup are released exactly once
	inFlight chan struct{} // this domain's share of concurrent report work

	mu        sync.Mutex
	state     domainState
	endWanted string      // set while starting: end it as soon as startup finishes, for this reason
	proc      *os.Process // a STABLE handle, set once Start returned. Never signal by raw pid.
	reaped    bool        // Wait returned: the pid is gone and must never be signalled again
}

// requestEnd records that a domain should end. It returns true when the caller should reclaim it now,
// and false when startup still owns it — in which case startup will reclaim it on the way out.
func (d *domain) requestEnd(why string) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	switch d.state {
	case domStarting:
		if d.endWanted == "" {
			d.endWanted = why
		}
		return false
	case domEnding, domEnded:
		return false
	}
	d.state = domEnding
	return true
}

// finishStart publishes the process handle and moves the domain to running. It returns the reason a
// reclamation asked for while startup held the domain, or "" if none did.
func (d *domain) finishStart(proc *os.Process) string {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.proc = proc
	// Only ever forward, from starting to running. Setting it unconditionally would resurrect a domain
	// that had already ended, and the reclamation that followed would find its one-shot cleanup spent
	// and leave the domain stuck half-ended.
	if d.state == domStarting {
		d.state = domRunning
	}
	return d.endWanted
}

// failStart takes a domain that never got going straight to ending, so the caller can reclaim it.
func (d *domain) failStart() {
	d.mu.Lock()
	d.state = domEnding
	d.mu.Unlock()
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

	vmpl      int           // the level the PSP put in our own signed report: the level we can actually speak for
	vmplFloor int           // the lowest level this kernel will let us ask for. Its own claim, see tsmLevel
	vmpl0     string        // what happened when we asked for a report at level 0: refused, GRANTED, or n/a
	report    reporter      // the hardware path, or a stand-in under test
	tsmMu     sync.Mutex    // one configfs entry at a time
	reports   chan struct{} // global admission for report work
	refusals  chan struct{} // separate, small budget for politely closing refused callers
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
	// Which privilege level are we, and can we prove it? Three different things get printed, because
	// they are worth different amounts:
	//   vmpl_floor  what this kernel SAYS (tsmLevel). Cheap, and not evidence: see tsmLevel.
	//   vmpl        the level the PSP wrote into our own signed report. Signed, so a verifier can pin it.
	//   vmpl0       whether we can obtain a report at level 0. A guest that CAN is at VMPL0 whatever else
	//               it claims, so a refusal here is the part that actually bounds us from above.
	if m.snp {
		if lvl, err := m.tsmLevel(); err == nil {
			m.vmplFloor = lvl
		} else {
			fmt.Printf("MON WARN could not read this guest's privilege level floor: %v\n", err)
		}
		m.vmpl0 = "n/a"
		if rep, _, err := m.tsmReport(make([]byte, 64)); err == nil {
			m.vmpl = reportVmpl(rep)
		} else {
			fmt.Printf("MON WARN could not read our own level from a report: %v\n", err)
		}
		if m.vmplFloor > 0 {
			// The one probe that cannot be faked downwards: ask for level 0. Our secrets page has no
			// VMPCK0 unless we ARE at VMPL0, so this must fail.
			if _, _, err := m.tsmReportAt(0, make([]byte, 64)); err == nil {
				m.vmpl0 = "GRANTED"
			} else {
				m.vmpl0 = "refused"
			}
		}
	}
	fmt.Printf("MON ready control_port=%d snp=%v vmpl=%d vmpl_floor=%d vmpl0=%s\n",
		*control, m.snp, m.vmpl, m.vmplFloor, m.vmpl0)
	slots := make(chan struct{}, maxControlConns)
	for {
		c, err := cl.Accept()
		if err != nil {
			fmt.Printf("MON ERROR control accept: %v\n", err)
			return
		}
		if !fromHost(c) {
			c.Close()
			continue
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
		reports: make(chan struct{}, maxReportsTotal), refusals: make(chan struct{}, maxRefusals)}
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
	// Probe runs the measured adversary probe (/plat/domprobe) as this domain's workload instead of the
	// runtime and front. It stands in for a tenant whose runtime has been compromised: native code with
	// the domain's uid and namespaces, trying to reach other domains and the monitor. The host can only
	// choose BETWEEN measured binaries, never supply one, and the probe only reports what it could reach.
	Probe bool `json:"probe"`
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
		case "stop":
			if err := m.stop(req.ID); err != nil {
				enc.Encode(map[string]string{"error": err.Error()})
				continue
			}
			enc.Encode(map[string]any{"stopped": req.ID})
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
		probe: req.Probe, exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	if d.CPU <= 0 {
		d.CPU = 100
	}
	if d.MemMiB <= 0 {
		d.MemMiB = 256
	}
	if err := m.start(d, app); err != nil {
		return nil, err // start() has already released whatever it managed to take
	}
	fmt.Printf("MON domain %d loaded label=%s app_sha256=%s port=%d uid=%d cpu=%d%% mem=%dMiB\n",
		d.ID, d.Label, d.AppSha, d.Port, d.UID, d.CPU, d.MemMiB)
	return d, nil
}

// start builds the domain's root, its share, and the process tree that runs it. The domain is in the
// table BEFORE its first instruction, so however it ends — including during startup — the reaper can
// find it and retire it.
func (m *monitor) start(d *domain, app []byte) error {
	// Every failure below reclaims what this function took, rather than leaving that to a caller that
	// cannot know how far it got.
	fail := func(err error) error {
		m.abandon(d, "failed to start: "+err.Error())
		return err
	}
	for _, sub := range []string{"plat", "run", "tmp", "proc"} {
		if err := os.MkdirAll(filepath.Join(d.dir, sub), 0o755); err != nil {
			return fail(err)
		}
	}
	// The app is read-only to the domain, and so is its hash: the domain may read what it runs but
	// cannot change what the monitor will name.
	if err := os.WriteFile(filepath.Join(d.dir, "app.wasm"), app, 0o444); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(d.dir, "app.sha256"), []byte(d.AppSha), 0o444); err != nil {
		return fail(err)
	}
	// the platform tree (runtime, front, domexec) read-only, and the monitor's socket, are all the
	// domain gets from outside itself
	platAt := filepath.Join(d.dir, "plat")
	if err := syscall.Mount(m.plat, platAt, "", syscall.MS_BIND|syscall.MS_REC, ""); err != nil {
		return fail(fmt.Errorf("bind %s: %w", m.plat, err))
	}
	if err := syscall.Mount("", platAt, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_REC, ""); err != nil {
		return fail(fmt.Errorf("remount ro %s: %w", platAt, err))
	}
	sockAt := filepath.Join(d.dir, "run", "monitor.sock")
	if f, err := os.OpenFile(sockAt, os.O_CREATE|os.O_RDONLY, 0o600); err == nil {
		f.Close()
	}
	if err := syscall.Mount("/run/monitor.sock", sockAt, "", syscall.MS_BIND, ""); err != nil {
		return fail(fmt.Errorf("bind report socket: %w", err))
	}
	// the front creates its own socket in /run, so that directory belongs to the domain
	if err := os.Chown(filepath.Join(d.dir, "run"), d.UID, d.UID); err != nil {
		return fail(err)
	}
	if err := m.cgroup(d); err != nil {
		return fail(err)
	}
	// CLONE_INTO_CGROUP: the domain is inside its share before its first instruction. Writing
	// cgroup.procs after starting it would race the workloads domexec forks, and whatever won that race
	// would run outside the limit.
	cgFD, err := os.Open(d.cgroup)
	if err != nil {
		return fail(fmt.Errorf("opening cgroup: %w", err))
	}
	defer cgFD.Close()

	ln, err := vsock.Listen(d.Port)
	if err != nil {
		return fail(fmt.Errorf("vsock port %d: %w", d.Port, err))
	}

	mode := "app"
	if d.probe {
		mode = "probe"
	}
	cmd := exec.Command("/plat/domexec", strconv.Itoa(d.ID), strconv.Itoa(d.UID), mode, strconv.Itoa(d.MemMiB))
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
	return m.launch(d, cmd, ln)
}

// launch starts a built domain's process tree and publishes it. Everything that can fail from here on
// abandons the domain, which is why this is separate: it is the only window in which a domain is in the
// tables but has no process, and it has to close that window whichever way it goes.
func (m *monitor) launch(d *domain, cmd *exec.Cmd, ln *vsock.Listener) error {
	// This function owns both from here on, so that abandoning the domain closes the listener too. Taking
	// the listener without recording it would leave a port answering for a domain that never ran.
	d.cmd, d.ln = cmd, ln
	// In the table before its first instruction, so a domain that dies during startup is still found
	// and reclaimed. While it is `starting`, a destroy does not tear it down: it records the request and
	// leaves it to this function, which is the only thing that knows how far the build got.
	m.register(d)
	if err := cmd.Start(); err != nil {
		m.abandon(d, "failed to start")
		return fmt.Errorf("starting domain: %w", err)
	}
	go func() {
		err := cmd.Wait()
		d.mu.Lock()
		d.reaped = true // the pid is gone from here on and must never be signalled again
		d.mu.Unlock()
		close(d.exited)
		// Whatever ended it — a crashed runtime, a killed front, domexec itself — the domain is over,
		// and everything it held goes back now rather than at some later destroy that may never come.
		m.retire(d, exitReason(err))
	}()

	// The monitor relays the domain's one port. TLS ends INSIDE the domain, so what passes here is
	// ciphertext: the monitor moves the bytes without being able to read them.
	if ln != nil {
		go func() {
			for {
				c, err := ln.Accept()
				if err != nil {
					return // the listener is closed when the domain is retired
				}
				// Only the HOST may open a domain's port. vsock is not fully namespaced, so without this a
				// process inside one domain could connect to another domain's port and be relayed straight
				// to that domain's front — a cross-domain channel through the monitor itself.
				if !fromHost(c) {
					fmt.Printf("MON refused a connection to domain %d's port from inside the guest (%s)\n", d.ID, c.RemoteAddr())
					c.Close()
					continue
				}
				go relay(c, filepath.Join(d.dir, "run", "front.sock"))
			}
		}()
	}

	// Publish the process handle and go live. If a destroy arrived while this was building, honour it
	// now — in that order, so reclamation always runs against a fully-built domain.
	if why := d.finishStart(cmd.Process); why != "" {
		m.retire(d, why)
		return fmt.Errorf("domain %d was ended during startup: %s", d.ID, why)
	}
	return nil
}

// fromHost reports whether a vsock peer is the hypervisor rather than something inside this guest.
func fromHost(c net.Conn) bool {
	a, ok := c.RemoteAddr().(vsock.Addr)
	return ok && a.CID == vsock.CIDHost
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

// deregister removes exactly this domain from both tables. Compare-and-delete, so a later domain that
// has taken the same id or uid is left alone. It reports whether the domain was still listed.
func (m *monitor) deregister(d *domain) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, listed := m.doms[d.ID]
	if m.doms[d.ID] == d {
		delete(m.doms, d.ID)
	}
	if m.byUID[d.UID] == d {
		delete(m.byUID, d.UID)
	}
	return listed
}

// abandon ends a domain that never got running. It goes STRAIGHT to the tables and the reclamation,
// without the starting-state deferral in requestEnd: that deferral exists to hand a domain back to
// start(), and this IS start() finishing with it. Leaving the tables matters as much as freeing the
// files — a registered domain whose files are gone would still be listed, and its uid would still
// authenticate for reports.
func (m *monitor) abandon(d *domain, why string) {
	listed := m.deregister(d)
	d.failStart()
	d.release()
	if listed {
		fmt.Printf("MON domain %d ended: %s\n", d.ID, why)
	}
}

// retire ends a domain exactly once, from whichever direction it ended: a crash, a destroy, or a failed
// start. It leaves the table first, so no new report request can find it while it is being reclaimed,
// and a request already in flight finishes against the domain it was admitted for.
func (m *monitor) retire(d *domain, why string) {
	listed := m.deregister(d)
	// Leaving the tables always happens: no new report request can find a domain that is ending. Whether
	// this caller also RECLAIMS it depends on the lifecycle — a domain still starting up belongs to
	// start(), which will reclaim it once it knows what it built.
	if !d.requestEnd(why) {
		return
	}
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
		d.mu.Lock()
		proc, reaped := d.proc, d.reaped
		d.mu.Unlock()
		if proc != nil && !reaped {
			// Kill by CGROUP. That is the strong identity here: it names exactly this domain's
			// processes, however many there are, and it cannot be confused with anything else. A pid or
			// a process-group id can be recycled between being read and being signalled, and the signal
			// would then land on unrelated later work.
			//
			// The os.Process fallback is safe for a narrower reason, and not because it is necessarily
			// pidfd-backed — that is a runtime detail this code does not verify and should not rely on.
			// It is safe because we are the PARENT: until we reap the child, its pid is held by a zombie
			// and cannot be reused, and `reaped` above is set by the one goroutine that reaps it. So the
			// only pid we ever signal is one that is still ours.
			if err := os.WriteFile(filepath.Join(d.cgroup, "cgroup.kill"), []byte("1"), 0); err != nil {
				fmt.Printf("MON WARN domain %d cgroup.kill: %v\n", d.ID, err)
				proc.Kill() // fall back to the handle, which knows whether the process is already gone
			}
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
		d.mu.Lock()
		d.state = domEnded
		d.mu.Unlock()
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

// stop ends a domain the gentle way: signal its FRONT, which stops accepting, and let the domain's init
// notice its child is gone and wind the rest down. If it does not go within the grace period, retire
// kills it anyway — a lease that has ended has ended.
func (m *monitor) stop(id int) error {
	m.mu.Lock()
	d := m.doms[id]
	m.mu.Unlock()
	if d == nil {
		return fmt.Errorf("no domain %d", id)
	}
	d.mu.Lock()
	proc, state := d.proc, d.state
	d.mu.Unlock()
	if proc == nil || state != domRunning {
		fmt.Printf("MON domain %d stop: not running yet; ending it outright\n", d.ID)
		m.retire(d, "stopped at lease end")
		return nil
	}
	// Signal the domain's INIT through the handle we hold, and let it pass SIGTERM to the front. Hunting
	// for the front's pid in cgroup.procs and /proc would mean signalling a number that could have been
	// recycled between the read and the kill; this uses an identity we own.
	fmt.Printf("MON domain %d stop: signalling its init to wind down\n", d.ID)
	if err := proc.Signal(syscall.SIGTERM); err != nil {
		fmt.Printf("MON domain %d stop: %v; ending it outright\n", d.ID, err)
		m.retire(d, "stopped at lease end")
		return nil
	}
	select {
	case <-d.exited:
		fmt.Printf("MON domain %d stopped gracefully\n", d.ID)
	case <-time.After(10 * time.Second):
		fmt.Printf("MON domain %d did not wind down in 10s; ending it outright\n", d.ID)
	}
	m.retire(d, "stopped at lease end")
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
	memTotal, memAvail := 0, 0
	if mi, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(mi), "\n") {
			var into *int
			switch {
			case strings.HasPrefix(line, "MemTotal:"):
				into = &memTotal
			case strings.HasPrefix(line, "MemAvailable:"):
				into = &memAvail
			default:
				continue
			}
			f := strings.Fields(line)
			if len(f) >= 2 {
				if kb, err := strconv.Atoi(f[1]); err == nil {
					*into = kb / 1024
				}
			}
		}
	}
	m.mu.Lock()
	n := len(m.doms)
	m.mu.Unlock()
	return map[string]any{"domains": n, "dirs": names, "cgroups": cgroups, "mounts": mounts,
		"userspace_procs": procs, "mem_total_mib": memTotal, "mem_available_mib": memAvail}
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
		// connection.
		select {
		case m.reports <- struct{}{}:
			go func() {
				refused := m.oneReport(c)
				// The global slot goes back BEFORE anything slow happens. A refused caller is then
				// closed politely on a separate, small budget, so one domain's refusals cannot occupy
				// the budget that every other domain's reports need.
				<-m.reports
				if refused {
					m.closePolitely(c)
					return
				}
				c.Close()
			}()
		default:
			// NEVER in the accept loop: answering and draining here would stall every other tenant's
			// connection behind one slow peer.
			answer(c, "monitor is at its report limit")
			m.closePolitely(c)
		}
	}
}

func answer(c net.Conn, why string) {
	c.SetWriteDeadline(time.Now().Add(2 * time.Second))
	json.NewEncoder(c).Encode(map[string]string{"error": why})
}

// closePolitely absorbs a bounded amount of whatever a refused peer was still sending, so that closing
// the connection delivers the answer instead of resetting it — on its own small budget, and never while
// holding a report slot. When that budget is full, the connection is simply closed: a refused caller is
// owed an answer, not an unbounded amount of the monitor's attention.
func (m *monitor) closePolitely(c net.Conn) {
	select {
	case m.refusals <- struct{}{}:
		go func() {
			defer func() { <-m.refusals }()
			c.SetReadDeadline(time.Now().Add(drainWindow))
			io.Copy(io.Discard, io.LimitReader(c, drainAfterRefusal))
			c.Close()
		}()
	default:
		c.Close()
	}
}

// oneReport answers one request. It returns true when the answer was a refusal, so the caller can give
// the global slot back and then close the connection on the refusal budget instead of this one.
func (m *monitor) oneReport(c net.Conn) (refused bool) {
	c.SetDeadline(time.Now().Add(reportDeadline))
	enc := json.NewEncoder(c)

	// 1. WHO, before anything the caller sent is parsed. Peer credentials come from the kernel and cost
	//    one syscall; parsing first would let an unauthenticated caller spend the monitor's memory.
	uid, err := peerUID(c)
	if err != nil {
		enc.Encode(map[string]string{"error": "no peer credentials: " + err.Error()})
		return true
	}
	m.mu.Lock()
	d := m.byUID[uid]
	m.mu.Unlock()
	if d == nil {
		// nothing else on this guest runs as a domain uid, so this is either a bug or an attempt to
		// obtain a report without being a domain
		fmt.Printf("MON refused report request from uid %d (not a domain)\n", uid)
		enc.Encode(map[string]string{"error": "caller is not a domain"})
		return true
	}

	// 2. this domain's own share of concurrent work, so one domain cannot crowd out the others
	select {
	case d.inFlight <- struct{}{}:
		defer func() { <-d.inFlight }()
	default:
		enc.Encode(map[string]string{"error": "too many concurrent report requests from this domain"})
		return true
	}

	// 3. only now, and only a bounded number of bytes
	var req reportReq
	if err := json.NewDecoder(io.LimitReader(c, maxReportRequest)).Decode(&req); err != nil {
		enc.Encode(map[string]string{"error": "bad request: " + err.Error()})
		return true
	}
	bind, err := hex.DecodeString(req.Bind)
	if err != nil || len(bind) != 32 {
		enc.Encode(map[string]string{"error": "bind must be 32 bytes of hex"})
		return true
	}
	if !m.snp {
		enc.Encode(map[string]string{"error": errNoHardwareReport.Error()})
		return true
	}
	rd := make([]byte, 64)
	copy(rd, bind)              // [0:32] the domain's own key, bound to the verifier's challenge
	copy(rd[32:], d.appHash[:]) // [32:64] the app THIS monitor loaded for THIS domain
	rep, certs, err := m.report(rd)
	if err != nil {
		enc.Encode(map[string]string{"error": err.Error()})
		return true
	}
	out := map[string]string{"report": base64.StdEncoding.EncodeToString(rep)}
	if len(certs) > 0 {
		out["certs"] = base64.StdEncoding.EncodeToString(certs)
	}
	enc.Encode(out)
	return false
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

// tsmLevel reads configfs-tsm's `privlevel_floor`: the lowest level this guest may request a report for.
// By default that is the guest's own VMPL, because arch/x86/coco/sev/core.c sets the VMPCK id from
// snp_vmpl and drivers/virt/coco/sev-guest/sev-guest.c copies it into privlevel_floor.
//
// It is NOT evidence of anything. vmpck_id is a module parameter (sev_guest.vmpck_id=N), so this number
// is the guest kernel's own claim about itself and whoever controls that kernel's command line chooses
// it. We read it because we need a level to ASK for, not because it proves a level. What a verifier
// pins is the VMPL field inside the signed report, and what bounds us from above is being refused at
// level 0 (see vmpl0 in main). The attribute only exists when the provider supports levels at all, so
// a missing file is an answer too.
func (m *monitor) tsmLevel() (int, error) {
	m.tsmMu.Lock()
	defer m.tsmMu.Unlock()
	dir := fmt.Sprintf("/sys/kernel/config/tsm/report/level%d", time.Now().UnixNano())
	if err := os.Mkdir(dir, 0o755); err != nil {
		return 0, err
	}
	defer os.Remove(dir)
	b, err := os.ReadFile(dir + "/privlevel_floor")
	if err != nil {
		return 0, fmt.Errorf("privlevel_floor: %w", err)
	}
	lvl, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return 0, fmt.Errorf("privlevel_floor %q: %w", b, err)
	}
	return lvl, nil
}

// tsmReport asks the PSP through configfs-tsm. One entry per request, used under a lock, so an outblob
// always belongs to the inblob just written. No domain can reach this: /sys is not in any domain's
// mount namespace.
func (m *monitor) tsmReport(rd []byte) ([]byte, []byte, error) {
	return m.tsmReportAt(m.vmplFloor, rd)
}

// tsmReportAt is tsmReport for one named level. Asking for a level we are not entitled to must fail, and
// the startup probe depends on that failing rather than on anyone's claim about it.
func (m *monitor) tsmReportAt(level int, rd []byte) ([]byte, []byte, error) {
	m.tsmMu.Lock()
	defer m.tsmMu.Unlock()
	dir := fmt.Sprintf("/sys/kernel/config/tsm/report/mon%d", time.Now().UnixNano())
	if err := os.Mkdir(dir, 0o755); err != nil {
		return nil, nil, err
	}
	defer os.Remove(dir)
	// Ask for the report at the lowest level this kernel allows us, rather than letting it default: under
	// an SVSM the default 0 is below our floor and the kernel refuses it outright. A verifier is told
	// which level to expect and refuses anything else (relay/snp-verify.mjs expectedVmpl), so the two
	// have to agree deliberately.
	if level > 0 {
		if err := os.WriteFile(dir+"/privlevel", []byte(strconv.Itoa(level)), 0); err != nil {
			return nil, nil, fmt.Errorf("privlevel %d: %w", level, err)
		}
	}
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

// reportVmpl reads the VMPL field out of an SNP attestation report (table 22: 4 bytes little-endian at
// offset 0x30). This is the PSP's word, inside the signed region, so a verifier can pin it -- which is
// not the same as it proving the guest is confined: a guest AT VMPL0 holds every VMPCK and can therefore
// ask for a report naming a lower level. Downward claims are cheap; being refused at level 0 is not.
func reportVmpl(rep []byte) int {
	if len(rep) < 0x34 {
		return -1
	}
	return int(binary.LittleEndian.Uint32(rep[0x30:0x34]))
}

func must(err error) {
	if err != nil {
		fmt.Printf("MON ERROR %v\n", err)
		os.Exit(1)
	}
}
