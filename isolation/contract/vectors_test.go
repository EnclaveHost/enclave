// Conformance: the properties every backend must hold, and the vectors that pin them. `go test`
// checks this package against vectors.json; `go test -update` regenerates it from this package. Other
// implementations (windows/vbslike/host, `vbslike-host vectors`) read the same file, so a divergence
// between backends is a failing test rather than a discovery in production.
package contract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite vectors.json from this implementation")

type bundleVector struct {
	Name        string    `json:"name"`
	Manifest    *Manifest `json:"manifest,omitempty"`
	ArtifactHex string    `json:"artifact_hex"`
	BundleHex   string    `json:"bundle_hex"`
	AppID       string    `json:"app_id"`
	Bare        bool      `json:"bare,omitempty"`
	Parses      bool      `json:"parses"`
	Note        string    `json:"note,omitempty"`
}

type bindVector struct {
	SpkiHex    string `json:"spki_hex"`
	NonceHex   string `json:"nonce_hex"`
	Bind       string `json:"bind"`
	AppID      string `json:"app_id"`
	ReportData string `json:"report_data"`
}

type requestVector struct {
	JSON string `json:"json"`
	OK   bool   `json:"ok"`
	Bind string `json:"bind,omitempty"`
	Note string `json:"note,omitempty"`
}

type lifecycleVector struct {
	Name    string   `json:"name"`
	Ops     []string `json:"ops"`
	Results []string `json:"results"`
	Final   string   `json:"final"`
}

type runtimeVector struct {
	Identity  RuntimeIdentity `json:"identity"`
	Valid     bool            `json:"valid"`
	RuntimeID string          `json:"runtime_id,omitempty"`
	Bind2     string          `json:"bind2,omitempty"`     // with the bind vector's spki and nonce
	CacheKey  string          `json:"cache_key,omitempty"` // with the reference bundle's app id
	Note      string          `json:"note,omitempty"`
}

type vectors struct {
	ABI            string            `json:"abi"`
	ABI2           string            `json:"abi2"`
	Bundles        []bundleVector    `json:"bundles"`
	Bind           []bindVector      `json:"bind"`
	ReportRequests []requestVector   `json:"report_requests"`
	Lifecycle      []lifecycleVector `json:"lifecycle"`
	Runtime        []runtimeVector   `json:"runtime"`
}

func fixedBytes(n int, seed byte) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7+int(seed)) ^ seed
	}
	return b
}

