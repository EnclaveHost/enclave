package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

type fake struct {
	mu          sync.Mutex
	builds      int
	stops       map[string]int
	alive       map[string]bool
	verifyErr   error
	startGate   chan struct{} // when set, Start blocks until it is closed
	stopGate    chan struct{} // when set, Stop blocks until it is closed (a unit that takes its time to stop)
	startArgs   [3]int
	fwdPort     func(workdir string) int // when set, where each guest's forwarder listens (the data-plane tests)
	hostData    []string                 // the HOST_DATA each Start was given, in order
	keyOverride string                   // when set, Verify reports this key (a different guest answering)
	serial      string                   // when set, Start writes it as the guest's serial console
	verifyHD    []string                 // the host data each Verify was asked to require
}

func newFake() *fake { return &fake{stops: map[string]int{}, alive: map[string]bool{}} }

func (f *fake) Build(ctx context.Context, bundle, workdir string, vcpus int) (string, string, error) {
	f.mu.Lock()
	f.builds++
	f.mu.Unlock()
	if _, err := os.Stat(bundle); err != nil {
		return "", "", err
	}
	return filepath.Join(workdir, "guest.cpio.gz"), "ab" + hex.EncodeToString(make([]byte, 47)), nil
}
func (f *fake) Start(ctx context.Context, image, tag, workdir string, vcpus, mem, cpu int, hostData string) (string, uint32, error) {
	if f.startGate != nil {
		<-f.startGate
	}
	f.mu.Lock()
	f.alive["unit-"+tag] = true
	if f.serial != "" {
		_ = os.WriteFile(filepath.Join(workdir, tag+".serial"), []byte(f.serial), 0o600)
	}
	f.startArgs = [3]int{vcpus, mem, cpu}
	f.hostData = append(f.hostData, hostData)
	f.mu.Unlock()
	return "unit-" + tag, 99, nil
}
func (f *fake) Forward(ctx context.Context, cid uint32, workdir string) (int, func(), error) {
	if f.fwdPort != nil {
		return f.fwdPort(workdir), func() {}, nil
	}
	return 4443, func() {}, nil
}
func (f *fake) Verify(ctx context.Context, port int, m, id, hostData, workdir string) (string, string, error) {
	f.mu.Lock()
	f.verifyHD = append(f.verifyHD, hostData)
	f.mu.Unlock()
	if f.verifyErr != nil {
		return "", "", f.verifyErr
	}
	if f.keyOverride != "" {
		return "attested", f.keyOverride, nil
	}
	return "attested", fakeKeySha, nil
}

var fakeKeySha = hex.EncodeToString(bytes.Repeat([]byte{0x6b}, 32))

// testBudget is a pool no test outside pool_test.go comes near: 64 GiB and 16 cores.
var testBudget = poolBudget{MemMiB: 64 << 10, CPUPct: 1600}

func (f *fake) Alive(unit string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.alive[unit] }
func (f *fake) Stop(tag, workdir string) error {
	if f.stopGate != nil {
		<-f.stopGate
	}
	f.mu.Lock()
	f.stops[tag]++
	f.alive["unit-"+tag] = false
	f.mu.Unlock()
	return nil
}
func (f *fake) Sweep(keep map[string]bool) ([]string, error) { return nil, nil }
func (f *fake) stopsOf(tag string) int                       { f.mu.Lock(); defer f.mu.Unlock(); return f.stops[tag] }

type rig struct {
	t     *testing.T
	s     *server
	f     *fake
	ts    *httptest.Server
	dir   string
	clock time.Time
	mu    sync.Mutex
}

func newRig(t *testing.T) *rig {
	r := &rig{t: t, f: newFake(), dir: t.TempDir(), clock: time.Unix(1_800_000_000, 0)}
	r.s = newServer(r.f, filepath.Join(r.dir, "root"))
	r.s.Budget = testBudget // room for every guest a test starts; pool_test.go sets its own
	r.s.Now = func() time.Time { r.mu.Lock(); defer r.mu.Unlock(); return r.clock }
	r.ts = httptest.NewServer(r.s)
	t.Cleanup(r.ts.Close)
	return r
}

