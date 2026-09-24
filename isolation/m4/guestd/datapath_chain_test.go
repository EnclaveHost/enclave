package main

// The per-app data path end to end, on this machine, with every hop the real code except where a hop needs
// hardware:
//
//	client.mjs (the real verifying client, --servername)
//	  -> relay-fixture.mjs (relay/relay.js's splice half: bytes over a WebSocket to /x/<id>/https)
//	  -> supervisor.js (its REAL upgrade handler and /x/:id routes, via ISOLATION_DATAPATH_SELFTEST, reaching
//	     guestd over guestd-control/1 and its data plane over enclave-splice/1)
//	  -> guestd (this package's real server, auth and data plane)
//	  -> a fixture forwarder (TCP to the front's unix socket; can be switched to a TLS-terminating MITM)
//	  -> the REAL guest front (isolation/m2/front), in its own user scope so its W^X scan covers only itself,
//	     with a fixture app behind it
//
// WHAT IS FIXTURE, and what that means for every result below:
//   - there is no SNP guest. The front asks a fixture monitor for its report (the M3 shape, -report-unix), and
//     the monitor returns a report it SYNTHESIZED: report_data is exactly what the front asked for plus the
//     AppID, and the "measurement" is a fixture value derived from the bundle. Nothing signs it, so the best
//     verdict any client can reach is "unauthenticated" (--lab-unsigned), never "attested". The AMD chain, the
//     TCB and a real launch measurement are covered by the hardware runs (test-guestd.sh G4), not here;
//   - the runtime identity is synthetic (valid, but it describes no runtime on this machine);
//   - guestd's fixture launcher accepts "unauthenticated" where the real launcher demands "attested".
// So these results say what the PATH does - where TLS ends, who can read what, what is refused, what is bounded,
// what ends with an instance - and whether the verifying client refuses a wrong guest, app, key, runtime or
// measurement through it. They do not say anything about SNP.

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

var chainRuntime = contract.RuntimeIdentity{Name: "wasmtime", Version: "0.0.0-fixture", Execution: contract.ExecInterpreter,
	TargetISA: contract.ISApulley64, HostISA: contract.ISAx86_64, CPUFeatures: "baseline", WX: contract.WXEnforced,
	Cache: contract.CacheNone}

// ---- the fixture guest: a real front, a fixture app, a fixture monitor ------------------------------------------

type chainGuest struct {
	label, appID, meas, sock string
	hostData                 string // what the fixture monitor puts at 0xC0, as the PSP would from the launch
	launchedFor              string // the deployment guestd launched it for (before any copied label)
	front                    *exec.Cmd
	frontDone                chan struct{}
	app                      *http.Server
	mon                      net.Listener
	fwd                      net.Listener
	mitm                     atomic.Bool
	streamed                 atomic.Int64
	streamsEnded             atomic.Int64
}

type chainLauncher struct {
	t        *testing.T
	front    string // the built front binary
	sockDir  string // short: unix socket paths are limited to 108 bytes
	rtFile   string
	mu       sync.Mutex
	guests   map[string]*chainGuest // workdir -> guest
	mitmFrom map[string]bool        // label -> the forwarder terminates TLS from the start
	deps     map[string]string      // label -> deployment id, so a guest is found by the id in its HOST_DATA
	// copyLabel models a HOST that controls its own launcher: an instance whose HOST_DATA would be the key is
	// launched with the value instead (another deployment's id). guestd's real verifier would refuse such a guest,
	// since it requires the record's own HOST_DATA, but a hostile host need not launch through guestd at all.
	copyLabel map[string]string
}

func (l *chainLauncher) guest(workdir string) *chainGuest {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.guests[workdir]
}

func fixtureMeasurement(bundle []byte, vcpus int) string {
	h := sha512.New384()
	fmt.Fprintf(h, "enclave FIXTURE measurement, not a launch digest\n%d\n", vcpus)
	h.Write(bundle)
	return hex.EncodeToString(h.Sum(nil))
}

func (l *chainLauncher) Build(ctx context.Context, bundle, workdir string, vcpus int) (string, string, error) {
	raw, err := os.ReadFile(bundle)
	if err != nil {
		return "", "", err
	}
	m, _, err := contract.Parse(raw)
	if err != nil {
		return "", "", err
	}
	id := contract.AppID(raw)
	g := &chainGuest{label: m.Label, appID: hex.EncodeToString(id[:]), meas: fixtureMeasurement(raw, vcpus),
		frontDone: make(chan struct{})}
	l.mu.Lock()
	l.guests[workdir] = g
	l.mu.Unlock()
	return bundle, g.meas, nil
}

