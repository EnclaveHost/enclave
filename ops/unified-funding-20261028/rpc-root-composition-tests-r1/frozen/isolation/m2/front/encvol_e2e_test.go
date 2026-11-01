package main

// Encrypted volumes end to end, through the CHANGED implementation at every hop and fixtures only at the edges:
//
//   owner CLI (scripts/enclave-encvol.sh: message, derive, seal-creds, push --sig, push --plain; the real pinned rclone)
//     -> S3 fixture (`rclone serve s3`, TLS for s3.fixture.test from a test CA)
//   guest: this front's encPrepare/encStart (plane, staging, policy) and handToInitEnc
//     -> init's REAL trailer parser and app argv (dominit.c via testdata/encvol-init-harness.c, ENC_ROOT = the test root)
//     -> the REAL pinned runtime (wasmtime 48.0.1 from a CPU release template) serving the REAL encrypted-volumes app
//        with the --dir live preopens and ENCLAVE_ENC* environment init built
//     -> the app's /api/* proxy to the plane on loopback; the plane's engine
//     -> the guest's REAL egress forwarder (egress.Forwarder) -> the host's REAL egress server and dialer (egress.Server:
//        name resolution judged public, private/metadata answers refused), whose loopback SOCKS entry is the one test
//        stand-in for the internet (it carries a judged public label address to the fixture)
//   owner browser: the wallet section of the page the app itself serves (testdata/encvol-owner.mjs), wallet stubbed
//   with a signature from a FIXTURE key (Anvil's published test account #0).
//
// Covered: wallet + password-free unlock via the credsEnvelope, wrong key, malformed and wrong-wallet envelopes,
// plain and readOnly volumes, the transfer cap and the audit kill, push-back and an independent client pull, lock,
// endpoint loss, a FRESH guest on another "host" recovering the same ciphertext from an independent endpoint after the
// first guest and its endpoint are gone, SSRF refusals (guest parser and host dialer), and leak scans.
//
// Inputs (all required when ENCVOL_E2E=1; the test is skipped otherwise):
//   ENCVOL_RCLONE  the pinned rclone v1.67.0     ENCVOL_RT   a template's rt/ (ld-linux, libs, wasmtime)
//   ENCVOL_APP     encrypted_volumes.wasm        ENCVOL_CLI  scripts/enclave-encvol.sh
//   cast, node, gcc on PATH

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/m2/egress"
	"enclave.host/isolation/m2/encvol"
)

const (
	e2eFixtureKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" // Anvil's published account #0
	e2eOtherKey   = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" // Anvil's published account #1
	e2eAK, e2eSK  = "AKIAE2EFIXTURE00001", "e2e-fixture-secret-not-real-0001"
	s3Name        = "s3.fixture.test"
)

type e2eIn struct{ rclone, rt, app, cli, cast, node, gcc, m2 string }

func e2eInputs(t *testing.T) e2eIn {
	if os.Getenv("ENCVOL_E2E") != "1" {
		t.Skip("ENCVOL_E2E=1 runs the encrypted-volume end-to-end test")
	}
	in := e2eIn{rclone: os.Getenv("ENCVOL_RCLONE"), rt: os.Getenv("ENCVOL_RT"), app: os.Getenv("ENCVOL_APP"), cli: os.Getenv("ENCVOL_CLI")}
	for _, p := range []string{in.rclone, in.rt + "/wasmtime", in.rt + "/ld-linux-x86-64.so.2", in.app, in.cli} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("ENCVOL_E2E input missing: %v", err)
		}
	}
	var err error
	for _, b := range []struct {
		dst  *string
		name string
	}{{&in.cast, "cast"}, {&in.node, "node"}, {&in.gcc, "gcc"}} {
		if *b.dst, err = exec.LookPath(b.name); err != nil {
			t.Fatalf("ENCVOL_E2E needs %s: %v", b.name, err)
		}
	}
	in.m2, _ = filepath.Abs("..")
	return in
}

// ---- fixtures at the edges ----------------------------------------------------------------------------------------

type tlsFixture struct{ ca, cert, key string }

func makeTLS(t *testing.T, dir string) (tlsFixture, *x509.CertPool) {
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caT := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "encvol e2e fixture CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign}
	caDER, err := x509.CreateCertificate(rand.Reader, caT, caT, &caKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	ca, _ := x509.ParseCertificate(caDER)
	leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	leafT := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: s3Name}, DNSNames: []string{s3Name},
		IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafT, ca, &leafKey.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	kb, _ := x509.MarshalECPrivateKey(leafKey)
	f := tlsFixture{filepath.Join(dir, "ca.pem"), filepath.Join(dir, "cert.pem"), filepath.Join(dir, "key.pem")}
	os.WriteFile(f.ca, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0o644)
	os.WriteFile(f.cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER}), 0o644)
	os.WriteFile(f.key, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kb}), 0o600)
	pool := x509.NewCertPool()
	pool.AddCert(ca)
	return f, pool
}

