package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// restart builds a NEW server over the same root and launcher, as a guestd restart does, and runs its boot adoption.
func (r *rig) restart(t *testing.T) (*server, map[string]bool, []string, []string) {
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	s2.Budget = r.s.Budget // a restarted guestd runs with the same flags
	keep, adopted, dropped := s2.adoptOnBoot(context.Background())
	return s2, keep, adopted, dropped
}

func TestARestartAdoptsTheSameGuestAndNothingElse(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	mk := func(name string) string {
		code, body := r.create(name, p)
		if code != 201 {
			t.Fatalf("create %s: %d %v", name, code, body)
		}
		r.s.launching.Wait()
		return body["id"].(string)
	}
	live := mk("0x" + strings.Repeat("aa", 32))
	dead := mk("0x" + strings.Repeat("bb", 32))
	other := mk("0x" + strings.Repeat("cc", 32))
	corrupt := mk("0x" + strings.Repeat("dd", 32))
	_ = os.WriteFile(filepath.Join(r.s.Root, corrupt, recordFile), []byte("{not json"), 0o600)
	stray := filepath.Join(r.s.Root, "gd0badf00d") // a workdir that never became running: no record
	_ = os.MkdirAll(stray, 0o700)
	r.f.mu.Lock()
	r.f.alive["unit-"+dead] = false // its guest exited while guestd was down
	r.f.mu.Unlock()
	// "other" will present a different key on re-verification: not the same guest
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	s2.Budget = r.s.Budget // a restarted guestd runs with the same flags
	r.f.mu.Lock()
	r.f.keyOverride = ""
	r.f.mu.Unlock()
	keyFor := map[string]string{}
	// adopt one at a time so the key override applies to "other" only
	for _, id := range []string{live, dead, corrupt} {
		keyFor[id] = s2.adoptOne(context.Background(), filepath.Join(r.s.Root, id))
	}
	r.f.mu.Lock()
	r.f.keyOverride = strings.Repeat("99", 32)
	r.f.mu.Unlock()
	keyFor[other] = s2.adoptOne(context.Background(), filepath.Join(r.s.Root, other))
	keyFor["stray"] = s2.adoptOne(context.Background(), stray)
	if keyFor[live] != "" {
		t.Fatalf("the live guest that verifies as itself was not adopted: %s", keyFor[live])
	}
	for id, want := range map[string]string{dead: "no longer active", corrupt: "unreadable", other: "not the same guest", "stray": "no instance record"} {
		if !strings.Contains(keyFor[id], want) {
			t.Errorf("%s: got %q, want it dropped as %q", id, keyFor[id], want)
		}
	}
	v := s2.vms[live]
	if v == nil || v.Status != "running" || v.lc.State() != contract.Running || v.TransportKeySha256 != fakeKeySha || v.Name != "0x"+strings.Repeat("aa", 32) ||
		v.HostData != strings.Repeat("aa", 32) || v.HostPort == 0 {
		t.Fatalf("the adopted record: %+v", v)
	}
	if len(s2.vms) != 1 {
		t.Fatalf("only the one guest may be adopted: %d", len(s2.vms))
	}
}

func TestBootAdoptionEndsAndScrubsWhatItDoesNotAdopt(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	code, body := r.create("0x"+strings.Repeat("aa", 32), p)
	if code != 201 {
		t.Fatal(code)
	}
	r.s.launching.Wait()
	keepID := body["id"].(string)
	code, body = r.create("0x"+strings.Repeat("bb", 32), p)
	r.s.launching.Wait()
	dropID := body["id"].(string)
	r.f.mu.Lock()
	r.f.alive["unit-"+dropID] = false
	r.f.mu.Unlock()
	s2, keep, adopted, dropped := r.restart(t)
	if fmt.Sprint(adopted) != "["+keepID+"]" || len(dropped) != 1 || !keep["unit-"+keepID] || keep["unit-"+dropID] {
		t.Fatalf("adopted %v dropped %v keep %v", adopted, dropped, keep)
	}
	if _, err := os.Stat(filepath.Join(r.s.Root, dropID)); !os.IsNotExist(err) {
		t.Fatal("a dropped guest's workdir was not scrubbed")
	}
	if r.f.stopsOf(dropID) != 1 {
		t.Fatalf("a dropped guest with a record was not stopped: %d", r.f.stopsOf(dropID))
	}
	// the adopted guest serves the /vms contract as before, and its dead-man lease is inert until a heartbeat
	if s2.vms[keepID] == nil || len(s2.leaseExpired(s2.Now().Add(24*3600*1e9))) != 0 {
		t.Fatal("the adopted guest is missing or its lease is not inert before the first heartbeat")
	}
}