func (l *chainLauncher) Start(ctx context.Context, image, tag, workdir string, vcpus, mem, cpu int, hostData string) (string, uint32, error) {
	g := l.guest(workdir)
	g.launchedFor = hostData
	if c, ok := l.copyLabel[hostData]; ok {
		hostData = c
	}
	g.hostData = hostData
	// the app behind the front
	mux := http.NewServeMux()
	mux.HandleFunc("/hello", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintf(w, "app %s\n", g.label) })
	mux.HandleFunc("/stream", func(w http.ResponseWriter, r *http.Request) {
		buf := bytes.Repeat([]byte("s"), 64<<10)
		fl := w.(http.Flusher)
		for {
			n, err := w.Write(buf)
			g.streamed.Add(int64(n))
			if err != nil {
				g.streamsEnded.Add(1)
				return
			}
			fl.Flush()
		}
	})
	al, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", 0, err
	}
	g.app = &http.Server{Handler: mux}
	go g.app.Serve(al)
	// the monitor: report_data[0:32] is the binding the front asks for, [32:64] the AppID, and the measurement
	// the fixture value. Unsigned.
	g.sock = filepath.Join(l.sockDir, tag)
	g.mon, err = net.Listen("unix", g.sock+".mon")
	if err != nil {
		return "", 0, err
	}
	go func() {
		for {
			c, err := g.mon.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				var req struct{ Bind string }
				if json.NewDecoder(c).Decode(&req) != nil {
					return
				}
				bind, _ := hex.DecodeString(req.Bind)
				app, _ := hex.DecodeString(g.appID)
				meas, _ := hex.DecodeString(g.meas)
				rep := make([]byte, 0x4a0)
				binary.LittleEndian.PutUint32(rep[0x00:], 3)       // report version
				binary.LittleEndian.PutUint64(rep[0x08:], 0x30000) // policy: DEBUG and MIGRATE_MA off
				copy(rep[0x50:], bind)
				copy(rep[0x70:], app)
				copy(rep[0x90:], meas)
				if hd, _ := hex.DecodeString(g.hostData); len(hd) == 32 {
					copy(rep[0xc0:], hd) // HOST_DATA, fixed at launch
				}
				_ = json.NewEncoder(c).Encode(map[string]string{"report": base64.StdEncoding.EncodeToString(rep)})
			}()
		}
	}()
	shaFile := filepath.Join(workdir, "app.sha256")
	if err := os.WriteFile(shaFile, []byte(g.appID+"\n"), 0o600); err != nil {
		return "", 0, err
	}
	// the real front, alone in a transient user scope: its W^X scan covers its own cgroup, which then holds
	// only itself (this test's own cgroup holds browsers and editors with W+X JIT pages, and the front would
	// rightly refuse to serve there)
	g.front = exec.Command("systemd-run", "--user", "--scope", "--quiet", "--", l.front,
		"-listen-unix", g.sock+".tls", "-report-unix", g.sock+".mon", "-app-sha", shaFile,
		"-runtime-identity", l.rtFile, "-upstream", al.Addr().String(), "-cert-zone", "app.test")
	out, _ := g.front.StdoutPipe()
	g.front.Stderr = g.front.Stdout
	if err := g.front.Start(); err != nil {
		return "", 0, err
	}
	serving := make(chan string, 1)
	var log strings.Builder
	var logMu sync.Mutex
	go func() {
		sc := bufio.NewScanner(out)
		for sc.Scan() {
			logMu.Lock()
			log.WriteString(sc.Text() + "\n")
			logMu.Unlock()
			if strings.HasPrefix(sc.Text(), "DOM serving") {
				serving <- sc.Text()
			}
		}
	}()
	go func() { _ = g.front.Wait(); close(g.frontDone) }()
	select {
	case s := <-serving:
		l.t.Logf("guest %s: %s", g.label, s)
	case <-g.frontDone:
		logMu.Lock()
		defer logMu.Unlock()
		return "", 0, fmt.Errorf("the front exited: %s", log.String())
	case <-time.After(30 * time.Second):
		return "", 0, errors.New("the front never served")
	}
	return "unit-" + tag, 7, nil
}

// Forward relays a host TCP port to the front's socket, bytes untouched - or, once mitm is set, terminates TLS
// with its OWN key and re-encrypts to the front, reading everything in between (m2/fwd -mitm's attack).
func (l *chainLauncher) Forward(ctx context.Context, cid uint32, workdir string) (int, func(), error) {
	g := l.guest(workdir)
	l.mu.Lock()
	g.mitm.Store(l.mitmFrom[g.label])
	l.mu.Unlock()
	fl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, nil, err
	}
	g.fwd = fl
	cert, err := hostCert()
	if err != nil {
		return 0, nil, err
	}
	go func() {
		for {
			c, err := fl.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				up, err := net.Dial("unix", g.sock+".tls")
				if err != nil {
					return
				}
				defer up.Close()
				var a, b net.Conn = c, up
				if g.mitm.Load() {
					ts := tls.Server(c, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13})
					tc := tls.Client(up, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
					a, b = ts, tc
				}
				done := make(chan struct{}, 2)
				go func() { _, _ = io.Copy(b, a); done <- struct{}{} }()
				go func() { _, _ = io.Copy(a, b); done <- struct{}{} }()
				<-done
			}()
		}
	}()
	return fl.Addr().(*net.TCPAddr).Port, func() { fl.Close() }, nil
}

// hostCert is the host's own key and certificate, for the MITM: not the guest's.
func hostCert() (tls.Certificate, error) {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}, nil
}

// Verify runs the REAL client in lab-unsigned mode: every field check, no AMD signature (there is none).
func (l *chainLauncher) Verify(ctx context.Context, port int, meas, appID, hostData, workdir string) (string, string, error) {
	args := []string{"../../m2/client.mjs", "https://127.0.0.1:" + strconv.Itoa(port),
		"--lab-unsigned", "--no-kds", "--measurement", meas, "--app-sha", appID, "--runtime", l.rtFile, "--answer-within", "10000"}
	if g := l.guest(workdir); g != nil && g.hostData != hostData {
		hostData = g.hostData // the copied-label host verifies what it launched (see copyLabel)
	}
	if hostData != "" {
		args = append(args, "--host-data", hostData)
	}
	out, _ := exec.CommandContext(ctx, "node", args...).CombinedOutput()
	r := results(string(out))
	if strings.HasPrefix(r["VERDICT"], "unauthenticated") && r["gate"] == "open" {
		return "unauthenticated (FIXTURE: unsigned report)", r["spki_sha256"], nil
	}
	return "", "", fmt.Errorf("VERDICT %s", r["VERDICT"])
}

func (l *chainLauncher) Alive(unit string) bool { return true }

func (l *chainLauncher) Stop(tag, workdir string) error {
	g := l.guest(workdir)
	if g == nil {
		return nil
	}
	if g.front != nil && g.front.Process != nil {
		_ = g.front.Process.Signal(syscall.SIGTERM)
		select {
		case <-g.frontDone:
		case <-time.After(5 * time.Second):
			_ = g.front.Process.Kill()
		}
	}
	if g.fwd != nil {
		g.fwd.Close()
	}
	if g.mon != nil {
		g.mon.Close()
	}
	if g.app != nil {
		g.app.Close()
	}
	return nil
}

func (l *chainLauncher) Sweep(keep map[string]bool) ([]string, error) { return nil, nil }

// results parses client.mjs's RESULT k=v lines and its VERDICT line.
func results(out string) map[string]string {
	m := map[string]string{}
	for _, ln := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(strings.TrimPrefix(ln, "RESULT "), "="); ok && strings.HasPrefix(ln, "RESULT ") {
			m[k] = v
		}
		if v, ok := strings.CutPrefix(ln, "VERDICT "); ok {
			m["VERDICT"] = v
		}
	}
	return m
}