func freeAddr(t *testing.T) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().String()
}

type s3Fixture struct {
	cmd  *exec.Cmd
	addr string
	dir  string
}

func startS3(t *testing.T, in e2eIn, dir string, tf tlsFixture) *s3Fixture {
	s := &s3Fixture{addr: freeAddr(t), dir: dir}
	s.cmd = exec.Command(in.rclone, "serve", "s3", dir, "--addr", s.addr, "--cert", tf.cert, "--key", tf.key,
		"--auth-key", e2eAK+","+e2eSK, "--log-level", "ERROR")
	s.cmd.Env = []string{"RCLONE_CONFIG=/dev/null", "HOME=" + t.TempDir()}
	if err := s.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.stop)
	for i := 0; i < 200; i++ {
		if c, err := net.Dial("tcp", s.addr); err == nil {
			c.Close()
			return s
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("rclone serve s3 did not start")
	return nil
}

func (s *s3Fixture) stop() {
	if s.cmd != nil && s.cmd.Process != nil {
		s.cmd.Process.Kill()
		s.cmd.Wait()
		s.cmd = nil
	}
}

// internet is the host side's one stand-in: the egress dialer's loopback SOCKS entry. It is handed only addresses the
// REAL dialer already judged public, and carries the label address 9.9.9.9:443 to whichever S3 fixture is "live".
type internet struct {
	mu     sync.Mutex
	target string // the S3 fixture currently answering for s3.fixture.test; "" = unreachable
	addr   string
}

func startInternet(t *testing.T) *internet {
	n := &internet{}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	n.addr = l.Addr().String()
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go n.serve(c)
		}
	}()
	return n
}

func (n *internet) route(to string) { n.mu.Lock(); n.target = to; n.mu.Unlock() }