func (r *rig) advance(d time.Duration) { r.mu.Lock(); r.clock = r.clock.Add(d); r.mu.Unlock() }

// bundle writes a real contract bundle and returns its path and AppID.
func (r *rig) bundle(label string, pol contract.Policy) (string, string) {
	b, err := contract.Build(contract.Manifest{Label: label, Policy: pol}, []byte("\x00asm component "+label))
	if err != nil {
		r.t.Fatal(err)
	}
	p := filepath.Join(r.dir, label+".bundle")
	if err := os.WriteFile(p, b, 0o600); err != nil {
		r.t.Fatal(err)
	}
	s := sha256.Sum256(b)
	return p, hex.EncodeToString(s[:])
}

func (r *rig) do(method, path string, body any) (int, map[string]any) {
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, r.ts.URL+path, rd)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer res.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(res.Body).Decode(&m)
	return res.StatusCode, m
}

func (r *rig) create(name, path string) (int, map[string]any) {
	// the body the supervisor actually sends for a CPU tenant
	return r.do("POST", "/vms", map[string]any{"image": "file://" + path, "name": name, "cpuShare": 0.25,
		"gpuShare": 0, "gpuTflops": 0, "cpuGflops": 12, "cpuTflops": 0.012, "appPort": 8080, "ports": []any{},
		"config": "", "configCid": "", "egress": ""})
}

func TestRefusesEveryFeatureItCannotHonourInsideTheGuest(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	base := map[string]any{"image": "file://" + p, "name": "0xa"}
	cases := map[string]any{"gpuShare": 0.5, "shielded": map[string]any{"x": 1},
		"secrets": map[string]any{"K": "v"}, "egress": "socks5://x", "config": "{}", "configCid": "bafy",
		"ports": []any{map[string]any{"proto": "tcp", "port": 5432}}}
	for k, v := range cases {
		b := map[string]any{}
		for bk, bv := range base {
			b[bk] = bv
		}
		b[k] = v
		code, body := r.do("POST", "/vms", b)
		if code != 422 {
			t.Errorf("%s: got %d %v, want 422", k, code, body)
		}
	}
	if code, body := r.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": "0xa", "volumes": []any{}}); code != 400 {
		t.Errorf("an unknown field must be refused, not dropped: %d %v", code, body)
	}
	if _, list := r.do("GET", "/vms", nil); len(list["vms"].([]any)) != 0 || r.f.builds != 0 {
		t.Fatalf("a refused request created something: %v builds=%d", list, r.f.builds)
	}
}

func TestRefusesAnythingWithoutAContractIdentity(t *testing.T) {
	r := newRig(t)
	bare := filepath.Join(r.dir, "bare.wasm")
	_ = os.WriteFile(bare, []byte("\x00asm bare"), 0o600)
	good, _ := r.bundle("A", contract.Policy{})
	raw, _ := os.ReadFile(good)
	bad := filepath.Join(r.dir, "bad.bundle")
	_ = os.WriteFile(bad, append(raw, 0), 0o600) // one trailing byte: Parse refuses
	for name, img := range map[string]string{"ipfs": "ipfs://bafyexample", "relative": "file://x.bundle",
		"bare component": "file://" + bare, "malformed bundle": "file://" + bad} {
		code, body := r.do("POST", "/vms", map[string]any{"image": img, "name": "0x" + name})
		if code != 422 {
			t.Errorf("%s: got %d %v, want 422", name, code, body)
		}
	}
}