func TestAFailedStartKeepsItsReason(t *testing.T) {
	r := newRig(t)
	r.f.serial = "DOM snp=1\nError: no exported instance named `wasi:http/incoming-handler@0.2.12`\nDOM ERROR app exited status=1\n"
	r.f.verifyErr = fmt.Errorf("VERDICT reject reason=\"the domain never answered\"")
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0x"+strings.Repeat("aa", 32), p)
	r.s.launching.Wait()
	id := body["id"].(string)
	if _, err := os.Stat(filepath.Join(r.s.Root, id)); !os.IsNotExist(err) {
		t.Fatal("the failed start's workdir was kept (the bundle and image are the tenant's)")
	}
	b, err := os.ReadFile(filepath.Join(r.s.Root, "failed", id, id+".serial"))
	if err != nil || !strings.Contains(string(b), "no exported instance") {
		t.Fatalf("the serial console was not preserved: %v %q", err, b)
	}
	code, logs := r.do("GET", "/vms/"+id+"/logs?tail=2", nil)
	lines, _ := logs["lines"].([]any)
	if code != 200 || logs["status"] != "failed" || len(lines) != 2 || !strings.Contains(fmt.Sprint(logs["error"]), "did not attest") {
		t.Fatalf("GET logs of a failed start: %d %v", code, logs)
	}
	// retention is bounded
	for i := 0; i < keepFailed+5; i++ {
		_ = os.MkdirAll(filepath.Join(r.s.Root, "failed", fmt.Sprintf("gdx%07d", i)), 0o700)
	}
	pruneFailed(filepath.Join(r.s.Root, "failed"), keepFailed)
	if ents, _ := os.ReadDir(filepath.Join(r.s.Root, "failed")); len(ents) != keepFailed {
		t.Fatalf("failed logs kept: %d, want %d", len(ents), keepFailed)
	}
}

func TestLogsOfARunningInstance(t *testing.T) {
	r := newRig(t)
	r.f.serial = "DOM serving\nline two\n"
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0x"+strings.Repeat("aa", 32), p)
	r.s.launching.Wait()
	code, logs := r.do("GET", "/vms/"+body["id"].(string)+"/logs", nil)
	if code != 200 || logs["status"] != "running" || fmt.Sprint(logs["lines"]) != "[DOM serving line two]" {
		t.Fatalf("%d %v", code, logs)
	}
	if code, _ := r.do("GET", "/vms/gd00000000/logs", nil); code != 404 {
		t.Fatalf("an unknown instance's logs: %d", code)
	}
}