// ---- the chain -------------------------------------------------------------------------------------------------

type chain struct {
	t        *testing.T
	s        *server
	l        *chainLauncher
	ts       *httptest.Server
	dataAddr string
	supPort  int
	routes   map[string]int
	mu       sync.Mutex
	splices  []map[string]any
	inst     map[string]string // label -> guestd instance id
	apps     map[string]string // label -> AppID
	deps     map[string]string // label -> deployment id
	certs    map[string][]string
	nDeps    int // deployments the supervisor seam holds
	ca       *fakeCertService
}

// fakeCertService stands in for the platform certificate service (relay/certs.js POST /v1/certs/issue): it checks the
// CSR is exactly {CN=name, SAN=[name]} and self-signed by its key, and issues a SHORT-lived leaf from its own CA, so
// rotation happens inside the test. For misbehaveFor it answers with a certificate for ANOTHER key.
type fakeCertService struct {
	caCert       *x509.Certificate
	caKey        *ecdsa.PrivateKey
	misbehaveFor string
	lifetime     time.Duration
	mu           sync.Mutex
	issued       map[string]int
	sent         map[string]int      // name -> requests received, before any validation (what the relay ASKED for)
	keys         map[string][]string // name -> spki sha256 of every CSR it was asked to certify
}

func newFakeCertService(t *testing.T) *fakeCertService {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "fixture WebPKI root"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return &fakeCertService{caCert: c, caKey: k, lifetime: 12 * time.Second, issued: map[string]int{}, sent: map[string]int{}, keys: map[string][]string{}}
}

func (f *fakeCertService) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var req struct{ Name, Csr, Endpoint, OpSig, Sig string }
	if r.URL.Path != "/v1/certs/issue" || json.NewDecoder(r.Body).Decode(&req) != nil {
		http.Error(w, "bad request", 400)
		return
	}
	f.mu.Lock()
	f.sent[req.Name]++
	f.mu.Unlock()
	b, _ := pem.Decode([]byte(req.Csr))
	if b == nil {
		writeJSON(w, 400, map[string]any{"error": "no csr"})
		return
	}
	csr, err := x509.ParseCertificateRequest(b.Bytes)
	if err != nil || csr.CheckSignature() != nil || csr.Subject.CommonName != req.Name || len(csr.DNSNames) != 1 || csr.DNSNames[0] != req.Name ||
		(req.OpSig == "" && req.Sig == "") {
		writeJSON(w, 400, map[string]any{"error": "csr refused"})
		return
	}
	spki, _ := x509.MarshalPKIXPublicKey(csr.PublicKey)
	sum := sha256.Sum256(spki)
	pub := csr.PublicKey
	if req.Name == f.misbehaveFor {
		other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		pub = &other.PublicKey
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	now := time.Now()
	f.mu.Lock()
	life := f.lifetime
	f.mu.Unlock()
	tpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: req.Name}, DNSNames: []string{req.Name},
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(life), KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, _ := x509.CreateCertificate(rand.Reader, tpl, f.caCert, pub, f.caKey)
	f.mu.Lock()
	f.issued[req.Name]++
	f.keys[req.Name] = append(f.keys[req.Name], hex.EncodeToString(sum[:]))
	f.mu.Unlock()
	chain := append(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: f.caCert.Raw})...)
	writeJSON(w, 200, map[string]any{"certPem": string(chain), "ca": "fixture"})
}

func (f *fakeCertService) stats(name string) (int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.issued[name], append([]string{}, f.keys[name]...)
}

func (f *fakeCertService) asked(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sent[name]
}

func depName(dep string) string { return dep[2:10] + ".app.test" }