func TestAGuestIsRunningOnlyOnceAttestedAsThisApp(t *testing.T) {
	r := newRig(t)
	p, appID := r.bundle("A", contract.Policy{CPUPercent: 50, MemMiB: 900, Vcpus: 2})
	code, body := r.create("0xa", p)
	if code != 201 || body["status"] != "starting" || body["id"] == "" {
		t.Fatalf("create: %d %v", code, body)
	}
	r.s.launching.Wait()
	id := body["id"].(string)
	code, got := r.do("GET", "/vms/"+id, nil)
	if code != 200 || got["status"] != "running" || got["appId"] != appID || got["verdict"] != "attested" {
		t.Fatalf("after launch: %d %v", code, got)
	}
	// the bundle's policy is the guest's shape (contract.EffectivePolicy), with the memory floor for the kernel
	if r.f.startArgs != [3]int{2, 1284, 50} {
		t.Fatalf("guest shape %v, want vcpus 2, mem 900+384, cpu 50", r.f.startArgs)
	}
	_, list := r.do("GET", "/vms", nil)
	v := list["vms"].([]any)[0].(map[string]any)
	for _, k := range []string{"id", "name", "createdAt", "status"} {
		if v[k] == nil {
			t.Errorf("GET /vms lacks %q, which the supervisor's orphan plan needs", k)
		}
	}
	if code, _ := r.create("0xa", p); code != 409 {
		t.Fatalf("a second live instance for one deployment: %d", code)
	}
}

func TestAFailedAttestationIsFailedAndAlreadyReclaimed(t *testing.T) {
	r := newRig(t)
	r.f.verifyErr = errors.New("VERDICT reject reason=\"measurement\"")
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	_, got := r.do("GET", "/vms/"+id, nil)
	if got["status"] != "failed" || got["error"] == nil {
		t.Fatalf("want failed with a reason: %v", got)
	}
	if r.f.stopsOf(id) != 1 {
		t.Fatalf("a guest that did not attest must be torn down at once: stops=%d", r.f.stopsOf(id))
	}
	if _, err := os.Stat(filepath.Join(r.s.Root, id)); !os.IsNotExist(err) {
		t.Fatalf("the tenant's workdir survived: %v", err)
	}
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 200 {
		t.Fatalf("deleting a failed instance: %d", code)
	}
	if r.f.stopsOf(id) != 1 {
		t.Fatalf("reclamation ran twice: %d", r.f.stopsOf(id))
	}
}

func TestADeleteDuringStartupIsHonouredWhenStartupFinishes(t *testing.T) {
	r := newRig(t)
	r.f.startGate = make(chan struct{})
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	id := body["id"].(string)
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 202 {
		t.Fatalf("a delete during startup is deferred, not confirmed: %d", code)
	}
	close(r.f.startGate)
	r.s.launching.Wait()
	if code, got := r.do("GET", "/vms/"+id, nil); code != 404 {
		t.Fatalf("the deferred delete was not honoured: %d %v", code, got)
	}
	if r.f.stopsOf(id) != 1 {
		t.Fatalf("stops=%d, want exactly one", r.f.stopsOf(id))
	}
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 404 {
		t.Fatal("the supervisor's retry must read the stop as confirmed (404)")
	}
}

func TestDeleteIsConfirmedOnceAndReclaimsOnce(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 404 {
		t.Fatalf("second delete: %d", code)
	}
	if r.f.stopsOf(id) != 1 {
		t.Fatalf("stops=%d", r.f.stopsOf(id))
	}
}

func TestAGuestThatDiesIsReportedFailed(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	r.f.mu.Lock()
	r.f.alive["unit-"+id] = false
	r.f.mu.Unlock()
	r.s.tick()
	_, got := r.do("GET", "/vms/"+id, nil)
	if got["status"] != "failed" {
		t.Fatalf("instanceAlive must see the death: %v", got)
	}
	if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 200 || r.f.stopsOf(id) != 1 {
		t.Fatalf("delete after death: code=%d stops=%d", code, r.f.stopsOf(id))
	}
}

func TestTheLeaseIsInertUntilTheSupervisorSpeaks(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	r.advance(time.Hour)
	r.s.tick()
	if code, _ := r.do("GET", "/vms/"+id, nil); code != 200 || r.f.stopsOf(id) != 0 {
		t.Fatal("reaped with no heartbeat ever heard: a supervisor that predates leases would lose every tenant")
	}
}

