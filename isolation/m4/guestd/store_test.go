package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base32"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"enclave.host/isolation/contract"
)

var preamble = []byte{0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00}

func component(label string) []byte {
	return append(append([]byte{}, preamble...), []byte("component "+label)...)
}

// rawCID is the CIDv1 (raw codec, sha2-256) of bytes, base32 - what `ipfs add --cid-version=1` gives a small file.
func rawCID(b []byte) string {
	s := sha256.Sum256(b)
	return "b" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).
		EncodeToString(append([]byte{0x01, 0x55, 0x12, 0x20}, s[:]...)))
}

type fakeFetch struct {
	mu    sync.Mutex
	by    map[string][]byte
	err   error
	gate  chan struct{}
	calls int
}

func (f *fakeFetch) Fetch(ctx context.Context, cid string, max int) ([]byte, error) {
	if f.gate != nil {
		<-f.gate
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.err != nil {
		return nil, f.err
	}
	b, ok := f.by[cid]
	if !ok {
		return nil, errors.New("CAR does not contain the requested CID")
	}
	return b, nil
}

const rtHex = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd"

func newStoreRig(t *testing.T, f Fetcher) *rig {
	r := newRig(t)
	st, err := newStore(filepath.Join(r.dir, "store"), f, rtHex)
	if err != nil {
		t.Fatal(err)
	}
	r.s.Store = st
	return r
}

func rec(cid string, version uint32) contract.CatalogDerivation {
	return contract.CatalogDerivation{Derivation: contract.CatalogDerivationV1,
		Catalog: contract.CatalogRef{App: "0x" + strings.Repeat("ab", 32), Version: version}, CID: cid,
		Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}, RuntimeID: rtHex}
}

func (r *rig) prefetch(d contract.CatalogDerivation) (int, map[string]any) {
	return r.do("POST", "/prefetch", map[string]any{"image": "ipfs://" + d.CID, "derive": d})
}

func (r *rig) storeFiles(kind string) []string {
	ents, _ := os.ReadDir(filepath.Join(r.s.Store.dir, kind))
	var out []string
	for _, e := range ents {
		out = append(out, e.Name())
	}
	return out
}

func TestPrefetchMapsOnceAndTheLaunchUsesTheDerivedBundle(t *testing.T) {
	a := component("A")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a}}
	r := newStoreRig(t, f)
	d := rec(rawCID(a), 7)
	want, bundle, _ := contract.MapCatalog(d, a)
	code, got := r.prefetch(d)
	if code != 200 || got["appId"] != want.AppID || got["recordSha256"] != want.RecordSha256 {
		t.Fatalf("prefetch: %d %v, want AppID %s", code, got, want.AppID)
	}
	code, body := r.do("POST", "/vms", map[string]any{"image": "ipfs://" + d.CID, "name": "0xa", "derive": d})
	if code != 201 {
		t.Fatalf("launch: %d %v", code, body)
	}
	r.s.launching.Wait()
	_, vmv := r.do("GET", "/vms/"+body["id"].(string), nil)
	if vmv["status"] != "running" || vmv["appId"] != want.AppID || vmv["recordSha256"] != want.RecordSha256 {
		t.Fatalf("the guest does not carry the derived identity: %v", vmv)
	}
	if f.calls != 1 {
		t.Fatalf("the launch fetched again (%d fetches): it must read the verified mapping", f.calls)
	}
	stored, _ := os.ReadFile(filepath.Join(r.s.Store.dir, "bundles", want.AppID+".bundle"))
	if !bytes.Equal(stored, bundle) {
		t.Fatal("the stored bundle is not the derived bundle")
	}
}