func newChain(t *testing.T) *chain {
	for _, b := range []string{"node", "systemd-run", "go"} {
		if _, err := exec.LookPath(b); err != nil {
			t.Skipf("%s is not installed", b)
		}
	}
	if err := exec.Command("systemd-run", "--user", "--scope", "--quiet", "--", "true").Run(); err != nil {
		t.Skipf("no user systemd scopes here (%v): the fixture front needs a cgroup of its own", err)
	}
	dir := t.TempDir()
	sockDir, err := os.MkdirTemp("", "gdc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(sockDir) })
	front := filepath.Join(dir, "front")
	b := exec.Command("go", "build", "-o", front, "./front")
	b.Dir = "../../m2"
	if out, err := b.CombinedOutput(); err != nil {
		t.Fatalf("building the front: %v %s", err, out)
	}
	rt, _ := json.Marshal(chainRuntime)
	rtFile := filepath.Join(dir, "runtime.json")
	_ = os.WriteFile(rtFile, rt, 0o600)
	rid, err := contract.RuntimeID(chainRuntime)
	if err != nil {
		t.Fatal(err)
	}
	l := &chainLauncher{t: t, front: front, sockDir: sockDir, rtFile: rtFile, guests: map[string]*chainGuest{},
		mitmFrom: map[string]bool{"D": true}, copyLabel: map[string]string{}}
	s := newServer(l, filepath.Join(dir, "root"))
	s.RuntimeID = hex.EncodeToString(rid[:])
	s.Auth = newControlAuth(testKey, s.Now)
	s.Data = newDataPlane(s)
	s.Data.Idle = 4 * time.Second
	dl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go s.Data.Serve(dl)
	ts := httptest.NewServer(s)
	ch := &chain{t: t, s: s, l: l, ts: ts, dataAddr: dl.Addr().String(), inst: map[string]string{}, apps: map[string]string{},
		deps: map[string]string{"A": "0x" + strings.Repeat("a1", 32), "B": "0x" + strings.Repeat("b2", 32),
			"C": "0x" + strings.Repeat("c3", 32), "D": "0x" + strings.Repeat("d4", 32),
			"E": "0x" + strings.Repeat("e5", 32),
			// A2 and A3: the SAME app as A (identical bundle, so the same AppID and measurement), other deployments.
			// A3's host copies A's deployment id into its HOST_DATA (copyLabel).
			"A2": "0x" + strings.Repeat("a2", 32), "A3": "0x" + strings.Repeat("a3", 32)}}
	l.deps = ch.deps
	l.copyLabel[strings.Repeat("a3", 32)] = strings.Repeat("a1", 32)
	t.Cleanup(func() {
		s.shutdown()
		ts.Close()
		dl.Close()
	})

	// the guests, launched through guestd's own /vms route (the setup bypasses the channel; the supervisor below
	// does not)
	// L: the same app again under a LAB name (not a deployment id), so guestd binds no HOST_DATA (all zero)
	ch.deps["L"] = "lab-L"
	for _, label := range []string{"A", "B", "C", "D", "A2", "A3", "L"} {
		src := label
		if label == "A2" || label == "A3" || label == "L" {
			src = "A" // byte-identical bundles of A
		}
		b, err := contract.Build(contract.Manifest{Label: src}, []byte("\x00asm component "+src))
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(dir, label+".bundle")
		_ = os.WriteFile(p, b, 0o600)
		code, body := ch.direct("POST", "/vms", map[string]any{"image": "file://" + p, "name": ch.deps[label]})
		if code != 201 {
			t.Fatalf("create %s: %d %v", label, code, body)
		}
		ch.inst[label], ch.apps[label] = body["id"].(string), body["appId"].(string)
	}
	s.launching.Wait()
	for _, label := range []string{"A", "B", "C", "A2", "A3", "L"} {
		if _, v := ch.direct("GET", "/vms/"+ch.inst[label], nil); v["status"] != "running" {
			t.Fatalf("guest %s did not start: %v", label, v)
		}
	}

	// the supervisor, with the flag, the key, the data plane and the three routable deployments
	keyFile := filepath.Join(dir, "pair.key")
	_ = os.WriteFile(keyFile, []byte(hex.EncodeToString(testKey)+"\n"), 0o600)
	var deps []map[string]any
	for _, label := range []string{"A", "B", "C", "D"} {
		deps = append(deps, map[string]any{"id": ch.deps[label], "vmId": ch.inst[label], "appId": ch.apps[label]})
	}
	// E: a supervisor record whose instance is B's guest, but which recorded launching A's app - the route must
	// be refused, whatever that guest would say
	deps = append(deps, map[string]any{"id": ch.deps["E"], "vmId": ch.inst["B"], "appId": ch.apps["A"]})
	// A3: its own deployment and guest, but launched by a host that copied A's label into HOST_DATA - the route and the
	// handshake key are right, so only the attestation (HOST_DATA = this deployment) can stop a certificate
	deps = append(deps, map[string]any{"id": ch.deps["A3"], "vmId": ch.inst["A3"], "appId": ch.apps["A3"]})
	ch.ca = newFakeCertService(t)
	ch.ca.misbehaveFor = depName(ch.deps["B"])
	cats := httptest.NewServer(ch.ca)
	t.Cleanup(cats.Close)
	// C: the host terminates TLS in front of C from before the supervisor starts, so the certificate relay's first look
	// at C is through a MITM (guestd verified C earlier, cleanly)
	ch.l.guestByLabel("C").mitm.Store(true)
	ch.nDeps = len(deps)
	cfg, _ := json.Marshal(map[string]any{"deployments": deps, "guestCerts": map[string]any{"everyMs": 1500}})
	sup := exec.Command("node", "../../../supervisor.js")
	sup.Env = append(os.Environ(), "SECRET=test-secret", "ISOLATION_DATAPATH_SELFTEST="+string(cfg),
		"ISOLATION_BACKEND=snp-guest-per-app", "VMMGR_URL="+ts.URL, "GUESTD_KEY_FILE="+keyFile,
		"GUESTD_DATA_ADDR="+ch.dataAddr, "APP_CERT_DOMAIN=app.test", "CERTS_API="+cats.URL,
		"PUBLIC_URL=https://api.enclave.test/t/metal-iso0", "REGISTRY_PRIVATE_KEY=0x"+strings.Repeat("11", 32),
		"GUESTD_TRANSPORT_SELFTEST=", "ISOLATION_SELFTEST=", "INSTANCE_SELFTEST=", "POOL_SELFTEST=", "SWEEP_SELFTEST=",
		"REACH_SELFTEST=", "ACME_SELFTEST=", "CFG_EDIT_SELFTEST=", "ADDRESS_BOOK_ADDRESS=", "REGISTRY_ENABLED=",
		"CLAIM_ENABLED=", "ACME_EAB_KID=", "ACME_EAB_HMAC=", "DNS_API=")
	so, _ := sup.StdoutPipe()
	// one warning per refused splice (the SPLICE lines on stdout carry every outcome); the certificate relay's own
	// warnings are kept, since they say why a guest got no certificate
	se, _ := sup.StderrPipe()
	go func() {
		sc := bufio.NewScanner(se)
		for sc.Scan() {
			if strings.Contains(sc.Text(), "certificate") {
				t.Logf("supervisor: %s", sc.Text())
			}
		}
	}()
	if err := sup.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sup.Process.Kill(); _ = sup.Wait() })
	listening := make(chan int, 1)
	go func() {
		sc := bufio.NewScanner(so)
		for sc.Scan() {
			ln := sc.Text()
			if v, ok := strings.CutPrefix(ln, "SPLICE "); ok {
				var m map[string]any
				_ = json.Unmarshal([]byte(v), &m)
				ch.mu.Lock()
				ch.splices = append(ch.splices, m)
				ch.mu.Unlock()
			} else if strings.HasPrefix(ln, `{"listening":`) {
				var m struct {
					Listening int
					CertNames map[string][]string
				}
				_ = json.Unmarshal([]byte(ln), &m)
				ch.certs = m.CertNames
				listening <- m.Listening
			}
		}
	}()
	select {
	case ch.supPort = <-listening:
	case <-time.After(30 * time.Second):
		t.Fatal("the supervisor never listened")
	}

	// the relay: one fixed route per deployment
	args := []string{"testdata/relay-fixture.mjs", strconv.Itoa(ch.supPort)}
	for _, label := range []string{"A", "B", "C", "D", "E"} {
		args = append(args, ch.deps[label])
	}
	rl := exec.Command("node", args...)
	ro, _ := rl.StdoutPipe()
	rl.Stderr = os.Stderr
	if err := rl.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = rl.Process.Kill(); _ = rl.Wait() })
	line, err := bufio.NewReader(ro).ReadString('\n')
	if err != nil {
		t.Fatalf("relay fixture: %v", err)
	}
	var rr struct{ Routes map[string]int }
	_ = json.Unmarshal([]byte(line), &rr)
	ch.routes = map[string]int{}
	for label, dep := range ch.deps {
		ch.routes[label] = rr.Routes[dep]
	}
	return ch
}