func (n *internet) serve(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)
	hdr := make([]byte, 2)
	if _, err := io.ReadFull(br, hdr); err != nil || hdr[0] != 5 {
		return
	}
	io.ReadFull(br, make([]byte, hdr[1]))
	c.Write([]byte{5, 0})
	req := make([]byte, 4)
	if _, err := io.ReadFull(br, req); err != nil || req[3] != 1 {
		return
	}
	ip := make([]byte, 4)
	io.ReadFull(br, ip)
	pb := make([]byte, 2)
	io.ReadFull(br, pb)
	n.mu.Lock()
	to := n.target
	n.mu.Unlock()
	if netip.AddrFrom4([4]byte(ip)) != netip.MustParseAddr("9.9.9.9") || binary.BigEndian.Uint16(pb) != 443 || to == "" {
		c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	up, err := net.Dial("tcp", to)
	if err != nil {
		c.Write([]byte{5, 5, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer up.Close()
	c.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	go io.Copy(up, br)
	io.Copy(c, up)
}

type fixedDNS map[string]string

func (d fixedDNS) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	if a, ok := d[host]; ok {
		return []netip.Addr{netip.MustParseAddr(a)}, nil
	}
	return nil, fmt.Errorf("no such host")
}

// e2eEgressHost is the host's REAL egress server: what a guest's forwarder reaches over vsock (TCP here).
type e2eEgressHost struct {
	addr string
	mu   sync.Mutex
	log  bytes.Buffer
}

func startHostEgress(t *testing.T, net_ *internet) *e2eEgressHost {
	h := &e2eEgressHost{}
	d := &egress.Dialer{Resolver: fixedDNS{s3Name: "9.9.9.9", "internal.fixture.test": "10.0.0.5", "meta.fixture.test": "169.254.169.254"},
		Own: func() []netip.Addr { return nil }, SOCKSProxy: net_.addr, MaxConcurrent: 32, MaxPerMinute: 10000}
	srv := &egress.Server{Dialer: d, CIDOf: func(net.Conn) uint32 { return 7 }, Admit: func(c uint32) bool { return c == 7 },
		Log: log.New(writerFn(func(p []byte) (int, error) { h.mu.Lock(); defer h.mu.Unlock(); return h.log.Write(p) }), "", 0)}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	h.addr = l.Addr().String()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.Serve(ctx, l)
	return h
}

type writerFn func([]byte) (int, error)

func (f writerFn) Write(p []byte) (int, error) { return f(p) }

// ---- the owner ------------------------------------------------------------------------------------------------------

type owner struct {
	t   *testing.T
	in  e2eIn
	tf  tlsFixture
	sig string
}

func (o *owner) cli(env []string, args ...string) (string, string) {
	o.t.Helper()
	cmd := exec.Command("bash", append([]string{o.in.cli}, args...)...)
	cmd.Env = append([]string{"PATH=" + filepath.Dir(o.in.rclone) + ":/usr/bin:/bin", "HOME=" + o.t.TempDir(),
		"RCLONE_CA_CERT=" + o.tf.ca}, env...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		o.t.Fatalf("enclave-encvol.sh %v: %v\n%s", args, err, errb.String())
	}
	return out.String(), errb.String()
}

func (o *owner) sign(key, msg string) string {
	o.t.Helper()
	out, err := exec.Command(o.in.cast, "wallet", "sign", "--private-key", key, msg).Output()
	if err != nil {
		o.t.Fatalf("cast wallet sign: %v", err)
	}
	return strings.TrimSpace(string(out))
}

// browser runs the app's own page script (testdata/encvol-owner.mjs).
func (o *owner) browser(appURL string, args ...string) map[string]any {
	o.t.Helper()
	out, err := exec.Command(o.in.node, append([]string{"testdata/encvol-owner.mjs", appURL}, args...)...).CombinedOutput()
	if err != nil {
		o.t.Fatalf("owner browser %v: %v\n%s", args[0], err, out)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		o.t.Fatalf("owner browser output: %s", out)
	}
	return m
}

// ---- a guest --------------------------------------------------------------------------------------------------------

type guest struct {
	t       *testing.T
	root    string
	started *encStarted
	app     *exec.Cmd
	url     string
	cancel  context.CancelFunc
	mu      sync.Mutex
	logs    []string
	kills   []string
	argv    []string
	appOut  bytes.Buffer
}

// launchGuest boots one guest's worth of the changed path for config cfg, with its host's egress server at hostAddr.
func launchGuest(t *testing.T, in e2eIn, cfg string, hostAddr string, roots *x509.CertPool) *guest {
	g := &guest{t: t, root: t.TempDir()}
	ctx, cancel := context.WithCancel(context.Background())
	g.cancel = cancel
	t.Cleanup(g.stop)
	logf := func(f string, a ...any) { g.mu.Lock(); g.logs = append(g.logs, fmt.Sprintf(f, a...)); g.mu.Unlock() }

	// the front: the config names volumes; their origins join the policy before the forwarders start
	host := &encvolHost{root: g.root, uid: -1, gid: -1, listen: "127.0.0.1:0", roots: roots,
		memMiB: func() (int, error) { return 512, nil }, // the guest's MemTotal: a version published with memMb 512
		kill: func(reason string) {
			g.mu.Lock()
			g.kills = append(g.kills, reason)
			g.mu.Unlock()
			if g.app != nil && g.app.Process != nil {
				g.app.Process.Kill() // killApp: every process of the app's uid
			}
		}}
	pol := &egress.Policy{}
	specs, err := encPrepare(cfg, pol, host)
	if err != nil {
		t.Fatalf("encPrepare: %v", err)
	}
	if len(pol.Origins) != 1 || pol.Origins[0].Host != s3Name {
		t.Fatalf("the S3 origin did not join the egress allowlist: %+v", pol.Origins)
	}
	port, _ := netip.ParseAddrPort(freeAddr(t))
	fwd := &egress.Forwarder{Policy: pol, Port: int(port.Port()), Upstream: func() (net.Conn, error) { return net.Dial("tcp", hostAddr) },
		Logf: logf}
	if err := fwd.Start(ctx); err != nil {
		t.Fatal(err)
	}
	// /etc/hosts as the guest has it: only the allowed names, each on its own forwarder
	hosts := map[string]string{}
	for _, line := range strings.Split(fwd.HostsFile(), "\n") {
		if f := strings.Fields(line); len(f) == 2 {
			hosts[f[1]] = f[0]
		}
	}
	host.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		h, p, _ := net.SplitHostPort(addr)
		if _, ok := hosts[h]; !ok || p != "443" {
			return nil, fmt.Errorf("lookup %s: no such host", h)
		}
		a, _ := fwd.Addr(h)
		return (&net.Dialer{}).DialContext(ctx, network, a.String())
	}
	var id [32]byte
	rand.Read(id[:])
	g.started, err = encStart(ctx, id, specs, host, logf)
	if err != nil {
		t.Fatalf("encStart: %v", err)
	}

	// init: the real trailer parser and argv builder, compiled with this guest's staging root
	harness := filepath.Join(t.TempDir(), "init-harness")
	if out, err := exec.Command(in.gcc, "-O1", "-w", "-I", in.m2, fmt.Sprintf(`-DENC_ROOT="%s"`, g.root), "-o", harness,
		"testdata/encvol-init-harness.c").CombinedOutput(); err != nil {
		t.Fatalf("init harness: %v\n%s", err, out)
	}
	r, w, _ := os.Pipe()
	go handToInitEnc(w, cfg, false, g.started.block)
	cmd := exec.Command(harness)
	cmd.Stdin = r
	var hout, herr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &hout, &herr
	if err := cmd.Run(); err != nil {
		t.Fatalf("init refused the front's message: %v %s", err, herr.String())
	}
	r.Close()
	parts := bytes.SplitN(hout.Bytes(), []byte{1, 0}, 2)
	split := func(b []byte) []string {
		var l []string
		for _, s := range bytes.Split(b, []byte{0}) {
			if len(s) > 0 {
				l = append(l, string(s))
			}
		}
		return l
	}
	argv, env := split(parts[0]), split(parts[1])
	g.argv = argv

	// the runtime: init's argv with the image's paths mapped to this host's copies
	addr := freeAddr(t)
	for i, a := range argv {
		switch a {
		case "/rt/ld-linux-x86-64.so.2":
			argv[i] = in.rt + "/ld-linux-x86-64.so.2"
		case "/rt":
			argv[i] = in.rt
		case "/rt/wasmtime":
			argv[i] = in.rt + "/wasmtime"
		case "127.0.0.1:8080":
			argv[i] = addr
		case "/app.wasm":
			argv[i] = in.app
		}
	}
	g.app = exec.Command(argv[0], argv[1:]...)
	g.app.Env = env
	g.app.Stdout, g.app.Stderr = &g.appOut, &g.appOut
	if err := g.app.Start(); err != nil {
		t.Fatal(err)
	}
	g.url = "http://" + addr
	for i := 0; i < 400; i++ {
		if resp, err := http.Get(g.url + "/ping"); err == nil {
			resp.Body.Close()
			return g
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("the app did not serve: %s", g.appOut.String())
	return nil
}

func (g *guest) stop() {
	if g.app != nil && g.app.Process != nil {
		g.app.Process.Kill()
		g.app.Wait()
	}
	if g.cancel != nil {
		g.cancel()
	}
}

func (g *guest) do(method, path string, body any) (int, map[string]any, []byte) {
	g.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, g.url+path, rd)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		g.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	json.Unmarshal(raw, &m)
	return resp.StatusCode, m, raw
}

// vol waits until volume name is neither syncing nor pushing, as the app's UI polls /api/status.
func (g *guest) vol(name string) map[string]any {
	g.t.Helper()
	for i := 0; i < 1200; i++ {
		_, st, raw := g.do("GET", "/api/status", nil)
		vols, _ := st["volumes"].([]any)
		for _, v := range vols {
			m := v.(map[string]any)
			if m["name"] == name && m["status"] != "syncing" && m["status"] != "pushing" {
				return m
			}
		}
		if vols == nil {
			g.t.Fatalf("status: %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
	g.t.Fatalf("volume %s never settled", name)
	return nil
}

func (g *guest) unlock(body map[string]any) map[string]any {
	g.t.Helper()
	if code, m, raw := g.do("POST", "/api/unlock", body); code != 202 {
		g.t.Fatalf("unlock %v: %d %v %s", body["name"], code, m, raw)
	}
	return g.vol(body["name"].(string))
}

func fileTree(t *testing.T, dir string) map[string]string {
	m := map[string]string{}
	filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if err == nil && fi.Mode().IsRegular() {
			rel, _ := filepath.Rel(dir, p)
			b, _ := os.ReadFile(p)
			m[filepath.ToSlash(rel)] = string(b)
		}
		return nil
	})
	return m
}

// ---- the test -------------------------------------------------------------------------------------------------------

func TestEncvolEndToEnd(t *testing.T) {
	in := e2eInputs(t)
	work := t.TempDir()
	tf, roots := makeTLS(t, work)
	net_ := startInternet(t)
	hostA := startHostEgress(t, net_)

	// the owner's bucket on endpoint A
	dataA := filepath.Join(work, "s3-a")
	os.MkdirAll(filepath.Join(dataA, "bkt"), 0o755)
	s3a := startS3(t, in, dataA, tf)
	net_.route(s3a.addr)

	o := &owner{t: t, in: in, tf: tf}
	msgOut, _ := o.cli(nil, "message", "docs")
	msg := strings.TrimSuffix(msgOut, "\n")
	o.sig = o.sign(e2eFixtureKey, msg)
	derived, _ := o.cli(nil, "derive", "--sig", o.sig)
	var cliPW, cliSalt string
	for _, l := range strings.Split(derived, "\n") {
		if v, ok := strings.CutPrefix(l, "export ENCVOL_PASSWORD="); ok {
			cliPW = v
		}
		if v, ok := strings.CutPrefix(l, "export ENCVOL_SALT="); ok {
			cliSalt = v
		}
	}
	s3env := []string{"AWS_ACCESS_KEY_ID=" + e2eAK, "AWS_SECRET_ACCESS_KEY=" + e2eSK}
	envelope, _ := o.cli(s3env, "seal-creds", "--sig", o.sig)
	envelope = strings.TrimSpace(envelope)

	ownerDir := filepath.Join(work, "docs")
	big := bytes.Repeat([]byte("Q"), 3<<20) // over the "tiny" view's 1 MiB cap
	for n, c := range map[string][]byte{"a.txt": []byte("owner secret alpha\n"), "dir/b.txt": []byte("owner secret beta\n"), "big.bin": big} {
		os.MkdirAll(filepath.Join(ownerDir, filepath.Dir(n)), 0o755)
		os.WriteFile(filepath.Join(ownerDir, n), c, 0o644)
	}
	_, pushNote := o.cli(s3env, "push", ownerDir, "--endpoint", "https://"+s3a.addr, "--bucket", "bkt", "--path", "vol", "--sig", o.sig, "--name", "docs")
	if !strings.Contains(pushNote, `"unlock": "wallet"`) {
		t.Fatalf("the CLI's snippet: %s", pushNote)
	}
	pubDir := filepath.Join(work, "pub")
	os.MkdirAll(pubDir, 0o755)
	os.WriteFile(filepath.Join(pubDir, "readme.txt"), []byte("public plain bytes\n"), 0o644)
	o.cli(s3env, "push", pubDir, "--plain", "--endpoint", "https://"+s3a.addr, "--bucket", "bkt", "--path", "pub", "--name", "pub")

	endpoint := "https://" + s3Name
	cfgDoc := map[string]any{"encVolumes": []any{
		map[string]any{"name": "docs", "endpoint": endpoint, "bucket": "bkt", "path": "vol", "unlock": "wallet", "credsEnvelope": envelope, "maxMb": 64},
		map[string]any{"name": "pub", "endpoint": endpoint, "bucket": "bkt", "path": "pub", "encrypted": false, "readOnly": true, "maxMb": 8},
		map[string]any{"name": "tiny", "endpoint": endpoint, "bucket": "bkt", "path": "vol", "keyId": "docs", "maxMb": 1},
	}}
	cfgB, _ := json.Marshal(cfgDoc)
	cfg := string(cfgB)

	// ---- guest A on host A
	ga := launchGuest(t, in, cfg, hostA.addr, roots)
	for _, want := range []string{"--dir", ga.root + "/docs::/enc/docs", ga.root + "/pub::/enc/pub", "ENCLAVE_ENC_TOKEN"} {
		if !hasArg(ga.argv, want) {
			t.Fatalf("init's app argv lacks %q: %v", want, ga.argv)
		}
	}
	pidA := ga.app.Process.Pid
	code, st, raw := ga.do("GET", "/api/status", nil)
	if code != 200 || strings.Contains(string(raw), ga.started.svc.Token()) {
		t.Fatalf("status: %d %s", code, raw)
	}
	var docsEnv string
	for _, v := range st["volumes"].([]any) {
		m := v.(map[string]any)
		if m["status"] != "locked" {
			t.Fatalf("a volume starts unlocked: %v", m)
		}
		if m["name"] == "docs" {
			docsEnv, _ = m["credsEnvelope"].(string)
		}
	}
	if docsEnv != envelope {
		t.Fatalf("the app did not graft the public credsEnvelope: %q", docsEnv)
	}

	// the owner's browser, on the page the app serves: the same message, the same derivation as the CLI
	d := o.browser(ga.url, "derive", "docs", o.sig)
	if d["message"] != msg || d["password"] != cliPW || d["salt"] != cliSalt {
		t.Fatalf("browser and CLI derive differently: %v vs %s/%s", d, cliPW, cliSalt)
	}
	opened := o.browser(ga.url, "open", o.sig, docsEnv)
	creds, _ := opened["creds"].(map[string]any)
	if creds["accessKeyId"] != e2eAK || creds["secretAccessKey"] != e2eSK {
		t.Fatalf("the envelope did not open: %v", opened)
	}
	tampered := []byte(docsEnv)
	tampered[len(tampered)-10] ^= 1
	if e := o.browser(ga.url, "open", o.sig, string(tampered))["error"]; e == nil || !strings.Contains(e.(string), "failed authentication") &&
		!strings.Contains(e.(string), "atob") && !strings.Contains(e.(string), "Invalid character") {
		t.Fatalf("a malformed envelope opened: %v", e)
	}
	otherSig := o.sign(e2eOtherKey, msg)
	if e := o.browser(ga.url, "open", otherSig, docsEnv)["error"]; e == nil || !strings.Contains(e.(string), "different wallet") {
		t.Fatalf("another wallet's signature opened the envelope: %v", e)
	}
	if e := o.browser(ga.url, "open", o.sig, "encv2:AAAA")["error"]; e == nil || !strings.Contains(e.(string), "unknown credsEnvelope format") {
		t.Fatalf("an unknown envelope format: %v", e)
	}

	// a wrong key: locked, the runtime's message, nothing staged
	v := ga.unlock(map[string]any{"name": "docs", "password": "not the key", "salt": cliSalt, "accessKeyId": e2eAK, "secretAccessKey": e2eSK})
	if v["status"] != "locked" || !strings.Contains(fmt.Sprint(v["error"]), "did not decrypt") {
		t.Fatalf("wrong key: %v", v)
	}
	// the wallet unlock: derived key + the envelope's credentials, nothing typed
	v = ga.unlock(map[string]any{"name": "docs", "password": d["password"], "salt": d["salt"], "accessKeyId": creds["accessKeyId"], "secretAccessKey": creds["secretAccessKey"]})
	if v["status"] != "unlocked" {
		t.Fatalf("wallet unlock: %v", v)
	}
	if code, _, body := ga.do("GET", "/f/docs/dir/b.txt", nil); code != 200 || string(body) != "owner secret beta\n" {
		t.Fatalf("the app reads its live preopen: %d %q", code, body)
	}
	if code, _, body := ga.do("GET", "/ls", nil); code != 200 || !strings.Contains(string(body), "a.txt") {
		t.Fatalf("/ls: %d %s", code, body)
	}
	if ga.app.Process.Pid != pidA {
		t.Fatal("the app restarted")
	}

	// plain + readOnly: S3 credentials only; the bytes verbatim; no push-back
	if code, m, _ := ga.do("POST", "/api/unlock", map[string]any{"name": "pub", "password": "x"}); code != 400 || !strings.Contains(fmt.Sprint(m), "is plain") {
		t.Fatalf("password on a plain volume: %d %v", code, m)
	}
	if v = ga.unlock(map[string]any{"name": "pub", "accessKeyId": e2eAK, "secretAccessKey": e2eSK}); v["status"] != "unlocked" {
		t.Fatalf("plain unlock: %v", v)
	}
	if _, _, body := ga.do("GET", "/f/pub/readme.txt", nil); string(body) != "public plain bytes\n" {
		t.Fatalf("plain bytes: %q", body)
	}
	if code, m, _ := ga.do("POST", "/api/sync", map[string]any{"name": "pub"}); code != 403 {
		t.Fatalf("push on readOnly: %d %v", code, m)
	}

	// the transfer cap: the same ciphertext through a 1 MiB view is refused, and leaves nothing
	v = ga.unlock(map[string]any{"name": "tiny", "password": cliPW, "salt": cliSalt, "accessKeyId": e2eAK, "secretAccessKey": e2eSK})
	if v["status"] != "locked" || !strings.Contains(fmt.Sprint(v["error"]), "max transfer") {
		t.Fatalf("over the cap: %v", v)
	}
	if ents, _ := os.ReadDir(filepath.Join(ga.root, "tiny")); len(ents) != 0 {
		t.Fatalf("a capped pull left %d entries", len(ents))
	}

	// push-back: what the app writes to /enc/docs (the reference app only reads, so the test writes into the
	// staged directory the app holds open), then the owner's own client pulls it with the wallet key
	os.WriteFile(filepath.Join(ga.root, "docs", "written-in-guest.txt"), []byte("guest secret gamma\n"), 0o644)
	if code, m, _ := ga.do("POST", "/api/sync", map[string]any{"name": "docs"}); code != 202 {
		t.Fatalf("sync: %d %v", code, m)
	}
	if v = ga.vol("docs"); v["error"] != nil || v["lastPush"] == nil {
		t.Fatalf("push: %v", v)
	}
	pulled := filepath.Join(work, "owner-pull")
	o.cli(s3env, "pull", pulled, "--endpoint", "https://"+s3a.addr, "--bucket", "bkt", "--path", "vol", "--sig", o.sig)
	if got := fileTree(t, pulled); got["written-in-guest.txt"] != "guest secret gamma\n" || got["a.txt"] != "owner secret alpha\n" {
		t.Fatalf("the owner's pull: %v", keysOf(got))
	}
	walkNoPlain(t, dataA, []string{"owner secret", "guest secret"}, "the bucket")

	// the audit: a volume grown past its cap ends the app
	os.WriteFile(filepath.Join(ga.root, "pub", "runaway.bin"), bytes.Repeat([]byte("R"), 9<<20), 0o644)
	ga.started.svc.Audit()
	time.Sleep(200 * time.Millisecond)
	ga.mu.Lock()
	kills := append([]string(nil), ga.kills...)
	ga.mu.Unlock()
	if len(kills) != 1 || !strings.Contains(kills[0], "volume 'pub' holds 9MiB, over its 8MiB cap") {
		t.Fatalf("the audit: %v", kills)
	}

	// lock: the plaintext goes, the directory (a live preopen) stays
	ga2 := launchGuest(t, in, cfg, hostA.addr, roots) // guest A's app was just ended by the audit: a new domain, same host
	ga2.unlock(map[string]any{"name": "docs", "password": cliPW, "salt": cliSalt, "accessKeyId": e2eAK, "secretAccessKey": e2eSK})
	if code, m, _ := ga2.do("POST", "/api/lock", map[string]any{"name": "docs"}); code != 200 || m["status"] != "locked" {
		t.Fatalf("lock: %d %v", code, m)
	}
	if ents, err := os.ReadDir(filepath.Join(ga2.root, "docs")); err != nil || len(ents) != 0 {
		t.Fatalf("lock left %d entries (%v)", len(ents), err)
	}

	// the owner's replica: an independent S3 endpoint holding the identical ciphertext (and its mtime metadata),
	// replicated with the owner's own rclone while endpoint A is still up
	dataB := filepath.Join(work, "s3-b")
	os.MkdirAll(filepath.Join(dataB, "bkt"), 0o755)
	s3b := startS3(t, in, dataB, tf)
	repl := exec.Command(in.rclone, "sync", "srca:bkt", "srcb:bkt")
	repl.Env = []string{"RCLONE_CONFIG=/dev/null", "HOME=" + t.TempDir(), "RCLONE_CA_CERT=" + tf.ca,
		"RCLONE_CONFIG_SRCA_TYPE=s3", "RCLONE_CONFIG_SRCA_PROVIDER=Other", "RCLONE_CONFIG_SRCA_ENDPOINT=https://" + s3a.addr,
		"RCLONE_CONFIG_SRCA_ACCESS_KEY_ID=" + e2eAK, "RCLONE_CONFIG_SRCA_SECRET_ACCESS_KEY=" + e2eSK,
		"RCLONE_CONFIG_SRCB_TYPE=s3", "RCLONE_CONFIG_SRCB_PROVIDER=Other", "RCLONE_CONFIG_SRCB_ENDPOINT=https://" + s3b.addr,
		"RCLONE_CONFIG_SRCB_ACCESS_KEY_ID=" + e2eAK, "RCLONE_CONFIG_SRCB_SECRET_ACCESS_KEY=" + e2eSK}
	if out, err := repl.CombinedOutput(); err != nil {
		t.Fatalf("the owner's replication: %v %s", err, out)
	}

	// the endpoint goes away: unlock fails cleanly
	s3a.stop()
	if v = ga2.unlock(map[string]any{"name": "docs", "password": cliPW, "salt": cliSalt, "accessKeyId": e2eAK, "secretAccessKey": e2eSK}); v["status"] != "locked" || v["error"] == nil {
		t.Fatalf("unlock from a dead endpoint: %v", v)
	}
	// ...and the original host disappears with its guests
	ga.stop()
	ga2.stop()

	// a FRESH guest on another host, an independent endpoint serving the identical ciphertext (the owner's replica);
	// the owner unlocks it with the same wallet: the same plaintext, the guest's edit included
	net_.route(s3b.addr)
	hostB := startHostEgress(t, net_)
	gb := launchGuest(t, in, cfg, hostB.addr, roots)
	if gb.started.svc.Token() == ga.started.svc.Token() {
		t.Fatal("a fresh guest reused a token")
	}
	db := o.browser(gb.url, "derive", "docs", o.sig)
	_, stB, _ := gb.do("GET", "/api/status", nil)
	var envB string
	for _, x := range stB["volumes"].([]any) {
		if m := x.(map[string]any); m["name"] == "docs" {
			envB, _ = m["credsEnvelope"].(string)
		}
	}
	credsB, _ := o.browser(gb.url, "open", o.sig, envB)["creds"].(map[string]any)
	if v = gb.unlock(map[string]any{"name": "docs", "password": db["password"], "salt": db["salt"], "accessKeyId": credsB["accessKeyId"], "secretAccessKey": credsB["secretAccessKey"]}); v["status"] != "unlocked" {
		t.Fatalf("recovery on a fresh guest: %v", v)
	}
	if _, _, body := gb.do("GET", "/f/docs/written-in-guest.txt", nil); string(body) != "guest secret gamma\n" {
		t.Fatalf("the recovered volume: %q", body)
	}
	if got, want := fileTree(t, filepath.Join(gb.root, "docs")), fileTree(t, pulled); fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("the recovered tree differs from the owner's: %v vs %v", keysOf(got), keysOf(want))
	}

	// SSRF: the guest's parser refuses literal/private/loopback/plain-http endpoints; the host's dialer refuses a
	// name whose answers are private or the metadata address, even when the guest's allowlist names it
	for _, ep := range []string{"https://10.0.0.5", "https://169.254.169.254", "https://localhost", "http://" + s3Name, "https://" + s3Name + ":9000", "https://user@" + s3Name} {
		bad := fmt.Sprintf(`{"encVolumes":[{"name":"x","endpoint":%q,"bucket":"b"}]}`, ep)
		if _, err := encPrepare(bad, &egress.Policy{}, &encvolHost{}); err == nil {
			t.Errorf("endpoint %s was accepted", ep)
		}
	}
	for _, name := range []string{"internal.fixture.test", "meta.fixture.test"} {
		bad := fmt.Sprintf(`{"encVolumes":[{"name":"x","endpoint":"https://%s","bucket":"bkt","path":"vol"}]}`, name)
		gx := launchBare(t, bad, hostB.addr, roots)
		if v := gx.unlockDirect("x", cliPW, cliSalt); v.Status != "locked" || v.Error == nil {
			t.Errorf("%s: a private answer was reached: %+v", name, v)
		}
	}
	hostB.mu.Lock()
	hlog := hostB.log.String()
	hostB.mu.Unlock()
	if strings.Count(hlog, "refused:non-public-answer") < 2 {
		t.Errorf("the host's egress did not refuse the private answers: %s", hlog)
	}

	// memory: volumes are guest RAM; a version too small for them is refused at launch
	huge := `{"encVolumes":[{"name":"x","endpoint":"https://s3.fixture.test","bucket":"b","maxMb":4096}]}`
	if _, err := encPrepare(huge, &egress.Policy{}, &encvolHost{memMiB: func() (int, error) { return 512, nil }}); err == nil || !strings.Contains(err.Error(), "MiB of this guest") {
		t.Errorf("a volume larger than the guest: %v", err)
	}

	// leaks: no key, signature, S3 secret, token or plaintext in any console line, the runtime's argv, the host's
	// egress log or a public status document; no plaintext outside the volumes
	secrets := []string{cliPW, cliSalt, o.sig, e2eSK, "owner secret", "guest secret"}
	for _, g := range []*guest{ga, ga2, gb} {
		secretsG := append(append([]string{}, secrets...), g.started.svc.Token())
		g.mu.Lock()
		lines := append([]string{}, g.logs...)
		g.mu.Unlock()
		for _, l := range append(lines, strings.Join(g.argv, " "), g.appOut.String(), hlog, hostA.log.String()) {
			for _, s := range secretsG {
				if s != "" && strings.Contains(l, s) {
					t.Errorf("a secret leaked into %q", l)
				}
			}
		}
	}
	_, pubSt, _ := gb.do("GET", "/api/status", nil)
	pb, _ := json.Marshal(pubSt)
	for _, s := range []string{gb.started.svc.Token(), cliPW, e2eSK} {
		if strings.Contains(string(pb), s) {
			t.Errorf("the public status carries a secret")
		}
	}
	walkNoPlain(t, work, []string{"guest secret"}, "the test host outside the owner's own directories",
		ownerDir, pulled, ga.root, ga2.root, gb.root)
}

// launchBare is the front and plane only (no runtime), for refusals that never reach the app.
type bare struct {
	t   *testing.T
	svc *encvol.Service
}

func launchBare(t *testing.T, cfg, hostAddr string, roots *x509.CertPool) *bare {
	host := &encvolHost{root: t.TempDir(), uid: -1, gid: -1, listen: "127.0.0.1:0", roots: roots, kill: func(string) {}}
	pol := &egress.Policy{}
	specs, err := encPrepare(cfg, pol, host)
	if err != nil {
		t.Fatalf("encPrepare: %v", err)
	}
	port, _ := netip.ParseAddrPort(freeAddr(t))
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	fwd := &egress.Forwarder{Policy: pol, Port: int(port.Port()), Upstream: func() (net.Conn, error) { return net.Dial("tcp", hostAddr) }}
	if err := fwd.Start(ctx); err != nil {
		t.Fatal(err)
	}
	host.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		h, _, _ := net.SplitHostPort(addr)
		a, ok := fwd.Addr(h)
		if !ok {
			return nil, fmt.Errorf("lookup %s: no such host", h)
		}
		return (&net.Dialer{}).DialContext(ctx, network, a.String())
	}
	var id [32]byte
	st, err := encStart(ctx, id, specs, host, func(string, ...any) {})
	if err != nil {
		t.Fatal(err)
	}
	return &bare{t: t, svc: st.svc}
}

type pubView struct {
	Status string  `json:"status"`
	Error  *string `json:"error"`
}

func (b *bare) unlockDirect(name, pw, salt string) pubView {
	body, _ := json.Marshal(map[string]any{"name": name, "password": pw, "salt": salt, "accessKeyId": e2eAK, "secretAccessKey": e2eSK})
	req, _ := http.NewRequest("POST", "/encvol/0x"+strings.Repeat("00", 32)+"/unlock", bytes.NewReader(body))
	req.Header.Set("X-Enc-Token", b.svc.Token())
	rec := &recorder{h: http.Header{}}
	b.svc.ServeHTTP(rec, req)
	for i := 0; i < 600; i++ {
		for _, v := range b.svc.Public() {
			j, _ := json.Marshal(v)
			var p pubView
			json.Unmarshal(j, &p)
			if p.Status != "syncing" {
				return p
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	b.t.Fatal("never settled")
	return pubView{}
}

type recorder struct {
	h    http.Header
	code int
	body bytes.Buffer
}

func (r *recorder) Header() http.Header         { return r.h }
func (r *recorder) Write(p []byte) (int, error) { return r.body.Write(p) }
func (r *recorder) WriteHeader(c int)           { r.code = c }

func walkNoPlain(t *testing.T, root string, needles []string, what string, skip ...string) {
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		for _, s := range skip {
			if p == s || strings.HasPrefix(p, s+"/") {
				if fi.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
		}
		if fi.Mode().IsRegular() && fi.Size() < 64<<20 {
			b, _ := os.ReadFile(p)
			for _, n := range needles {
				if bytes.Contains(b, []byte(n)) {
					t.Errorf("plaintext %q in %s (%s)", n, p, what)
				}
			}
		}
		return nil
	})
}

func hasArg(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func keysOf(m map[string]string) []string {
	var l []string
	for k := range m {
		l = append(l, k)
	}
	return l
}
