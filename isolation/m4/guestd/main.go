package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/release"
	"enclave.host/isolation/m2/vsock"
)

// realLauncher drives the M4a scripts the hardware suite scores (isolation/m4/test-m4.sh), not a reimplementation
// of them: build-app-guest.sh builds and predicts, m2/run-domain.sh boots and stops, m2/fwd forwards, and
// m2/client.mjs is the judge.
type realLauncher struct {
	m4, m2, fwd                                   string
	vcek, chain, product, minTCB, runtimeIdentity string
	env                                           []string
	bootWait                                      time.Duration // until "DOM serving"; 0 = 180 s (release mode waits for a ticket too)
}

func (l *realLauncher) run(ctx context.Context, dir, logName string, name string, args ...string) (string, error) {
	return l.runEnv(ctx, dir, logName, nil, name, args...)
}

func (l *realLauncher) runEnv(ctx context.Context, dir, logName string, extra []string, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(append([]string{}, l.env...), extra...)
	out, err := cmd.CombinedOutput()
	_ = os.WriteFile(filepath.Join(dir, logName), out, 0o600)
	return string(out), err
}

var predicted = regexp.MustCompile(`(?m)^predicted measurement: ([0-9a-fA-F]{96})\s*$`)

func (l *realLauncher) Build(ctx context.Context, bundle, workdir string, vcpus int) (string, string, error) {
	image := filepath.Join(workdir, "guest.cpio.gz")
	out, err := l.run(ctx, workdir, "build.txt", "sh", filepath.Join(l.m4, "build-app-guest.sh"), bundle, image,
		strconv.Itoa(vcpus))
	if err != nil {
		return "", "", fmt.Errorf("build-app-guest.sh: %v", err)
	}
	m := predicted.FindStringSubmatch(out)
	if m == nil {
		return "", "", errors.New("build-app-guest.sh printed no predicted measurement")
	}
	return image, strings.ToLower(m[1]), nil
}

var hostLine = regexp.MustCompile(`unit=(\S+) cid=(\d+)`)

func (l *realLauncher) Start(ctx context.Context, image, tag, workdir string, vcpus, memMiB, cpuPct int, hostData string, cid uint32) (string, error) {
	out, err := l.runEnv(ctx, workdir, tag+".host", []string{"HOST_DATA=" + hostData, "GUEST_CID=" + strconv.FormatUint(uint64(cid), 10)},
		"sh", filepath.Join(l.m2, "run-domain.sh"),
		"start", image, "snp", tag, workdir, strconv.Itoa(vcpus), strconv.Itoa(memMiB), strconv.Itoa(cpuPct))
	m := hostLine.FindStringSubmatch(out)
	if err != nil || m == nil {
		return "", fmt.Errorf("run-domain.sh start: %v %s", err, strings.TrimSpace(out))
	}
	unit := m[1]
	if got, _ := strconv.ParseUint(m[2], 10, 32); uint32(got) != cid {
		// the ticket service and the egress server know this guest only by the CID guestd chose
		return unit, fmt.Errorf("run-domain.sh launched the guest with CID %d, not the %d guestd chose", got, cid)
	}
	serial := filepath.Join(workdir, tag+".serial")
	wait := l.bootWait
	if wait <= 0 {
		wait = 180 * time.Second
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		b, _ := os.ReadFile(serial)
		if bytes.Contains(bytes.ReplaceAll(b, []byte{0}, nil), []byte("DOM serving")) {
			return unit, nil
		}
		if len(b) > 0 && !l.Alive(unit) {
			return unit, errors.New("the guest ended during boot (see its serial log)")
		}
		time.Sleep(500 * time.Millisecond)
	}
	return unit, fmt.Errorf("the guest's front never served within %s", wait)
}

var fwdLine = regexp.MustCompile(`^FWD listening 127\.0\.0\.1:(\d+) `)

func (l *realLauncher) Forward(ctx context.Context, cid uint32, workdir string) (int, func(), error) {
	cmd := exec.Command(l.fwd, "-cid", strconv.FormatUint(uint64(cid), 10))
	out, err := cmd.StdoutPipe()
	if err != nil {
		return 0, nil, err
	}
	if err := cmd.Start(); err != nil {
		return 0, nil, err
	}
	stop := func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }
	lines := make(chan string, 16)
	go func() {
		f, _ := os.Create(filepath.Join(workdir, "fwd.log"))
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			if f != nil {
				fmt.Fprintln(f, sc.Text())
			}
			select {
			case lines <- sc.Text():
			default:
			}
		}
		if f != nil {
			f.Close()
		}
	}()
	timeout := time.After(10 * time.Second)
	for {
		select {
		case s := <-lines:
			if m := fwdLine.FindStringSubmatch(s); m != nil {
				p, _ := strconv.Atoi(m[1])
				return p, stop, nil
			}
		case <-timeout:
			stop()
			return 0, nil, errors.New("the forwarder reported no port")
		case <-ctx.Done():
			stop()
			return 0, nil, ctx.Err()
		}
	}
}