// direct calls guestd's /vms routes in process, past the channel (test setup and the owner-stop step only).
func (ch *chain) direct(method, path string, body any) (int, map[string]any) {
	var rd io.Reader = http.NoBody
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	w := httptest.NewRecorder()
	ch.s.route(w, httptest.NewRequest(method, path, rd))
	var m map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &m)
	return w.Code, m
}

type clientRun struct {
	code int
	r    map[string]string
	out  string
}

// client runs the real verifying client through the relay route `via`, sending `name` as SNI and expecting the
// guest of `want` - with the expected identity overridable per field.
func (ch *chain) client(via, name, want string, over map[string]string) clientRun {
	meas := ch.l.guestByLabel(want).meas
	app := ch.apps[want]
	rt := ch.l.rtFile
	if v, ok := over["measurement"]; ok {
		meas = v
	}
	if v, ok := over["app"]; ok {
		app = v
	}
	if v, ok := over["runtime"]; ok {
		rt = v
	}
	cmd := exec.Command("node", "../../m2/client.mjs", "https://127.0.0.1:"+strconv.Itoa(ch.routes[via]),
		"--servername", name, "--lab-unsigned", "--no-kds", "--measurement", meas, "--app-sha", app, "--runtime", rt,
		"--answer-within", "3000")
	out, err := cmd.CombinedOutput()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		code = -1
	}
	return clientRun{code: code, r: results(string(out)), out: string(out)}
}

// clientAtGuest runs the verifying client straight at an instance's forwarder, as if the host (not the relay or the
// supervisor, whose SNI check would stop it) delivered the connection there. It expects `want`'s app and
// measurement and, when hostData is not "-", that deployment binding.
func (ch *chain) clientAtGuest(inst, want, hostData string) clientRun {
	_, v := ch.direct("GET", "/vms/"+ch.inst[inst], nil)
	port := fmt.Sprint(v["hostPort"])
	args := []string{"../../m2/client.mjs", "https://127.0.0.1:" + port, "--lab-unsigned", "--no-kds",
		"--measurement", ch.l.guestByLabel(want).meas, "--app-sha", ch.apps[want], "--runtime", ch.l.rtFile, "--answer-within", "5000"}
	if hostData != "-" {
		args = append(args, "--host-data", hostData)
	}
	out, err := exec.Command("node", args...).CombinedOutput()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		code = -1
	}
	return clientRun{code: code, r: results(string(out)), out: string(out)}
}

func (l *chainLauncher) guestByLabel(label string) *chainGuest {
	l.mu.Lock()
	defer l.mu.Unlock()
	want := strings.ToLower(strings.TrimPrefix(l.deps[label], "0x"))
	for _, g := range l.guests {
		if want != "" && g.launchedFor == want {
			return g
		}
	}
	return nil
}

// pinned opens TLS through a relay route, pinning the key guestd's verifier saw for `label`'s instance: the
// transport-behaviour steps below need a live session, not a verdict (the client runs cover the verdict).
func (ch *chain) pinned(via, name, label string) (*tls.Conn, error) {
	_, v := ch.direct("GET", "/vms/"+ch.inst[label], nil)
	pin, _ := v["transportKeySha256"].(string)
	cfg := &tls.Config{ServerName: name, InsecureSkipVerify: true, MinVersion: tls.VersionTLS13,
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			c, err := x509.ParseCertificate(raw[0])
			if err != nil {
				return err
			}
			if s := sha256.Sum256(c.RawSubjectPublicKeyInfo); hex.EncodeToString(s[:]) != pin {
				return errors.New("not the pinned key")
			}
			return nil
		}}
	return tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", "127.0.0.1:"+strconv.Itoa(ch.routes[via]), cfg)
}

func (ch *chain) spliceKinds() map[string]int {
	ch.mu.Lock()
	defer ch.mu.Unlock()
	out := map[string]int{}
	for _, s := range ch.splices {
		k := fmt.Sprint(s["outcome"])
		if s["kind"] != nil {
			k += ":" + fmt.Sprint(s["kind"])
		}
		out[k]++
	}
	return out
}

func (ch *chain) waitSplices(n int) {
	for deadline := time.Now().Add(15 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		ch.mu.Lock()
		got := len(ch.splices)
		ch.mu.Unlock()
		if got >= n {
			return
		}
	}
}

func (ch *chain) nSplices() int { ch.mu.Lock(); defer ch.mu.Unlock(); return len(ch.splices) }

// ---- the test ------------------------------------------------------------------------------------------------

