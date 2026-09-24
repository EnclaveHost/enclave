package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// realLauncher drives the M4a scripts the hardware suite scores (isolation/m4/test-m4.sh), not a reimplementation
// of them: build-app-guest.sh builds and predicts, m2/run-domain.sh boots and stops, m2/fwd forwards, and
// m2/client.mjs is the judge.
type realLauncher struct {
	m4, m2, fwd                                   string
	vcek, chain, product, minTCB, runtimeIdentity string
	env                                           []string
}

func (l *realLauncher) run(ctx context.Context, dir, logName string, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = l.env
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

func (l *realLauncher) Start(ctx context.Context, image, tag, workdir string, vcpus, memMiB, cpuPct int) (string, uint32, error) {
	out, err := l.run(ctx, workdir, tag+".host", "sh", filepath.Join(l.m2, "run-domain.sh"), "start", image, "snp",
		tag, workdir, strconv.Itoa(vcpus), strconv.Itoa(memMiB), strconv.Itoa(cpuPct))
	m := hostLine.FindStringSubmatch(out)
	if err != nil || m == nil {
		return "", 0, fmt.Errorf("run-domain.sh start: %v %s", err, strings.TrimSpace(out))
	}
	unit := m[1]
	cid, _ := strconv.ParseUint(m[2], 10, 32)
	serial := filepath.Join(workdir, tag+".serial")
	deadline := time.Now().Add(180 * time.Second)
	for time.Now().Before(deadline) && ctx.Err() == nil {
		b, _ := os.ReadFile(serial)
		if bytes.Contains(bytes.ReplaceAll(b, []byte{0}, nil), []byte("DOM serving")) {
			return unit, uint32(cid), nil
		}
		if len(b) > 0 && !l.Alive(unit) {
			return unit, 0, errors.New("the guest ended during boot (see its serial log)")
		}
		time.Sleep(500 * time.Millisecond)
	}
	return unit, 0, errors.New("the guest's front never served within 180s")
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

func (l *realLauncher) Verify(ctx context.Context, port int, measurement, appID, workdir string) (string, error) {
	out, _ := l.run(ctx, workdir, "verify.txt", "node", filepath.Join(l.m2, "client.mjs"),
		"https://127.0.0.1:"+strconv.Itoa(port), "--measurement", measurement, "--app-sha", appID, "--no-kds",
		"--vcek", l.vcek, "--amd-chain", l.product+"="+l.chain, "--min-tcb", "@"+l.minTCB,
		"--runtime", l.runtimeIdentity, "--save", filepath.Join(workdir, "doc.json"))
	verdict := ""
	for _, ln := range strings.Split(out, "\n") {
		if strings.HasPrefix(ln, "VERDICT ") {
			verdict = ln
			break
		}
	}
	if strings.HasPrefix(verdict, "VERDICT attested") && strings.Contains(out, "\nRESULT gate=open") {
		return "attested", nil
	}
	if verdict == "" {
		verdict = "no verdict"
	}
	return "", errors.New(verdict)
}

func (l *realLauncher) Alive(unit string) bool {
	return unit != "" && exec.Command("systemctl", "--user", "is-active", "--quiet", unit).Run() == nil
}

func (l *realLauncher) Stop(tag, workdir string) error {
	_, err := l.run(context.Background(), workdir, tag+".stop", "sh", filepath.Join(l.m2, "run-domain.sh"), "stop",
		tag, workdir)
	return err
}

// Sweep stops the guests a previous guestd left: every user unit run-domain.sh named for a guestd tag. Guests do
// not outlive the manager that launched them, the same rule the wasm-manager keeps for its processes - the
// supervisor re-provisions what it still holds a lease for.
func (l *realLauncher) Sweep() ([]string, error) {
	out, err := exec.Command("systemctl", "--user", "list-units", "--plain", "--no-legend", "--all", "m2-gd*").Output()
	if err != nil {
		return nil, err
	}
	var stopped []string
	for _, ln := range strings.Split(string(out), "\n") {
		f := strings.Fields(ln)
		if len(f) == 0 || !strings.HasPrefix(f[0], "m2-gd") {
			continue
		}
		if exec.Command("systemctl", "--user", "stop", f[0]).Run() == nil {
			stopped = append(stopped, f[0])
		}
	}
	return stopped, nil
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
	flag.Parse()

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
	if stopped, err := l.Sweep(); err != nil {
		log.Fatalf("sweeping a previous run's guests: %v", err)
	} else if len(stopped) > 0 {
		log.Printf("stopped %d guest(s) a previous guestd left: %v", len(stopped), stopped)
	}
	stale, _ := filepath.Glob(filepath.Join(*root, "gd*"))
	for _, d := range stale {
		_ = os.RemoveAll(d)
	}
	s := newServer(l, *root)
	s.Firmware = map[string]any{"path": *ovmf, "sha256": fw, "pinnedVerifying": true}
	go func() {
		for range time.Tick(5 * time.Second) {
			s.tick()
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sig
		log.Print("shutting down: every guest ends with its manager")
		s.shutdown()
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