// verifyArgs is the judge's command line. With a deployment bound, guestd's own verifier requires the report to carry
// it (--host-data): a guest that came up without its deployment id in HOST_DATA is never reported running for it.
func (l *realLauncher) verifyArgs(port int, measurement, appID, hostData, workdir string) []string {
	args := []string{filepath.Join(l.m2, "client.mjs"),
		"https://127.0.0.1:" + strconv.Itoa(port), "--measurement", measurement, "--app-sha", appID, "--no-kds",
		"--vcek", l.vcek, "--amd-chain", l.product + "=" + l.chain, "--min-tcb", "@" + l.minTCB,
		"--runtime", l.runtimeIdentity, "--save", filepath.Join(workdir, "doc.json")}
	if hostData != "" {
		args = append(args, "--host-data", hostData)
	}
	return args
}

func (l *realLauncher) Verify(ctx context.Context, port int, measurement, appID, hostData, workdir string) (string, string, error) {
	out, _ := l.run(ctx, workdir, "verify.txt", "node", l.verifyArgs(port, measurement, appID, hostData, workdir)...)
	verdict, keySha := "", ""
	for _, ln := range strings.Split(out, "\n") {
		if strings.HasPrefix(ln, "VERDICT ") && verdict == "" {
			verdict = ln
		}
		if strings.HasPrefix(ln, "RESULT spki_sha256=") && keySha == "" {
			keySha = strings.TrimPrefix(ln, "RESULT spki_sha256=")
		}
	}
	if strings.HasPrefix(verdict, "VERDICT attested") && strings.Contains(out, "\nRESULT gate=open") {
		return "attested", keySha, nil
	}
	if verdict == "" {
		verdict = "no verdict"
	}
	return "", "", errors.New(verdict)
}

func (l *realLauncher) Alive(unit string) bool {
	return unit != "" && exec.Command("systemctl", "--user", "is-active", "--quiet", unit).Run() == nil
}

func (l *realLauncher) Stop(tag, workdir string) error {
	_, err := l.run(context.Background(), workdir, tag+".stop", "sh", filepath.Join(l.m2, "run-domain.sh"), "stop",
		tag, workdir)
	return err
}

// Sweep stops the guest units a previous guestd left that were NOT adopted (keep): since F7 a guestd restart adopts
// every guest that verifies again as itself (persist.go), and only the rest end here. The supervisor re-provisions
// what it still holds a lease for.
func (l *realLauncher) Sweep(keep map[string]bool) ([]string, error) {
	out, err := exec.Command("systemctl", "--user", "list-units", "--plain", "--no-legend", "--all", "m2-gd*").Output()
	if err != nil {
		return nil, err
	}
	var stopped []string
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.Fields(ln)
		if len(f) == 0 || !strings.HasPrefix(f[0], "m2-gd") || keep[strings.TrimSuffix(f[0], ".service")] || keep[f[0]] {
			continue
		}
		if exec.Command("systemctl", "--user", "stop", f[0]).Run() == nil {
			stopped = append(stopped, f[0])
		}
	}
	return stopped, nil
}

// pyFetcher fetches through the platform's own CAR verifier (wasm/ipfs_fetch.py, via fetch-cid.py): the bytes a
// CID names, verified against it, or an error - never unverified bytes.
type pyFetcher struct{ script, repo, gateway, tmp string }

func (p *pyFetcher) Fetch(ctx context.Context, cid string, max int) ([]byte, error) {
	f, err := os.CreateTemp(p.tmp, "fetch-*")
	if err != nil {
		return nil, err
	}
	out := f.Name()
	f.Close()
	defer os.Remove(out)
	var stderr bytes.Buffer
	cmd := exec.CommandContext(ctx, "python3", p.script, p.repo, cid, out, strconv.Itoa(max), p.gateway)
	cmd.Stderr = &stderr
	so, err := cmd.Output()
	if err != nil {
		return nil, errors.New(strings.TrimSpace(stderr.String()))
	}
	b, err := os.ReadFile(out)
	if err != nil {
		return nil, err
	}
	// the verifier printed the digest of what it wrote; what was read back must be that
	if want := strings.Fields(string(so)); len(want) != 3 || want[0] != "ok" || want[2] != componentSha(b) {
		return nil, fmt.Errorf("the fetcher's report %q does not describe the bytes it wrote", strings.TrimSpace(string(so)))
	}
	return b, nil
}