func TestMalformedRequestsAreRefusedAndLeaveNothing(t *testing.T) {
	a := component("A")
	core := append([]byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}, "core"...)
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a, rawCID(core): core}}
	r := newStoreRig(t, f)
	good := rec(rawCID(a), 1)
	bad := func(m func(*contract.CatalogDerivation)) contract.CatalogDerivation { d := good; m(&d); return d }
	cases := map[string]map[string]any{
		"unknown derivation":   {"image": "ipfs://" + good.CID, "derive": bad(func(d *contract.CatalogDerivation) { d.Derivation = "enclave-catalog-bundle/2" })},
		"policy not pinned":    {"image": "ipfs://" + good.CID, "derive": bad(func(d *contract.CatalogDerivation) { d.Policy.MemMiB = 0 })},
		"another runtime":      {"image": "ipfs://" + good.CID, "derive": bad(func(d *contract.CatalogDerivation) { d.RuntimeID = strings.Repeat("ef", 32) })},
		"record for other cid": {"image": "ipfs://" + rawCID(core), "derive": good},
		"no record":            {"image": "ipfs://" + good.CID},
		"a core module":        {"image": "ipfs://" + rawCID(core), "derive": rec(rawCID(core), 1)},
	}
	for name, b := range cases {
		code, body := r.do("POST", "/prefetch", b)
		if code != 422 {
			t.Errorf("%s: %d %v, want 422", name, code, body)
		}
		b2 := map[string]any{"name": "0x" + strings.ReplaceAll(name, " ", "")}
		for k, v := range b {
			b2[k] = v
		}
		if code, body := r.do("POST", "/vms", b2); code != 422 {
			t.Errorf("%s via /vms: %d %v, want 422", name, code, body)
		}
	}
	if code, _ := r.do("POST", "/prefetch", map[string]any{"image": "ipfs://" + good.CID, "derive": good, "extra": 1}); code != 400 {
		t.Error("an unknown field on /prefetch must be refused")
	}
	for _, k := range []string{"components", "bundles", "mappings"} {
		if got := r.storeFiles(k); len(got) != 0 {
			t.Fatalf("a refused request left %s: %v", k, got)
		}
	}
}

func TestSubstitutedOrFailedFetchesStoreNothingAndTheNextSucceeds(t *testing.T) {
	a := component("A")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a}, err: errors.New("block hash mismatch - gateway served tampered data")}
	r := newStoreRig(t, f)
	d := rec(rawCID(a), 1)
	if code, body := r.prefetch(d); code != 502 || !strings.Contains(body["error"].(string), "nothing was stored") {
		t.Fatalf("a failed verification: %d %v", code, body)
	}
	if len(r.storeFiles("mappings"))+len(r.storeFiles("components")) != 0 {
		t.Fatal("a failed prefetch left files behind")
	}
	f.mu.Lock()
	f.err = nil
	f.mu.Unlock()
	if code, body := r.prefetch(d); code != 200 {
		t.Fatalf("no negative caching: the next prefetch must start clean: %d %v", code, body)
	}
}

func TestVersionsAndRollbackAreImmutable(t *testing.T) {
	a, b := component("A"), component("B")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a, rawCID(b): b}}
	r := newStoreRig(t, f)
	_, v7 := r.prefetch(rec(rawCID(a), 7))
	_, v8 := r.prefetch(rec(rawCID(b), 8))
	if v7["appId"] == v8["appId"] || v7["recordSha256"] == v8["recordSha256"] {
		t.Fatal("two versions with two components must be two identities")
	}
	before, _ := os.ReadFile(filepath.Join(r.s.Store.dir, "bundles", v7["appId"].(string)+".bundle"))
	calls := f.calls
	_, back := r.prefetch(rec(rawCID(a), 7)) // roll back
	if back["appId"] != v7["appId"] || back["recordSha256"] != v7["recordSha256"] || f.calls != calls {
		t.Fatalf("rollback must return the SAME mapping without fetching: %v vs %v, fetches %d->%d", back, v7, calls, f.calls)
	}
	after, _ := os.ReadFile(filepath.Join(r.s.Store.dir, "bundles", v7["appId"].(string)+".bundle"))
	if !bytes.Equal(before, after) {
		t.Fatal("a stored bundle changed")
	}
	// the same component listed again under another version: same AppID, its own record
	_, v9 := r.prefetch(rec(rawCID(a), 9))
	if v9["appId"] != v7["appId"] || v9["recordSha256"] == v7["recordSha256"] {
		t.Fatalf("same bytes under another version: %v vs %v", v9, v7)
	}
}

func TestRacingPrefetchesFetchOnce(t *testing.T) {
	a := component("A")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a}, gate: make(chan struct{})}
	r := newStoreRig(t, f)
	d := rec(rawCID(a), 1)
	var wg sync.WaitGroup
	ids := make([]string, 16)
	for i := range ids {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			code, body := r.prefetch(d)
			if code == 200 {
				ids[i] = body["appId"].(string)
			}
		}(i)
	}
	close(f.gate)
	wg.Wait()
	for _, id := range ids {
		if id == "" || id != ids[0] {
			t.Fatalf("racing prefetches disagreed or failed: %v", ids)
		}
	}
	if f.calls != 1 {
		t.Fatalf("%d fetches for one record; singleflight must make it one", f.calls)
	}
}