func TestTheDataPathEndToEnd(t *testing.T) {
	ch := newChain(t)
	A, B, C := ch.deps["A"], ch.deps["B"], ch.deps["C"]
	tally := map[string]string{}
	record := func(step, got string, ok bool) {
		mark := "PASS"
		if !ok {
			mark = "FAIL"
			t.Errorf("%s: %s", step, got)
		}
		tally[step] = mark + " " + got
		t.Logf("%s %s: %s", mark, step, got)
	}

	// 0a. this process requests no certificate for any tier deployment's names: TLS for them ends in the guest
	none := len(ch.certs) == ch.nDeps
	for _, v := range ch.certs {
		none = none && len(v) == 0
	}
	record("no certificate is requested for a tier deployment", fmt.Sprint(ch.certs), none)

	// 0. guestd's own verifier refuses a guest behind a TLS-terminating forwarder: D never runs
	_, d := ch.direct("GET", "/vms/"+ch.inst["D"], nil)
	record("a guest behind a MITM forwarder is refused at launch", fmt.Sprintf("status=%v", d["status"]), d["status"] == "failed")

	// 1. each tenant, verified THROUGH the splice, and served
	for _, label := range []string{"A", "B"} {
		r := ch.client(label, depName(ch.deps[label]), label, nil)
		ok := r.code == 0 && strings.HasPrefix(r.r["VERDICT"], "unauthenticated") && r.r["gate"] == "open" &&
			r.r["app_body"] == fmt.Sprintf("%q", "app "+label) && r.r["app_on_pinned_key"] == "1" &&
			r.r["doc_key_matches_handshake"] == "1" && r.r["replay_rejected"] == "1"
		record("client verifies and is served by "+label, fmt.Sprintf("exit=%d verdict=%q body=%s", r.code, r.r["VERDICT"], r.r["app_body"]), ok)
		if !ok {
			t.Log(r.out)
		}
	}

	// 2. concurrent tenants: three clients of each at once, each served only by its own guest
	var wg sync.WaitGroup
	var mu sync.Mutex
	served := map[string]int{}
	for i := 0; i < 6; i++ {
		label := []string{"A", "B"}[i%2]
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := ch.client(label, depName(ch.deps[label]), label, nil)
			mu.Lock()
			if r.code == 0 && r.r["app_body"] == fmt.Sprintf("%q", "app "+label) {
				served[label]++
			} else {
				served["wrong-or-failed"]++
			}
			mu.Unlock()
		}()
	}
	wg.Wait()
	record("6 concurrent clients over two tenants", fmt.Sprint(served), served["A"] == 3 && served["B"] == 3 && served["wrong-or-failed"] == 0)

	// 2b. F2: a WebPKI certificate for the guest's OWN key, relayed by the supervisor (supervisor-guestcert.mjs)
	roots := x509.NewCertPool()
	roots.AddCert(ch.ca.caCert)
	browser := func(via, name string) (string, error) { // what a browser does: WebPKI verification, nothing else
		c, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", "127.0.0.1:"+strconv.Itoa(ch.routes[via]),
			&tls.Config{ServerName: name, RootCAs: roots, MinVersion: tls.VersionTLS13})
		if err != nil {
			return "", err
		}
		defer c.Close()
		leaf := c.ConnectionState().PeerCertificates[0]
		sum := sha256.Sum256(leaf.RawSubjectPublicKeyInfo)
		return hex.EncodeToString(sum[:]) + " serial " + leaf.SerialNumber.String(), nil
	}
	_, vA := ch.direct("GET", "/vms/"+ch.inst["A"], nil)
	var seen string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if s, err := browser("A", depName(A)); err == nil {
			seen = s
			break
		}
	}
	record("a browser-like client (WebPKI only) accepts A's name", seen, strings.HasPrefix(seen, fmt.Sprint(vA["transportKeySha256"])+" "))
	r := ch.client("A", depName(A), "A", nil)
	record("... and the verifying client still attests A on the same key", fmt.Sprintf("exit=%d spki=%.16s", r.code, r.r["spki_sha256"]),
		r.code == 0 && r.r["spki_sha256"] == fmt.Sprint(vA["transportKeySha256"]))
	var nB int
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if nB, _ = ch.ca.stats(depName(B)); nB >= 1 {
			break
		}
	}
	time.Sleep(time.Second) // the relay's install decision follows the issuance
	_, errB := browser("B", depName(B))
	record("a certificate issued for ANOTHER key is never installed (B)", fmt.Sprintf("issued %d, browser: %v", nB, errB),
		nB >= 1 && errB != nil && strings.Contains(errB.Error(), "certificate"))
	nC := ch.ca.asked(depName(C))
	record("nothing is issued for a guest seen through a MITM (C)", fmt.Sprintf("CSRs sent for C: %d", nC), nC == 0)
	nA3 := ch.ca.asked(depName(ch.deps["A3"]))
	record("nothing is issued for a guest whose attestation names another deployment (A3, copied label)",
		fmt.Sprintf("CSRs sent for A3: %d", nA3), nA3 == 0)
	nE := ch.ca.asked(depName(ch.deps["E"]))
	record("nothing is issued on a route that is not the launched app (E)", fmt.Sprintf("CSRs sent for E: %d", nE), nE == 0)
	_, keysA := ch.ca.stats(depName(A))
	onlyA := len(keysA) > 0
	for _, k := range keysA {
		onlyA = onlyA && k == fmt.Sprint(vA["transportKeySha256"])
	}
	record("every CSR for A was for A's attested key (the key never left the guest)", fmt.Sprintf("%d CSRs", len(keysA)), onlyA)
	first := seen
	var rotated string
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if s, err := browser("A", depName(A)); err == nil && s != first {
			rotated = s
			break
		}
	}
	record("rotation: a new certificate replaces the old before it expires, on the SAME key", fmt.Sprintf("%.40s -> %.40s", first, rotated),
		rotated != "" && strings.SplitN(rotated, " ", 2)[0] == strings.SplitN(first, " ", 2)[0])
	// quiet the relay for the steps that count data-plane admissions: long-lived certificates from here on, and one
	// more renewal to install one
	ch.ca.mu.Lock()
	ch.ca.lifetime = time.Hour
	ch.ca.mu.Unlock()
	for deadline := time.Now().Add(30 * time.Second); time.Now().Before(deadline); time.Sleep(500 * time.Millisecond) {
		if s, err := browser("A", depName(A)); err == nil && s != rotated {
			break
		}
	}

	// 3. the wrong guest, app, key, runtime, measurement: the CLIENT refuses (exit 3 = gate closed, no app traffic)
	wrongRT := filepath.Join(filepath.Dir(ch.l.rtFile), "other-runtime.json")
	other := chainRuntime
	other.Version = "0.0.1-fixture"
	ob, _ := json.Marshal(other)
	_ = os.WriteFile(wrongRT, ob, 0o600)
	for _, c := range []struct {
		step, via, name, want string
		over                  map[string]string
	}{
		{"client expecting A, delivered to B's guest", "B", depName(B), "A", nil},
		{"client pinning another runtime", "A", depName(A), "A", map[string]string{"runtime": wrongRT}},
		{"client pinning another measurement", "A", depName(A), "A", map[string]string{"measurement": ch.l.guestByLabel("B").meas}},
		{"client expecting another app on A's guest", "A", depName(A), "A", map[string]string{"app": ch.apps["B"]}},
	} {
		r := ch.client(c.via, c.name, c.want, c.over)
		record(c.step, fmt.Sprintf("exit=%d verdict=%.60q app_requests_sent=%s", r.code, r.r["VERDICT"], r.r["app_requests_sent"]),
			r.code == 3 && strings.HasPrefix(r.r["VERDICT"], "reject") && r.r["app_requests_sent"] == "0")
	}
	// the host terminates TLS on C's forwarder AFTER guestd verified it: guestd cannot see that (it admits the
	// splice), and the client refuses because the report does not bind the key its handshake saw
	ch.l.guestByLabel("C").mitm.Store(true)
	before := ch.s.Data.Stats()["spliced"]
	r = ch.client("C", depName(C), "C", nil)
	record("a host MITM behind the splice (wrong key)", fmt.Sprintf("exit=%d verdict=%.70q spliced_by_guestd=%d",
		r.code, r.r["VERDICT"], ch.s.Data.Stats()["spliced"]-before),
		r.code == 3 && strings.Contains(r.out, "report_data does not bind") && r.r["app_requests_sent"] == "0")

	// 3b. DEPLOYMENT binding (HOST_DATA). Scope, stated rather than implied: HOST_DATA authenticates the LABEL the host
	// gave the guest at launch. Checked against the deployment id the client chose itself, it detects delivery to
	// another deployment's guest of the same app - the A/E misroute F11 describes. It does NOT prove owner
	// assignment or an approved current instance, and a host that launches a second guest with a copied label is
	// NOT detected (A3 below shows exactly that).
	idA := strings.TrimPrefix(ch.deps["A"], "0x")
	_, va := ch.direct("GET", "/vms/"+ch.inst["A"], nil)
	record("guestd launched A with its deployment id as HOST_DATA", fmt.Sprint(va["hostData"]), va["hostData"] == idA)
	r = ch.clientAtGuest("A", "A", ch.deps["A"])
	record("a client bound to deployment A verifies A's guest", fmt.Sprintf("exit=%d host_data=%.16s…", r.code, r.r["host_data"]),
		r.code == 0 && r.r["host_data"] == idA && r.r["host_data_checked"] == "1")
	r = ch.clientAtGuest("A2", "A", "-")
	record("F11 baseline: WITHOUT the binding, A's client accepts A2 (same app, another deployment)",
		fmt.Sprintf("exit=%d", r.code), r.code == 0 && strings.Contains(r.out, "host_data NOT CHECKED"))
	r = ch.clientAtGuest("A2", "A", ch.deps["A"])
	record("WITH the binding, A's client refuses A2's guest (the A/E misroute)",
		fmt.Sprintf("exit=%d verdict=%.70q app_requests_sent=%s", r.code, r.r["VERDICT"], r.r["app_requests_sent"]),
		r.code == 3 && strings.Contains(r.out, "is not the expected deployment") && r.r["app_requests_sent"] == "0")
	r = ch.clientAtGuest("A3", "A", ch.deps["A"])
	record("NOT CLOSED, by design: a host-launched second guest carrying A's COPIED label is accepted",
		fmt.Sprintf("exit=%d (a genuine instance of the same app, labelled A by the host)", r.code), r.code == 0)
	r = ch.clientAtGuest("A", "A", "0x"+strings.Repeat("a1", 31))
	record("the binding refuses a 31-byte expectation", fmt.Sprintf("exit=%d verdict=%.60q", r.code, r.r["VERDICT"]), r.code == 3)
	// against a guest launched with NO deployment bound (all-zero HOST_DATA): an all-zero expectation must not
	// pass as "equal", and a real expectation must say the guest is unbound
	r = ch.clientAtGuest("L", "A", "0x"+strings.Repeat("00", 32))
	record("an all-zero expectation is refused even against an unbound guest", fmt.Sprintf("exit=%d verdict=%.60q", r.code, r.r["VERDICT"]),
		r.code == 3 && strings.Contains(r.out, "all-zero expected host_data"))
	r = ch.clientAtGuest("L", "A", ch.deps["A"])
	record("a client bound to A refuses an unbound guest", fmt.Sprintf("exit=%d", r.code),
		r.code == 3 && strings.Contains(r.out, "launched with no deployment bound"))

	// 4. routing refused BEFORE any guest: a session for A delivered to B's route; unknown and no SNI
	n0, s0 := ch.nSplices(), ch.s.Data.Stats()["spliced"]
	r = ch.client("B", depName(A), "A", nil)
	record("A's session on B's route (a misrouting relay)", fmt.Sprintf("exit=%d verdict=%.50q", r.code, r.r["VERDICT"]), r.code == 1)
	nosni, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", "127.0.0.1:"+strconv.Itoa(ch.routes["A"]),
		&tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	record("a ClientHello with no SNI", fmt.Sprintf("handshake error=%v", err), err != nil)
	if nosni != nil {
		nosni.Close()
	}
	raw := func(b []byte, hold time.Duration) (int, time.Duration) {
		c, err := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(ch.routes["A"]))
		if err != nil {
			return -1, 0
		}
		defer c.Close()
		t0 := time.Now()
		_, _ = c.Write(b)
		_ = c.SetReadDeadline(time.Now().Add(hold))
		n, _ := io.Copy(io.Discard, c)
		return int(n), time.Since(t0)
	}
	wa, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", "127.0.0.1:"+strconv.Itoa(ch.routes["E"]),
		&tls.Config{ServerName: depName(ch.deps["E"]), InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	record("a route whose instance is not the app the supervisor launched", fmt.Sprintf("handshake error=%v", err), err != nil)
	if wa != nil {
		wa.Close()
	}
	n, _ := raw([]byte("GET /hello HTTP/1.1\r\nHost: "+depName(A)+"\r\n\r\n"), 5*time.Second)
	record("plaintext HTTP on the TLS route", fmt.Sprintf("%d bytes answered", n), n == 0)
	n, _ = raw([]byte{0x16, 0x03, 0x01, 0x4e, 0x20}, 5*time.Second)
	record("a record header claiming 20000 bytes", fmt.Sprintf("%d bytes answered", n), n == 0)
	n, _ = raw([]byte{0x16, 0x03, 0x01, 0x00, 0x08, 0x02, 0, 0, 4, 0, 0, 0, 0}, 5*time.Second)
	record("a handshake record that is not a ClientHello", fmt.Sprintf("%d bytes answered", n), n == 0)
	n, took := raw([]byte{0x16, 0x03, 0x01}, 15*time.Second)
	record("a partial ClientHello, then silence", fmt.Sprintf("%d bytes answered, closed after %v", n, took.Round(100*time.Millisecond)),
		n == 0 && took < 13*time.Second && took > 9*time.Second)
	ch.waitSplices(n0 + 7)
	k := ch.spliceKinds()
	record("the supervisor's refusals, by kind", fmt.Sprint(k),
		k["refused:wrong-name"] >= 1 && k["refused:no-sni"] >= 1 && k["refused:not-tls"] >= 1 && k["refused:oversize"] >= 1 &&
			k["refused:malformed"] >= 1 && k["refused:timeout"] >= 1 && k["refused:wrong-app"] == 1)
	record("none of those reached guestd's data plane", fmt.Sprintf("spliced delta=%d", ch.s.Data.Stats()["spliced"]-s0),
		ch.s.Data.Stats()["spliced"] == s0)

	// 5. no plaintext path to a tier deployment at all
	res, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/x/%s/hello", ch.supPort, A))
	if err == nil {
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()
		record("GET /x/<A>/hello in plaintext", fmt.Sprintf("%d %q", res.StatusCode, strings.TrimSpace(string(body))), res.StatusCode == 421)
	} else {
		record("GET /x/<A>/hello in plaintext", err.Error(), false)
	}
	up, _ := net.Dial("tcp", "127.0.0.1:"+strconv.Itoa(ch.supPort))
	wsKey := make([]byte, 16)
	_, _ = rand.Read(wsKey)
	fmt.Fprintf(up, "GET /x/%s/tcp/80 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n",
		A, base64.StdEncoding.EncodeToString(wsKey))
	st, _ := bufio.NewReader(up).ReadString('\n')
	up.Close()
	record("a tcp bridge upgrade to a tier deployment", strings.TrimSpace(st), strings.HasPrefix(st, "HTTP/1.1 403"))

	// 6. backpressure through every hop: a client that stops reading stops the app's writes
	ga := ch.l.guestByLabel("A")
	tc, err := ch.pinned("A", depName(A), "A")
	if err != nil {
		t.Fatalf("pinned session: %v", err)
	}
	fmt.Fprintf(tc, "GET /stream HTTP/1.1\r\nHost: %s\r\n\r\n", depName(A))
	time.Sleep(1500 * time.Millisecond)
	w1 := ga.streamed.Load()
	time.Sleep(1000 * time.Millisecond)
	w2 := ga.streamed.Load()
	record("a stalled reader stalls the app", fmt.Sprintf("app wrote %d B by 1.5 s and %d B by 2.5 s with nothing read", w1, w2),
		w1 == w2 && w2 > 0 && w2 < 256<<20)
	_ = tc.SetReadDeadline(time.Now().Add(10 * time.Second))
	got, _ := io.CopyN(io.Discard, tc, 64<<20)
	record("... and resumes when it reads", fmt.Sprintf("read %d B; app now at %d B", got, ga.streamed.Load()),
		got == 64<<20 && ga.streamed.Load() > w2)

	// 7. the client leaving ends the guest's side too
	ended := ga.streamsEnded.Load()
	tc.Close()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline) && ga.streamsEnded.Load() == ended; {
		time.Sleep(20 * time.Millisecond)
	}
	record("a client disconnect reaches the app", fmt.Sprintf("app streams ended %d -> %d", ended, ga.streamsEnded.Load()),
		ga.streamsEnded.Load() == ended+1)

	// 8. idle: a verified session with nothing moving is closed by guestd's bound (4 s here), not held forever
	ic, err := ch.pinned("A", depName(A), "A")
	if err == nil {
		t0 := time.Now()
		_ = ic.SetReadDeadline(time.Now().Add(15 * time.Second))
		_, rerr := ic.Read(make([]byte, 1))
		el := time.Since(t0)
		record("an idle session is closed", fmt.Sprintf("closed after %v (%v)", el.Round(100*time.Millisecond), rerr),
			rerr != nil && !isTimeout(rerr) && el >= 3*time.Second && el < 10*time.Second)
		ic.Close()
	} else {
		record("an idle session is closed", err.Error(), false)
	}

	// 9. the app stops (owner stop / lease end, through guestd): its live session ends, new ones are refused, and
	// the other tenant is untouched
	sc, err := ch.pinned("A", depName(A), "A")
	if err != nil {
		t.Fatalf("pinned session: %v", err)
	}
	fmt.Fprintf(sc, "GET /stream HTTP/1.1\r\nHost: %s\r\n\r\n", depName(A))
	_, _ = io.CopyN(io.Discard, sc, 1<<20)
	if code, _ := ch.direct("DELETE", "/vms/"+ch.inst["A"], nil); code != 200 {
		t.Fatalf("stop A: %d", code)
	}
	t0 := time.Now()
	_ = sc.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, rerr := io.Copy(io.Discard, sc)
	el := time.Since(t0)
	record("stopping A ends A's live session", fmt.Sprintf("ended after %v (%v)", el.Round(10*time.Millisecond), rerr),
		el < 3*time.Second && !isTimeout(rerr))
	r = ch.client("A", depName(A), "A", nil)
	record("a new client of the stopped A", fmt.Sprintf("exit=%d verdict=%.40q", r.code, r.r["VERDICT"]), r.code == 1)
	r = ch.client("B", depName(B), "B", nil)
	record("B is still verified and served", fmt.Sprintf("exit=%d body=%s", r.code, r.r["app_body"]),
		r.code == 0 && r.r["app_body"] == `"app B"`)

	ch.waitSplices(ch.nSplices())
	t.Logf("supervisor splice outcomes: %v", ch.spliceKinds())
	t.Logf("guestd data-plane outcomes: %v", ch.s.Data.Stats())
	fails := 0
	for _, v := range tally {
		if strings.HasPrefix(v, "FAIL") {
			fails++
		}
	}
	t.Logf("SUMMARY %d steps, %d failed", len(tally), fails)
}
