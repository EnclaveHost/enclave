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
// What separates one domain from another in THIS build is the guest kernel: namespaces, a uid and a
// cgroup each (see domexec.c). That is WEAKER than the VMPL separation M3b would give, and it puts the
// guest kernel inside the app-vs-app TCB. SNP still excludes the host from all of it.
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"enclave.host/isolation/m2/vsock"
)

type domain struct {
	ID      int    `json:"id"`
	Label   string `json:"label"`
	AppSha  string `json:"appSha256"`
	Port    uint32 `json:"port"`
	UID     int    `json:"uid"`
	CPU     int    `json:"cpuPercent"`
	MemMiB  int    `json:"memMiB"`
	dir     string
	cgroup  string
	cmd     *exec.Cmd
	ln      *vsock.Listener
	appHash [32]byte
}

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
	tsmMu   sync.Mutex
}

func main() {
	snp := flag.Bool("snp", false, "this guest is an SEV-SNP guest: hardware reports are available")
	control := flag.Uint("control-port", 9000, "vsock port the host loads domains on")
	sock := flag.String("report-sock", "/run/monitor.sock", "unix socket domains ask for reports on")
	plat := flag.String("plat", "/plat", "read-only platform tree bind-mounted into every domain")
	root := flag.String("domains", "/domains", "directory holding one subtree per domain")
	basePort := flag.Uint("base-port", 40000, "domain N serves on this vsock port + N")
	baseUID := flag.Int("base-uid", 5000, "domain N runs as this uid + N")
	flag.Parse()

	m := &monitor{doms: map[int]*domain{}, byUID: map[int]*domain{}, next: 1, snp: *snp,
		plat: *plat, root: *root, basePrt: uint32(*basePort), baseUID: *baseUID}
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
	for {
		c, err := cl.Accept()
		if err != nil {
			fmt.Printf("MON ERROR control accept: %v\n", err)
			return
		}
		go m.serveControl(c)
	}
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
		line, err := br.ReadBytes('\n')
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
				continue
			}
			enc.Encode(d)
		case "list":
			m.mu.Lock()
			out := make([]*domain, 0, len(m.doms))
			for _, d := range m.doms {
				out = append(out, d)
			}
			m.mu.Unlock()
			enc.Encode(map[string]any{"domains": out})
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

func (m *monitor) load(br *bufio.Reader, req request) (*domain, error) {
	if req.Size <= 0 || req.Size > 256<<20 {
		return nil, fmt.Errorf("size %d out of range", req.Size)
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
		dir: filepath.Join(m.root, strconv.Itoa(id)), cgroup: "/sys/fs/cgroup/dom" + strconv.Itoa(id)}
	if d.CPU <= 0 {
		d.CPU = 100
	}
	if d.MemMiB <= 0 {
		d.MemMiB = 256
	}
	if err := m.start(d, app); err != nil {
		m.teardown(d)
		return nil, err
	}
	m.mu.Lock()
	m.doms[d.ID] = d
	m.byUID[d.UID] = d
	m.mu.Unlock()
	fmt.Printf("MON domain %d loaded label=%s app_sha256=%s port=%d uid=%d cpu=%d%% mem=%dMiB\n",
		d.ID, d.Label, d.AppSha, d.Port, d.UID, d.CPU, d.MemMiB)
	return d, nil
}

// start builds the domain's root, its share, and the process tree that runs it.
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
	cmd := exec.Command("/plat/domexec", strconv.Itoa(d.ID), strconv.Itoa(d.UID))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Chroot:      d.dir,
		UseCgroupFD: true,
		CgroupFD:    int(cgFD.Fd()),
		// its own mount, process, network, IPC and hostname namespaces. The network namespace is why
		// every domain can use 127.0.0.1:8080 without collision or reach.
		Cloneflags:   syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS,
		Unshareflags: syscall.CLONE_NEWNS,
		Setpgid:      true,
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("starting domain: %w", err)
	}
	d.cmd = cmd
	go func() { cmd.Wait() }() // reaped here; the domain ends when domexec does

	ln, lerr := vsock.Listen(d.Port)
	if err = lerr; err != nil {
		return fmt.Errorf("vsock port %d: %w", d.Port, err)
	}
	d.ln = ln
	// The monitor relays the domain's one port. TLS ends INSIDE the domain, so what passes here is
	// ciphertext: the monitor moves the bytes without being able to read them.
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go relay(c, filepath.Join(d.dir, "run", "front.sock"))
		}
	}()
	return nil
}

func relay(c net.Conn, frontSock string) {
	defer c.Close()
	up, err := net.DialTimeout("unix", frontSock, 5*time.Second)
	if err != nil {
		return // the domain is not serving (yet): the client sees a closed connection and retries
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
		{"memory.max", strconv.Itoa(d.MemMiB<<20) + ""},
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
	if d != nil {
		delete(m.doms, id)
		delete(m.byUID, d.UID)
	}
	m.mu.Unlock()
	if d == nil {
		return fmt.Errorf("no domain %d", id)
	}
	m.teardown(d)
	fmt.Printf("MON domain %d destroyed\n", d.ID)
	return nil
}

func (m *monitor) teardown(d *domain) {
	if d.ln != nil {
		d.ln.Close()
	}
	if d.cmd != nil && d.cmd.Process != nil {
		syscall.Kill(-d.cmd.Process.Pid, syscall.SIGKILL)
		d.cmd.Process.Kill()
		time.Sleep(100 * time.Millisecond) // let the kernel tear the namespaces down before unmounting
	}
	syscall.Unmount(filepath.Join(d.dir, "run", "monitor.sock"), syscall.MNT_DETACH)
	syscall.Unmount(filepath.Join(d.dir, "plat"), syscall.MNT_DETACH)
	os.RemoveAll(d.dir)
	os.Remove(d.cgroup)
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
		go m.oneReport(c)
	}
}

func (m *monitor) oneReport(c net.Conn) {
	defer c.Close()
	enc := json.NewEncoder(c)
	c.SetDeadline(time.Now().Add(30 * time.Second))
	// Read the request first, then decide. Answering before the peer has finished writing resets the
	// connection, and a caller that is refused should receive the refusal rather than a broken pipe.
	var req reportReq
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&req); err != nil {
		enc.Encode(map[string]string{"error": "bad request: " + err.Error()})
		return
	}
	uid, err := peerUID(c)
	if err != nil {
		enc.Encode(map[string]string{"error": "no peer credentials: " + err.Error()})
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
		return
	}
	bind, err := hex.DecodeString(req.Bind)
	if err != nil || len(bind) != 32 {
		enc.Encode(map[string]string{"error": "bind must be 32 bytes of hex"})
		return
	}
	if !m.snp {
		enc.Encode(map[string]string{"error": "no hardware report on this tier"})
		return
	}
	rd := make([]byte, 64)
	copy(rd, bind)              // [0:32] the domain's own key, bound to the verifier's challenge
	copy(rd[32:], d.appHash[:]) // [32:64] the app THIS monitor loaded for THIS domain
	rep, certs, err := m.tsmReport(rd)
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