func mustBuild(t *testing.T, m Manifest, art []byte) []byte {
	t.Helper()
	b, err := Build(m, art)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// runLifecycle executes an op script and returns what each op reported, plus the final state.
func runLifecycle(ops []string) ([]string, string) {
	l := NewLifecycle(Starting)
	var out []string
	for _, op := range ops {
		switch {
		case strings.HasPrefix(op, "request_end:"):
			out = append(out, fmt.Sprintf("end:%v", l.RequestEnd(strings.TrimPrefix(op, "request_end:"))))
		case op == "finish_start":
			out = append(out, "start:"+l.FinishStart())
		case op == "fail_start":
			l.FailStart()
			out = append(out, "fail")
		case op == "reclaim":
			l.Reclaim(func() {})
			out = append(out, fmt.Sprintf("reclaim:%d", l.Reclaims()))
		case strings.HasPrefix(op, "state"):
			out = append(out, "state:"+l.State().String())
		default:
			out = append(out, "unknown-op")
		}
	}
	return out, l.State().String()
}

func generate(t *testing.T) vectors {
	art := fixedBytes(300, 1)
	art2 := fixedBytes(300, 2)
	mA := Manifest{ABI: ABI, Label: "A", World: "wasi:http", Artifact: Artifact{Kind: "wasm-component"}, Policy: Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}
	mB := mA
	mB.Label = "B"
	mP := mA
	mP.Policy.MemMiB = 512
	v := vectors{ABI: ABI, ABI2: ABI2}
	add := func(name string, m *Manifest, artb, bundle []byte, bare, parses bool, note string) {
		v.Bundles = append(v.Bundles, bundleVector{Name: name, Manifest: m, ArtifactHex: hex.EncodeToString(artb), BundleHex: hex.EncodeToString(bundle),
			AppID: hex.EncodeToString(func() []byte { s := AppID(bundle); return s[:] }()), Bare: bare, Parses: parses, Note: note})
	}
	bA := mustBuild(t, mA, art)
	pm, _, err := Parse(bA)
	if err != nil {
		t.Fatal(err)
	}
	add("A", &pm, art, bA, false, true, "the reference bundle")
	add("A-again", &pm, art, mustBuild(t, mA, art), false, true, "same manifest, same bytes: the same ID")
	pmB, _, _ := Parse(mustBuild(t, mB, art))
	add("A-other-label", &pmB, art, mustBuild(t, mB, art), false, true, "same bytes, a different manifest: a different ID")
	pmP, _, _ := Parse(mustBuild(t, mP, art))
	add("A-other-policy", &pmP, art, mustBuild(t, mP, art), false, true, "same bytes, a different share: a different ID (policy is identity)")
	pm2, _, _ := Parse(mustBuild(t, mA, art2))
	add("A-other-bytes", &pm2, art2, mustBuild(t, mA, art2), false, true, "same manifest, different bytes: a different ID")
	add("bare", nil, art, art, true, false, "a bare artifact: no manifest, ID = sha256(bytes); Parse says ErrNotBundle")
	// non-canonical manifest: the same fields with whitespace and a different key order
	canon, _ := Canonical(mA)
	nc := bytes.ReplaceAll(canon, []byte(","), []byte(", "))
	bad := append([]byte(BundleMagic), byte(len(nc)), byte(len(nc)>>8), 0, 0)
	bad = append(bad, nc...)
	bad = append(bad, byte(len(art)), byte(len(art)>>8), 0, 0)
	bad = append(bad, art...)
	add("non-canonical-manifest", nil, art, bad, false, false, "whitespace in the manifest: refused, so one content has one byte form")
	// a manifest naming another artifact's hash
	mLie := mA
	lie := mustBuild(t, mLie, art)
	lie = bytes.Replace(lie, []byte(pm.Artifact.Sha256), []byte(pm2.Artifact.Sha256), 1)
	add("artifact-hash-mismatch", nil, art, lie, false, false, "the manifest names a different artifact than the bundle carries: refused")
	// a bundle whose manifest names a host-specific artifact kind: canonical, hash correct, refused all the same
	mNative := mA
	mNative.Artifact.Kind = "cwasm-x86_64"
	nsum := sha256.Sum256(art)
	mNative.Artifact.Sha256 = hex.EncodeToString(nsum[:])
	ncanon, _ := Canonical(mNative)
	native := append([]byte(BundleMagic), byte(len(ncanon)), byte(len(ncanon)>>8), 0, 0)
	native = append(native, ncanon...)
	native = append(native, byte(len(art)), byte(len(art)>>8), 0, 0)
	native = append(native, art...)
	add("native-kind-refused", nil, art, native, false, false, "a precompiled or native artifact kind is not part of the contract: refused even when otherwise well-formed")

	spki := fixedBytes(91, 9)
	nonce := fixedBytes(32, 5)
	bind, _ := Bind(spki, nonce)
	rd := ReportData(bind, AppID(bA))
	v.Bind = []bindVector{{SpkiHex: hex.EncodeToString(spki), NonceHex: hex.EncodeToString(nonce), Bind: hex.EncodeToString(bind[:]), AppID: hex.EncodeToString(func() []byte { s := AppID(bA); return s[:] }()), ReportData: hex.EncodeToString(rd[:])}}

	bh := hex.EncodeToString(bind[:])
	v.ReportRequests = []requestVector{
		{JSON: fmt.Sprintf(`{"bind":"%s"}`, bh), OK: true, Bind: bh, Note: "the whole request"},
		{JSON: fmt.Sprintf(`{"bind":"%s","appSha256":"%s","id":99,"label":"other"}`, bh, strings.Repeat("ff", 32)), OK: true, Bind: bh, Note: "extra fields naming another app and id are not read"},
		{JSON: fmt.Sprintf(`{"bind":"%s"}`, bh[:60]), OK: false, Note: "30 bytes"},
		{JSON: `{"bind":"zz"}`, OK: false, Note: "not hex"},
		{JSON: `{"appSha256":"` + strings.Repeat("ff", 32) + `"}`, OK: false, Note: "no bind at all"},
		{JSON: `not json`, OK: false},
	}

	// runtime identities: the reference, the same on ARM64 (a Pixel pVM), a different feature policy, a
	// different version, and the ones the contract refuses
	ref := RuntimeIdentity{Name: "wasmtime", Version: "48.0.1", TargetISA: ISAx86_64, CPUFeatures: "baseline", WX: WXEnforced, Cache: CacheNone}
	arm := ref
	arm.TargetISA = ISAaarch64
	feat := ref
	feat.CPUFeatures = "+sse4.2,+avx2"
	ver := ref
	ver.Version = "49.0.0"
	noWX := ref
	noWX.WX = "best-effort"
	badCache := ref
	badCache.Cache = "unauthenticated"
	badISA := ref
	badISA.TargetISA = "riscv64"
	appRef := AppID(bA)
	for _, c := range []struct {
		id   RuntimeIdentity
		note string
	}{{ref, "the reference: wasmtime 48.0.1 on x86_64, baseline features, W^X enforced, no cache"},
		{arm, "the same runtime emitting ARM64 inside a Pixel pVM: a different runtime ID"},
		{feat, "a different CPU-feature policy: a different runtime ID"},
		{ver, "a different runtime version: a different runtime ID"},
		{noWX, "W^X not stated as enforced: refused"},
		{badCache, "an unauthenticated cache: refused"},
		{badISA, "an ISA the contract does not name: refused"}} {
		rv := runtimeVector{Identity: c.id, Note: c.note}
		if rid, err := RuntimeID(c.id); err == nil {
			rv.Valid = true
			rv.RuntimeID = hex.EncodeToString(rid[:])
			b2, _ := Bind2(spki, nonce, rid)
			rv.Bind2 = hex.EncodeToString(b2[:])
			ck := CacheKey(appRef, rid)
			rv.CacheKey = hex.EncodeToString(ck[:])
		}
		v.Runtime = append(v.Runtime, rv)
	}

	scripts := []lifecycleVector{
		{Name: "normal life: start, destroy, reclaim once; a later crash changes nothing", Ops: []string{"finish_start", "state", "request_end:destroyed", "reclaim", "request_end:crashed", "reclaim", "state"}},
		{Name: "destroy during startup is deferred to startup, which honours it", Ops: []string{"request_end:destroyed", "state", "finish_start", "request_end:destroyed", "reclaim", "state"}},
		{Name: "the first end request during startup is the one kept", Ops: []string{"request_end:crashed", "request_end:destroyed", "finish_start", "request_end:x", "reclaim"}},
		{Name: "a failed start goes straight to ending, and finish_start never resurrects an ended domain", Ops: []string{"fail_start", "state", "reclaim", "state", "finish_start", "state"}},
		{Name: "reclamation runs once however often it is asked", Ops: []string{"finish_start", "request_end:a", "reclaim", "reclaim", "request_end:b", "reclaim", "state"}},
	}
	for i := range scripts {
		scripts[i].Results, scripts[i].Final = runLifecycle(scripts[i].Ops)
	}
	v.Lifecycle = scripts
	return v
}

func TestVectors(t *testing.T) {
	got := generate(t)
	if *update {
		b, _ := json.MarshalIndent(got, "", " ")
		if err := os.WriteFile("vectors.json", append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Log("vectors.json rewritten")
	}
	raw, err := os.ReadFile("vectors.json")
	if err != nil {
		t.Fatalf("vectors.json: %v (run with -update to create it)", err)
	}
	var want vectors
	if err := json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		gb, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("this implementation disagrees with vectors.json; diff the file against:\n%s", gb)
	}
	// and every recorded vector is re-checked through the public API, not just re-generated
	for _, b := range want.Bundles {
		bundle, _ := hex.DecodeString(b.BundleHex)
		id := AppID(bundle)
		if hex.EncodeToString(id[:]) != b.AppID {
			t.Errorf("%s: app id", b.Name)
		}
		m, art, err := Parse(bundle)
		if b.Parses != (err == nil) {
			t.Errorf("%s: parses=%v err=%v", b.Name, b.Parses, err)
		}
		if err == nil {
			if hex.EncodeToString(art) != b.ArtifactHex || !reflect.DeepEqual(&m, b.Manifest) {
				t.Errorf("%s: parsed manifest/artifact differ", b.Name)
			}
		}
	}
	for _, r := range want.ReportRequests {
		bind, err := ParseReportRequest([]byte(r.JSON))
		if r.OK != (err == nil) || (r.OK && hex.EncodeToString(bind[:]) != r.Bind) {
			t.Errorf("request %q: ok=%v err=%v", r.JSON, r.OK, err)
		}
	}
	// the runtime identities: validity, digest, binding and cache key re-derived through the public API
	spkiV, _ := hex.DecodeString(want.Bind[0].SpkiHex)
	nonceV, _ := hex.DecodeString(want.Bind[0].NonceHex)
	var appV [32]byte
	ab, _ := hex.DecodeString(want.Bundles[0].AppID)
	copy(appV[:], ab)
	for _, r := range want.Runtime {
		rid, err := RuntimeID(r.Identity)
		if r.Valid != (err == nil) {
			t.Errorf("runtime %q: valid=%v err=%v", r.Note, r.Valid, err)
			continue
		}
		if !r.Valid {
			continue
		}
		if hex.EncodeToString(rid[:]) != r.RuntimeID {
			t.Errorf("runtime %q: id", r.Note)
		}
		b2, _ := Bind2(spkiV, nonceV, rid)
		if hex.EncodeToString(b2[:]) != r.Bind2 {
			t.Errorf("runtime %q: bind2", r.Note)
		}
		if ck := CacheKey(appV, rid); hex.EncodeToString(ck[:]) != r.CacheKey {
			t.Errorf("runtime %q: cache key", r.Note)
		}
	}
	ids := map[string]bool{}
	for _, r := range want.Runtime {
		if r.Valid {
			if ids[r.RuntimeID] {
				t.Errorf("two admissible identities share a runtime ID: %s", r.Note)
			}
			ids[r.RuntimeID] = true
		}
	}
}

func TestProperties(t *testing.T) {
	art := fixedBytes(64, 3)
	m := Manifest{ABI: ABI, Label: "x", Artifact: Artifact{Kind: "wasm-component"}, Policy: Policy{CPUPercent: 50, MemMiB: 128, Vcpus: 1}}
	a, _ := Build(m, art)
	b, _ := Build(m, art)
	if AppID(a) != AppID(b) {
		t.Fatal("same bundle, different id")
	}
	m2 := m
	m2.Label = "y"
	c, _ := Build(m2, art)
	if AppID(a) == AppID(c) {
		t.Fatal("different manifest, same id")
	}
	d, _ := Build(m, fixedBytes(64, 4))
	if AppID(a) == AppID(d) {
		t.Fatal("different bytes, same id")
	}
	if AppID(art) != sha256.Sum256(art) {
		t.Fatal("bare id")
	}
	if _, _, err := Parse(art); err != ErrNotBundle {
		t.Fatal("bare bytes must not parse as a bundle")
	}
	// the artifact is the portable component, compiled inside the domain; Build refuses anything else
	mNative := m
	mNative.Artifact.Kind = "cwasm-x86_64"
	if _, err := Build(mNative, art); err == nil {
		t.Fatal("a native artifact kind must be refused at build time")
	}
	mBlank := m
	mBlank.Artifact.Kind = ""
	if b, err := Build(mBlank, art); err != nil {
		t.Fatal(err)
	} else if pm, _, err := Parse(b); err != nil || pm.Artifact.Kind != KindWasmComponent {
		t.Fatal("an unset kind defaults to the component")
	}
	// the request has no field for the app: a caller naming another gets its own binding back, only
	bind, err := ParseReportRequest([]byte(`{"bind":"` + strings.Repeat("11", 32) + `","appSha256":"` + strings.Repeat("ff", 32) + `"}`))
	if err != nil || bind != [32]byte(bytes.Repeat([]byte{0x11}, 32)) {
		t.Fatal("extra fields must be ignored and the binding kept")
	}
	if _, err := Bind(nil, make([]byte, 31)); err == nil {
		t.Fatal("a 31-byte nonce must be refused")
	}
	// policy: the manifest wins; a bare artifact takes the request's numbers; defaults otherwise
	if p := EffectivePolicy(&m, Request{CPU: 10, MemMiB: 10}); p.CPUPercent != 50 || p.MemMiB != 128 {
		t.Fatal("manifest policy must win")
	}
	if p := EffectivePolicy(nil, Request{CPU: 10, MemMiB: 10}); p.CPUPercent != 10 || p.MemMiB != 10 || p.Vcpus != 1 {
		t.Fatal("request policy for a bare artifact")
	}
	if p := EffectivePolicy(nil, Request{}); p.CPUPercent != 100 || p.MemMiB != 256 {
		t.Fatal("defaults")
	}
	// Bind2 differs from Bind for the same key and nonce, and changes with the runtime identity
	ref := RuntimeIdentity{Name: "wasmtime", Version: "48.0.1", TargetISA: ISAx86_64, CPUFeatures: "baseline", WX: WXEnforced, Cache: CacheNone}
	rid, err := RuntimeID(ref)
	if err != nil {
		t.Fatal(err)
	}
	spki, nonce := fixedBytes(91, 9), fixedBytes(32, 5)
	b1, _ := Bind(spki, nonce)
	b2, _ := Bind2(spki, nonce, rid)
	if b1 == b2 {
		t.Fatal("Bind2 must differ from Bind")
	}
	other := ref
	other.CPUFeatures = "+avx512f"
	rid2, _ := RuntimeID(other)
	b3, _ := Bind2(spki, nonce, rid2)
	if b2 == b3 {
		t.Fatal("a different CPU-feature policy must change the binding")
	}
	if _, err := Bind2(spki, make([]byte, 31), rid); err == nil {
		t.Fatal("a 31-byte nonce must be refused by Bind2")
	}
	if CacheKey(AppID(a), rid) == CacheKey(AppID(a), rid2) {
		t.Fatal("the cache key must change with the runtime identity")
	}
}