func sha256File(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:]), nil
}

func main() {
	home, _ := os.UserHomeDir()
	listen := flag.String("listen", "127.0.0.1:8095", "loopback address to serve the /vms contract on")
	root := flag.String("root", filepath.Join(home, "enclave-bench", "guestd"), "per-guest workdirs live here and only here")
	iso := flag.String("isolation", "", "the repository's isolation/ directory (required)")
	ovmf := flag.String("ovmf", filepath.Join(home, ".cache/enclave-isolation/fwbuild/OVMF.amdsev.fd"), "guest firmware; must be pinned as VERIFYING")
	vcek := flag.String("vcek", filepath.Join(home, ".cache/enclave-isolation/m3-clean/vcek.der"), "this chip's VCEK")
	product := flag.String("product", "Turin", "AMD product name for the chain")
	chain := flag.String("chain", "", "AMD cert chain PEM (default: test/fixtures/amd/<product>-cert_chain.pem)")
	minTCB := flag.String("min-tcb", filepath.Join(home, ".cache/enclave-isolation/m3-clean/min-tcb.json"), "TCB floor JSON")
	gateway := flag.String("gateway", "https://ipfs.enclave.host", "IPFS gateway for catalog components (untrusted: every block is verified)")
	authKey := flag.String("auth-key", "", "pairing key file (guestd-control/1); without it guestd runs its unauthenticated loopback-only lab mode")
	dataListen := flag.String("data-listen", "", "loopback address for the ciphertext data plane (enclave-splice/1, datapath.go); empty = none")
	dataIdle := flag.Duration("data-idle", 180*time.Second, "close a spliced connection after this long with no bytes in either direction")
	genKeyFile := flag.String("gen-key", "", "write a NEW pairing key to this file (mode 0600, never overwritten), print its kid, and exit")
	guestMem := flag.Int("guest-mem-mib", 0, "host RAM (MiB) set aside for guests: the guest pool's memory budget; unset = every create is refused (pool.go)")
	guestCPUs := flag.Int("guest-cpus", 0, "host cores set aside for guests: the guest pool's CPU budget, against each guest's CPUQuota; unset = every create is refused")
	legacyIso := flag.String("legacy-isolation", "", "with -release: the PREVIOUS isolation/ tree, to build the deployment guests the supervisor does not mark release (their image unchanged); empty = such a deployment is refused")
	releaseOn := flag.Bool("release", false, "deliver attested-release tickets (vsock host port 9444) and serve deployment guests' egress (9443) (release.go); off = neither, and /health says supports.release=false")
	flag.Parse()
	if *guestMem < 0 || *guestCPUs < 0 || (*guestMem > 0) != (*guestCPUs > 0) {
		log.Fatal("-guest-mem-mib and -guest-cpus are set together, both positive (or neither: then every create is refused)")
	}

	if *genKeyFile != "" {
		kid, err := genKey(*genKeyFile)
		if err != nil {
			log.Fatalf("gen-key: %v", err)
		}
		fmt.Printf("kid %s written to %s (deliver the same file to the paired supervisor)\n", kid, *genKeyFile)
		return
	}

	// DISABLED unless asked for, by name. Nothing in production sets this.
	if os.Getenv("GUESTD_ENABLE") != "1" {
		log.Fatal("guestd is disabled: set GUESTD_ENABLE=1 to run it (a lab/staging backend, not a production service)")
	}
	if *iso == "" {
		log.Fatal("-isolation <repo>/isolation is required")
	}
	host, _, err := net.SplitHostPort(*listen)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatalf("-listen must be a loopback address: the /vms contract has no authentication of its own")
	}
	if *dataListen != "" {
		if h, _, err := net.SplitHostPort(*dataListen); err != nil || !net.ParseIP(h).IsLoopback() {
			log.Fatalf("-data-listen must be a loopback address: a bridge, not this process, decides who reaches it")
		}
	}
	if *chain == "" {
		*chain = filepath.Join(*iso, "..", "test/fixtures/amd", *product+"-cert_chain.pem")
	}
	// A measured table over a firmware that does not verify it proves nothing, and every structural check still
	// passes (isolation/m4/verifying-firmware.txt). So the firmware is pinned by digest, or guestd does not start.
	fw, err := sha256File(*ovmf)
	if err != nil {
		log.Fatalf("firmware: %v", err)
	}
	pins, err := os.ReadFile(filepath.Join(*iso, "m4", "verifying-firmware.txt"))
	if err != nil || !regexp.MustCompile(`(?m)^`+fw+`\s`).Match(pins) {
		log.Fatalf("firmware %s (sha256 %s) is not pinned as VERIFYING in m4/verifying-firmware.txt", *ovmf, fw)
	}
	for _, f := range []string{*vcek, *chain, *minTCB} {
		if _, err := os.Stat(f); err != nil {
			log.Fatalf("verification input missing: %v", err)
		}
	}
	if err := os.MkdirAll(filepath.Join(*root, "bin"), 0o700); err != nil {
		log.Fatal(err)
	}
	env := append(os.Environ(), "OVMF="+*ovmf)
	fwd := filepath.Join(*root, "bin", "fwd")
	build := exec.Command("go", "build", "-trimpath", "-o", fwd, "./fwd")
	build.Dir = filepath.Join(*iso, "m2")
	build.Env = append(env, "CGO_ENABLED=0")
	if out, err := build.CombinedOutput(); err != nil {
		log.Fatalf("building m2/fwd: %v %s", err, out)
	}
	wt, err := exec.LookPath("wasmtime")
	if err != nil {
		log.Fatal("no wasmtime on PATH: the guest image carries the host's runtime")
	}
	rid := filepath.Join(*root, "expected-runtime.json")
	ridOut, err := exec.Command(filepath.Join(*iso, "contract", "runtime-identity.sh"), wt).Output()
	if err != nil || os.WriteFile(rid, ridOut, 0o600) != nil {
		log.Fatalf("runtime identity: %v", err)
	}
	l := &realLauncher{m4: filepath.Join(*iso, "m4"), m2: filepath.Join(*iso, "m2"), fwd: fwd, vcek: *vcek,
		chain: *chain, product: *product, minTCB: *minTCB, runtimeIdentity: rid, env: env}
	s := newServer(l, *root)
	s.Budget = poolBudget{MemMiB: *guestMem, CPUPct: *guestCPUs * 100}
	// F7: a previous guestd's guests are ADOPTED when they verify again as the same guest (persist.go); every other
	// guest unit is stopped and every other workdir scrubbed, as a boot sweep always did.
	actx, acancel := context.WithTimeout(context.Background(), 10*time.Minute)
	keep, adopted, dropped := s.adoptOnBoot(actx)
	acancel()
	if len(adopted) > 0 {
		log.Printf("adopted %d guest(s) a previous guestd left, each verified again as the same guest: %v", len(adopted), adopted)
	}
	for _, d := range dropped {
		log.Printf("not adopted, ended: %s", d)
	}
	s.logPoolAfterRecovery() // adopted guests count against the budget, and may exceed it (pool.go: overcommitted)
	if stopped, err := l.Sweep(keep); err != nil {
		log.Fatalf("sweeping a previous run's guests: %v", err)
	} else if len(stopped) > 0 {
		log.Printf("stopped %d guest unit(s) with no adoptable record: %v", len(stopped), stopped)
	}
	s.Firmware = map[string]any{"path": *ovmf, "sha256": fw, "pinnedVerifying": true}
	// The catalog store, and the RuntimeID a derivation record must be pinned to: this host's, computed from the
	// same identity file the judge is given, by the contract's own function.
	var ident contract.RuntimeIdentity
	if err := json.Unmarshal(ridOut, &ident); err != nil {
		log.Fatalf("runtime identity: %v", err)
	}
	rtID, err := contract.RuntimeID(ident)
	if err != nil {
		log.Fatalf("runtime identity: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(*root, "store", "tmp"), 0o700); err != nil {
		log.Fatal(err)
	}
	st, err := newStore(filepath.Join(*root, "store"), &pyFetcher{script: filepath.Join(*iso, "m4", "guestd", "fetch-cid.py"),
		repo: filepath.Join(*iso, ".."), gateway: *gateway, tmp: filepath.Join(*root, "store", "tmp")}, hex.EncodeToString(rtID[:]))
	if err != nil {
		log.Fatal(err)
	}
	s.Store = st
	s.RuntimeID = hex.EncodeToString(rtID[:])
	if *dataListen != "" {
		s.Data = newDataPlane(s)
		s.Data.Idle = *dataIdle
		dl, err := net.Listen("tcp", *dataListen)
		if err != nil {
			log.Fatalf("data plane: %v", err)
		}
		log.Printf("data plane (enclave-splice/1) on %s: ciphertext only, admitted per verified instance identity", dl.Addr())
		go func() { log.Fatal(s.Data.Serve(dl)) }()
	}
	if *releaseOn {
		// The attested release (release.go): tickets to the ONE guest guestd launched for each deployment, and egress
		// to the origins that guest's own allowlist names. Both listen on vsock, where the peer's CID - set by this
		// host for its guests, and unforgeable by another VM - is the only identity either service takes.
		s.Release = true
		l.bootWait = 10 * time.Minute // a deployment guest waits for its ticket before its front serves
		if *legacyIso != "" {
			if _, err := os.Stat(filepath.Join(*legacyIso, "m4", "build-app-guest.sh")); err != nil {
				log.Fatalf("-legacy-isolation: %v", err)
			}
			// the legacy tree BUILDS the image (its front, its template); this tree's run-domain.sh boots it, with the
			// same kernel, firmware and command line (m1/domain.env), and a CID guestd chose
			legacy := *l
			legacy.m4 = filepath.Join(*legacyIso, "m4")
			legacy.bootWait = 0
			s.Legacy = &legacy
			log.Printf("non-release deployment guests are built from %s", *legacyIso)
		}
		tl, err := vsock.Listen(release.TicketPort)
		if err != nil {
			log.Fatalf("release tickets: %v", err)
		}
		go func() {
			log.Fatal(s.serveTickets(context.Background(), tl, vsockCID, log.New(os.Stderr, "release: ", log.LstdFlags)))
		}()
		el, err := vsock.Listen(egressPort)
		if err != nil {
			log.Fatalf("egress: %v", err)
		}
		es := &egress.Server{
			Dialer: &egress.Dialer{Resolver: net.DefaultResolver, Own: hostAddrs, MaxConcurrent: 32, MaxPerMinute: 600},
			CIDOf:  vsockCID, Admit: s.admitCID, Log: log.New(os.Stderr, "egress: ", log.LstdFlags),
		}
		go func() { log.Fatal(es.Serve(context.Background(), el)) }()
		log.Printf("attested release ON: tickets on vsock %d, egress on vsock %d (guests guestd launched only)", release.TicketPort, egressPort)
	}
	if *authKey != "" {
		k, err := loadKey(*authKey)
		if err != nil {
			log.Fatalf("auth-key: %v", err)
		}
		s.Auth = newControlAuth(k, time.Now)
		log.Printf("guestd-control/1: kid %s, instance %s; every request but the handshake is authenticated", s.Auth.kid, s.Auth.instance)
	} else {
		log.Print("NO pairing key: unauthenticated LAB mode, loopback only; /control/* refuses")
	}
	go func() {
		for range time.Tick(5 * time.Second) {
			s.tick()
			if s.Auth != nil {
				s.Auth.sweep()
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sig
		// F7: guests OUTLIVE this process. They run in their own user units; the next guestd adopts each that verifies
		// again as itself and ends the rest (persist.go). Ending them here would turn every guestd restart - a deploy
		// - into a relaunch of every app with a new key (seen on the production canary, 2026-09-24 20:43Z).
		// To end every guest deliberately: systemctl --user stop 'm2-gd*'.
		log.Print("exiting; guests keep running for the next guestd to adopt (end them with: systemctl --user stop 'm2-gd*')")
		os.Exit(0)
	}()
	log.Printf("guestd serving the /vms contract on %s (firmware %s, root %s)", *listen, fw[:16], *root)
	log.Fatal(http.ListenAndServe(*listen, s))
}

// shutdown ends every guest through its lifecycle, the same single reclamation any other end takes.
func (s *server) shutdown() {
	s.mu.Lock()
	var all []*vm
	for _, v := range s.vms {
		all = append(all, v)
	}
	s.mu.Unlock()
	for _, v := range all {
		if v.lc.RequestEnd("guestd shutting down") {
			v.lc.Reclaim(func() { s.reclaim(v) })
		}
	}
	s.launching.Wait()
}

// vsockCID is a vsock stream's peer CID: for a guest this host launched, the CID guestd chose for it. Anything that is
// not a vsock stream has none (0), which neither release service admits.
func vsockCID(c net.Conn) uint32 {
	if a, ok := c.RemoteAddr().(vsock.Addr); ok {
		return a.CID
	}
	return 0
}

// hostAddrs is this host's own addresses, read at each dial: the egress dialer refuses them as destinations.
func hostAddrs() []netip.Addr {
	as, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var out []netip.Addr
	for _, a := range as {
		if p, err := netip.ParsePrefix(a.String()); err == nil {
			out = append(out, p.Addr().Unmap())
		}
	}
	return out
}