func TestATamperedStoreIsQuarantinedRefusedAndRederived(t *testing.T) {
	a := component("A")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a}}
	r := newStoreRig(t, f)
	d := rec(rawCID(a), 1)
	_, first := r.prefetch(d)
	bp := filepath.Join(r.s.Store.dir, "bundles", first["appId"].(string)+".bundle")
	b, _ := os.ReadFile(bp)
	_ = os.Chmod(bp, 0o600)
	b[len(b)-1] ^= 1
	_ = os.WriteFile(bp, b, 0o600)
	code, body := r.prefetch(d)
	if code != 409 || !strings.Contains(body["error"].(string), "quarantined") {
		t.Fatalf("a tampered bundle must be refused and quarantined: %d %v", code, body)
	}
	if len(r.storeFiles("quarantine")) == 0 {
		t.Fatal("nothing was quarantined: the evidence is gone")
	}
	code, again := r.prefetch(d)
	if code != 200 || again["appId"] != first["appId"] || f.calls != 2 {
		t.Fatalf("the next request must derive afresh to the same identity: %d %v (fetches %d)", code, again, f.calls)
	}
	// a mapping that names a different AppID is caught too
	mp := filepath.Join(r.s.Store.dir, "mappings", first["recordSha256"].(string)+".json")
	var m contract.CatalogMapping
	raw, _ := os.ReadFile(mp)
	_ = json.Unmarshal(raw, &m)
	m.AppID = strings.Repeat("00", 32)
	raw, _ = contract.Canonical(m)
	_ = os.Chmod(mp, 0o600)
	_ = os.WriteFile(mp, raw, 0o600)
	if code, _ := r.prefetch(d); code != 409 {
		t.Fatalf("a mapping that lies about its AppID must be refused: %d", code)
	}
}

func TestATamperedComponentFileIsQuarantinedOnTheNextWrite(t *testing.T) {
	a := component("A")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a}}
	r := newStoreRig(t, f)
	_, first := r.prefetch(rec(rawCID(a), 1))
	cp := filepath.Join(r.s.Store.dir, "components", componentSha(a))
	_ = os.Chmod(cp, 0o600)
	_ = os.WriteFile(cp, []byte("not the component"), 0o600)
	// another version of the same component writes the same content-addressed file: the conflict must surface
	if code, body := r.prefetch(rec(rawCID(a), 2)); code != 409 || !strings.Contains(body["error"].(string), "quarantined") {
		t.Fatalf("%d %v", code, body)
	}
	if code, again := r.prefetch(rec(rawCID(a), 2)); code != 200 || again["appId"] != first["appId"] {
		t.Fatalf("after quarantine the write must succeed: %d %v", code, again)
	}
	if got, _ := os.ReadFile(cp); !bytes.Equal(got, a) {
		t.Fatal("the component file was not restored from verified bytes")
	}
}

// The mapping and bundle guestd stores are reconstructed by the INDEPENDENT reference (contract/derive_reference.py,
// written from DERIVE.md, not from the Go code) from nothing but the record and the component bytes.
func TestTheStoreIsReconstructedIndependently(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is not installed")
	}
	a, b := component("A"), component("B")
	f := &fakeFetch{by: map[string][]byte{rawCID(a): a, rawCID(b): b}}
	r := newStoreRig(t, f)
	for i, d := range []contract.CatalogDerivation{rec(rawCID(a), 3), rec(rawCID(b), 4)} {
		d.Policy = contract.Policy{CPUPercent: 50 * (i + 1), MemMiB: 256 * (i + 1), Vcpus: i + 1}
		code, got := r.prefetch(d)
		if code != 200 {
			t.Fatalf("prefetch: %d %v", code, got)
		}
		rj, _ := json.Marshal(d)
		rp, cp, op := filepath.Join(r.dir, "rec.json"), filepath.Join(r.dir, "comp"), filepath.Join(r.dir, "ref.bundle")
		_ = os.WriteFile(rp, rj, 0o600)
		_ = os.WriteFile(cp, f.by[d.CID], 0o600)
		out, err := exec.Command("python3", "../../contract/derive_reference.py", "bundle", rp, cp, op).Output()
		if err != nil {
			t.Fatal(err)
		}
		stored, _ := os.ReadFile(filepath.Join(r.s.Store.dir, "mappings", got["recordSha256"].(string)+".json"))
		if strings.TrimSpace(string(out)) != string(stored) {
			t.Fatalf("the reference's mapping\n %s\nguestd stored\n %s", out, stored)
		}
		ref, _ := os.ReadFile(op)
		mine, _ := os.ReadFile(filepath.Join(r.s.Store.dir, "bundles", got["appId"].(string)+".bundle"))
		if !bytes.Equal(ref, mine) {
			t.Fatal("the reference built a different bundle")
		}
	}
}