func TestAnUnvouchedTenantIsReapedWhenItsLeaseLapsesAndNotBefore(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	// the supervisor speaks, and vouches for someone else
	r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xother"}})
	r.advance(r.s.LeaseTTL - time.Second)
	r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xother"}})
	r.s.tick()
	if code, _ := r.do("GET", "/vms/"+id, nil); code != 200 {
		t.Fatal("reaped before its lease lapsed")
	}
	r.advance(2 * time.Second)
	r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xother"}})
	r.s.tick()
	if code, _ := r.do("GET", "/vms/"+id, nil); code != 404 || r.f.stopsOf(id) != 1 {
		t.Fatalf("an unvouched tenant with a lapsed lease must be reaped once: code=%d stops=%d", code, r.f.stopsOf(id))
	}
}

func TestAVouchedTenantIsKept(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	for i := 0; i < 5; i++ {
		_, got := r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xa"}})
		if len(got["extended"].([]any)) != 1 {
			t.Fatalf("the vouched tenant was not extended: %v", got)
		}
		r.advance(r.s.LeaseTTL - time.Second)
		r.s.tick()
	}
	if code, _ := r.do("GET", "/vms/"+id, nil); code != 200 {
		t.Fatal("a vouched tenant was reaped")
	}
}

func TestSilenceIsNotEvidenceAboutATenant(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0xa", p)
	r.s.launching.Wait()
	id := body["id"].(string)
	r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xa"}})
	r.advance(r.s.Silence + r.s.LeaseTTL + time.Minute) // the supervisor went quiet
	r.s.tick()
	if code, _ := r.do("GET", "/vms/"+id, nil); code != 200 {
		t.Fatal("a quiet control channel reaped a serving tenant")
	}
}

func TestHealthStatesWhatATenantDoesNotGet(t *testing.T) {
	r := newRig(t)
	_, h := r.do("GET", "/health", nil)
	sup := h["supports"].(map[string]any)
	for _, k := range []string{"gpu", "secrets", "egress", "config", "ports", "configCid"} {
		if sup[k] != false {
			t.Errorf("health must state %s=false so a claim gate can refuse such deployments", k)
		}
	}
}

// A deployment-named instance is launched with its deployment id as HOST_DATA and verified against it; a lab name
// gets none. The raw 32 bytes (as hex), not a hash, so a verifier compares bytes it already holds.
func TestHostDataIsTheDeploymentID(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	dep := "0x" + strings.Repeat("Ab", 32)
	code, body := r.create(dep, p)
	if code != 201 {
		t.Fatalf("create: %d %v", code, body)
	}
	lab := "0xa"
	if code, body := r.create(lab, p); code != 201 {
		t.Fatalf("create lab: %d %v", code, body)
	}
	r.s.launching.Wait()
	want := strings.Repeat("ab", 32)
	r.f.mu.Lock()
	starts, verifies := append([]string{}, r.f.hostData...), append([]string{}, r.f.verifyHD...)
	r.f.mu.Unlock()
	got := map[string]bool{}
	for _, h := range starts {
		got[h] = true
	}
	if !got[want] || !got[""] || len(starts) != 2 {
		t.Fatalf("Start was given %q; want the deployment's id once and nothing for the lab name", starts)
	}
	if fmt.Sprint(verifies) != fmt.Sprint(starts) {
		t.Fatalf("Verify must require what Start launched with: starts %q, verifies %q", starts, verifies)
	}
	_, v := r.do("GET", "/vms/"+body["id"].(string), nil)
	if v["hostData"] != want {
		t.Fatalf("the instance view: %v", v["hostData"])
	}
	// the REAL launcher's judge command line carries the requirement exactly when there is one
	rl := &realLauncher{m2: "/m2"}
	if a := strings.Join(rl.verifyArgs(1, "m", "a", want, "/w"), " "); !strings.HasSuffix(a, " --host-data "+want) {
		t.Errorf("the real verifier does not require HOST_DATA: %s", a)
	}
	if a := strings.Join(rl.verifyArgs(1, "m", "a", "", "/w"), " "); strings.Contains(a, "--host-data") {
		t.Errorf("a lab launch must not demand HOST_DATA: %s", a)
	}
	for name, hd := range map[string]string{dep: want, "0x" + strings.Repeat("ab", 31): "", "smoke": "", strings.Repeat("ab", 32): ""} {
		if got := hostDataFor(name); got != hd {
			t.Errorf("hostDataFor(%q) = %q, want %q", name, got, hd)
		}
	}
}