// Per release (enclave-87's ruling, enclave-bf's design): every guest is named to the judge with the release(s) of the
// tree that BUILT it, recorded with it, and named again on adoption - so which binary or tree is live at a restart can
// never change how a running guest is judged. A record an earlier guestd wrote (no Releases) gets -unrecorded-releases.
// The judge's own table decides what a named release may state (m2/judge.mjs LEGACY_WX_RELEASES).
func TestEachGuestIsNamedByItsOwnTreesRelease(t *testing.T) {
	tree, legacyTree, unrec := []string{strings.Repeat("f7", 32)}, []string{strings.Repeat("5c", 32), strings.Repeat("6f", 32)}, []string{strings.Repeat("99", 32)}
	r := newRig(t)
	r.s.TreeReleases, r.s.LegacyTreeReleases, r.s.UnrecordedReleases = tree, legacyTree, unrec
	p, _ := r.bundle("A", contract.Policy{})
	code, body := r.create("0x"+strings.Repeat("aa", 32), p)
	if code != 201 {
		t.Fatalf("create: %d %v", code, body)
	}
	r.s.launching.Wait()
	dir := filepath.Join(r.s.Root, body["id"].(string))
	last := func() string {
		r.f.mu.Lock()
		defer r.f.mu.Unlock()
		return r.f.verifyReleases[len(r.f.verifyReleases)-1]
	}
	if got := last(); got != tree[0] {
		t.Fatalf("a guest this tree launched was named %q, want its tree's %q", got, tree[0])
	}
	readRec := func() instanceRecord {
		b, err := os.ReadFile(filepath.Join(dir, recordFile))
		if err != nil {
			t.Fatal(err)
		}
		var rec instanceRecord
		if err := json.Unmarshal(b, &rec); err != nil {
			t.Fatal(err)
		}
		return rec
	}
	if rec := readRec(); strings.Join(rec.Releases, ",") != tree[0] {
		t.Fatalf("the record does not say which release built the guest: %v", rec.Releases)
	}
	writeRec := func(f func(*instanceRecord)) {
		rec := readRec()
		f(&rec)
		b, _ := json.Marshal(rec)
		_ = os.WriteFile(filepath.Join(dir, recordFile), b, 0o600)
	}
	// adoption by a guestd on ANOTHER tree (its own releases differ): the guest is named by what BUILT it
	adopt := func() string {
		s := newServer(r.f, r.s.Root)
		s.Now, s.Budget = r.s.Now, r.s.Budget
		s.TreeReleases, s.LegacyTreeReleases, s.UnrecordedReleases = []string{strings.Repeat("11", 32)}, nil, unrec
		if why := s.adoptOne(context.Background(), dir); why != "" {
			t.Fatalf("not adopted: %s", why)
		}
		return last()
	}
	if got := adopt(); got != tree[0] {
		t.Fatalf("the record as written, adopted after a tree switch: named %q, want %q", got, tree[0])
	}
	for _, c := range []struct {
		what string
		set  func(*instanceRecord)
		want string
	}{
		{"a record an earlier guestd wrote (no Releases)", func(rec *instanceRecord) { rec.Releases = nil }, unrec[0]},
		{"a record naming no release (a tree that was not named)", func(rec *instanceRecord) { rec.Releases = []string{} }, ""},
		{"a legacy-tree guest's record", func(rec *instanceRecord) { rec.Legacy, rec.Releases = true, legacyTree }, strings.Join(legacyTree, ",")},
	} {
		writeRec(c.set)
		if got := adopt(); got != c.want {
			t.Errorf("%s: named %q, want %q", c.what, got, c.want)
		}
	}
	// the launch path's choice, and the flag's parsing: ids, or @release.json whose sha256 is the id
	s := &server{TreeReleases: tree, LegacyTreeReleases: legacyTree}
	if strings.Join(s.treeReleases(false), ",") != tree[0] || strings.Join(s.treeReleases(true), ",") != strings.Join(legacyTree, ",") {
		t.Fatal("treeReleases at launch")
	}
	if got := (&server{}).treeReleases(false); got == nil || len(got) != 0 {
		t.Fatalf("an unnamed tree must record an empty list, not nil (nil means an earlier guestd's record): %#v", got)
	}
	rj := filepath.Join(t.TempDir(), "release.json")
	_ = os.WriteFile(rj, []byte(`{"release":"x"}`), 0o600)
	sum := sha256.Sum256([]byte(`{"release":"x"}`))
	if got, err := parseReleaseIDs(" " + strings.ToUpper(tree[0]) + ",,@" + rj + "," + tree[0]); err != nil || strings.Join(got, ",") != tree[0]+","+hex.EncodeToString(sum[:]) {
		t.Fatalf("parseReleaseIDs: %q %v", got, err)
	}
	for _, bad := range []string{"f7888d86", tree[0] + "00", tree[0] + ",xyz", "@" + filepath.Join(t.TempDir(), "absent.json")} {
		if _, err := parseReleaseIDs(bad); err == nil {
			t.Errorf("parseReleaseIDs accepted %q", bad)
		}
	}
	// a tree whose judge predates per-release W^X must be named; a later tree need not be
	old, cur := t.TempDir(), t.TempDir()
	for d, js := range map[string]string{old: "export function judge() {}\n", cur: "export const LEGACY_WX_RELEASES = Object.freeze({});\n"} {
		_ = os.MkdirAll(filepath.Join(d, "m2"), 0o755)
		_ = os.WriteFile(filepath.Join(d, "m2", "judge.mjs"), []byte(js), 0o600)
	}
	if why := needsRelease(old, ""); !strings.Contains(why, "predates per-release W^X") {
		t.Errorf("an unnamed pre-chain tree was accepted: %q", why)
	}
	// a pre-chain tree's own judge ignores --release, so a TYPED id is not caught at launch: only a derived one
	for _, typed := range []string{tree[0], "@" + rj + "," + tree[0]} {
		if why := needsRelease(old, typed); !strings.Contains(why, "DERIVED") {
			t.Errorf("a pre-chain tree named by a typed id %q was accepted: %q", typed, why)
		}
	}
	if why := needsRelease(old, "@"+rj); why != "" {
		t.Errorf("a pre-chain tree named by its release.json was refused: %q", why)
	}
	if needsRelease(cur, "") != "" || needsRelease(cur, tree[0]) != "" {
		t.Error("a later tree, unnamed or typed, was refused (its own judge checks what it is told)")
	}
	if why := needsRelease(filepath.Join(t.TempDir(), "absent"), "@"+rj); why == "" {
		t.Error("an unreadable tree was accepted")
	}
	// the real launcher's judge command line names them exactly when given
	rl := &realLauncher{m2: "/m2"}
	if a := strings.Join(rl.verifyArgs(1, "m", "a", "", "/w", legacyTree), " "); !strings.HasSuffix(a, " --release "+strings.Join(legacyTree, ",")) {
		t.Errorf("the real verifier was not given the releases: %s", a)
	}
	if a := strings.Join(rl.verifyArgs(1, "m", "a", "", "/w", nil), " "); strings.Contains(a, "--release") {
		t.Errorf("a guest named no release was given --release: %s", a)
	}
}