// The REAL fetcher - fetch-cid.py over the platform's own wasm/ipfs_fetch.py - against a synthetic gateway on
// loopback: a raw single block, a two-chunk dag-pb file, a substituting gateway, and a gateway that has nothing.
func TestTheRealVerifierAgainstASyntheticGateway(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 is not installed")
	}
	small := component("raw")
	chunk1, chunk2 := component("chunk one"), []byte(" and chunk two of the same component")
	whole := append(append([]byte{}, chunk1...), chunk2...)
	dagRoot, dagCAR := dagpbFile(chunk1, chunk2)
	other := component("somebody else's")
	cars := map[string][]byte{
		rawCID(small): car(rawBlock(small)),
		dagRoot:       dagCAR,
		// a substituting gateway: asked for small's CID, it serves another component's block
		rawCID(component("asked for")): car(rawBlock(other)),
	}
	gw := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		cid := strings.TrimPrefix(q.URL.Path, "/ipfs/")
		if q.URL.Query().Get("format") != "car" {
			http.Error(w, "car only", 400)
			return
		}
		if c, ok := cars[cid]; ok {
			_, _ = w.Write(c)
			return
		}
		http.NotFound(w, q)
	}))
	defer gw.Close()
	r := newStoreRig(t, &pyFetcher{script: "./fetch-cid.py", repo: "../../..", gateway: gw.URL, tmp: t.TempDir()})
	for name, c := range map[string]struct {
		cid  string
		want []byte
	}{"raw block": {rawCID(small), small}, "dag-pb, two chunks": {dagRoot, whole}} {
		code, got := r.prefetch(rec(c.cid, 1))
		if code != 200 || got["componentSha256"] != componentSha(c.want) {
			t.Fatalf("%s: %d %v", name, code, got)
		}
	}
	for name, cid := range map[string]string{"substituted": rawCID(component("asked for")),
		"not served": rawCID(component("nowhere"))} {
		if code, body := r.prefetch(rec(cid, 1)); code != 502 {
			t.Fatalf("%s: %d %v, want 502", name, code, body)
		}
	}
}

// ---- a minimal CARv1 / dag-pb writer, for the synthetic gateway only --------------------------------------------

func uvarint(n uint64) []byte {
	var b []byte
	for n >= 0x80 {
		b = append(b, byte(n)|0x80)
		n >>= 7
	}
	return append(b, byte(n))
}

type block struct{ cid, data []byte }

func rawBlock(b []byte) block {
	s := sha256.Sum256(b)
	return block{append([]byte{0x01, 0x55, 0x12, 0x20}, s[:]...), b}
}

func car(blocks ...block) []byte {
	hdr := []byte{0xa2, 0x65, 'r', 'o', 'o', 't', 's', 0x80, 0x67, 'v', 'e', 'r', 's', 'i', 'o', 'n', 0x01}
	out := append(uvarint(uint64(len(hdr))), hdr...)
	for _, b := range blocks {
		out = append(out, uvarint(uint64(len(b.cid)+len(b.data)))...)
		out = append(append(out, b.cid...), b.data...)
	}
	return out
}

func pbField(n int, b []byte) []byte {
	return append(append(uvarint(uint64(n<<3|2)), uvarint(uint64(len(b)))...), b...)
}

// dagpbFile is a UnixFS file of raw-leaf chunks under one dag-pb root, as kubo lays out a chunked file.
func dagpbFile(chunks ...[]byte) (string, []byte) {
	var blocks []block
	var node []byte
	for _, c := range chunks {
		rb := rawBlock(c)
		blocks = append(blocks, rb)
		node = append(node, pbField(2, pbField(1, rb.cid))...) // PBNode.Links[i].Hash
	}
	node = append(node, pbField(1, []byte{0x08, 0x02})...) // PBNode.Data = UnixFS{Type: File}
	s := sha256.Sum256(node)
	root := append([]byte{0x01, 0x70, 0x12, 0x20}, s[:]...)
	cid := "b" + strings.ToLower(base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(root))
	return cid, car(append([]block{{root, node}}, blocks...)...)
}
