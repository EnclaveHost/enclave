package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

// the reservation of a guest with the default policy (256 MiB, 100% CPU): the 1024 MiB floor plus the unit's 768
var oneGuest = reservation{MemMiB: 1024 + 768, CPUPct: 100}

func budgetFor(n int) poolBudget {
	return poolBudget{MemMiB: n * oneGuest.MemMiB, CPUPct: n * oneGuest.CPUPct}
}

func (r *rig) pool() map[string]any {
	code, h := r.do("GET", "/health", nil)
	if code != 200 {
		r.t.Fatalf("/health: %d %v", code, h)
	}
	p, _ := h["pool"].(map[string]any)
	if p == nil {
		r.t.Fatalf("/health has no pool: %v", h)
	}
	return p
}

// res reads a {memMiB, cpuPct} object out of a JSON answer.
func res(m any) reservation {
	o, _ := m.(map[string]any)
	f := func(k string) int { x, _ := o[k].(float64); return int(x) }
	return reservation{MemMiB: f("memMiB"), CPUPct: f("cpuPct")}
}

func (r *rig) allocated() reservation { return res(r.pool()["allocated"]) }

func name(i int) string { return "0x" + strings.Repeat(strconv.FormatInt(int64(i%16), 16), 64) }

func TestAGuestReservesItsUnitsCeilingsNotItsPolicy(t *testing.T) {
	r := newRig(t)
	small, _ := r.bundle("small", contract.Policy{MemMiB: 128})
	big, _ := r.bundle("big", contract.Policy{MemMiB: 2048, CPUPercent: 50})
	_, a := r.create(name(1), small)
	_, b := r.create(name(2), big)
	r.s.launching.Wait()
	for id, want := range map[string]reservation{
		a["id"].(string): {MemMiB: 1024 + 768, CPUPct: 100},      // 128 MiB asked: the floor, plus the unit's allowance
		b["id"].(string): {MemMiB: 2048 + 384 + 768, CPUPct: 50}, // its policy plus the runtime, plus the allowance
	} {
		_, v := r.do("GET", "/vms/"+id, nil)
		if got := res(v["reserved"]); got != want {
			t.Errorf("%s reserves %+v, want %+v", id, got, want)
		}
	}
	if got := r.allocated(); got != (reservation{MemMiB: 1792 + 3200, CPUPct: 150}) {
		t.Fatalf("allocated %+v is not the sum of the two reservations", got)
	}
}

func TestTheBudgetIsAdmittedExactlyAndTheRefusalIsStable(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(2)
	p, _ := r.bundle("A", contract.Policy{})
	for i := 1; i <= 2; i++ {
		if code, body := r.create(name(i), p); code != 201 {
			t.Fatalf("guest %d of a 2-guest pool: %d %v", i, code, body)
		}
	}
	r.s.launching.Wait()
	builds := r.f.builds
	code, body := r.create(name(3), p)
	if code != 507 || body["error"] != "pool_full" || res(body["needs"]) != oneGuest || res(body["free"]) != (reservation{}) {
		t.Fatalf("the third guest of a 2-guest pool: %d %v", code, body)
	}
	_, list := r.do("GET", "/vms", nil)
	if n := len(list["vms"].([]any)); n != 2 || r.f.builds != builds {
		t.Fatalf("a refused create left a record (%d listed) or started a build (%d -> %d)", n, builds, r.f.builds)
	}
	// each axis on its own: memory to spare, CPU spent
	r2 := newRig(t)
	r2.s.Budget = poolBudget{MemMiB: 1 << 20, CPUPct: 100}
	p2, _ := r2.bundle("A", contract.Policy{})
	if code, _ := r2.create(name(1), p2); code != 201 {
		t.Fatalf("the first guest: %d", code)
	}
	if code, body := r2.create(name(2), p2); code != 507 || body["error"] != "pool_full" {
		t.Fatalf("CPU spent, memory to spare: %d %v", code, body)
	}
	r2.s.launching.Wait()
}

func TestTwoCreatesForTheLastRoomGetExactlyOne(t *testing.T) {
	for round := 0; round < 25; round++ {
		r := newRig(t)
		r.s.Budget = budgetFor(2)
		p, _ := r.bundle("A", contract.Policy{})
		if code, _ := r.create(name(1), p); code != 201 {
			t.Fatal("the first guest")
		}
		var wg sync.WaitGroup
		codes := make([]int, 2)
		for i := range codes {
			wg.Add(1)
			go func(i int) { defer wg.Done(); codes[i], _ = r.create(name(2+i), p) }(i)
		}
		wg.Wait()
		r.s.launching.Wait()
		if !((codes[0] == 201 && codes[1] == 507) || (codes[0] == 507 && codes[1] == 201)) {
			t.Fatalf("round %d: two creates for the last room answered %v, want one 201 and one 507", round, codes)
		}
		if got := r.allocated(); got != (reservation{MemMiB: 2 * oneGuest.MemMiB, CPUPct: 200}) {
			t.Fatalf("round %d: allocated %+v", round, got)
		}
	}
}

// Every way a guest ends gives its room back, and the next create proves it: each rig has room for ONE guest.
func TestEveryEndPathReturnsItsReservation(t *testing.T) {
	endings := map[string]func(r *rig, p string) string{
		"a failed start": func(r *rig, p string) string {
			r.f.verifyErr = errTest("VERDICT reject")
			_, b := r.create(name(1), p)
			r.s.launching.Wait()
			r.f.verifyErr = nil
			id := b["id"].(string)
			if _, v := r.do("GET", "/vms/"+id, nil); v["status"] != "failed" || v["reserved"] != nil {
				r.t.Fatalf("a failed start is listed (for the supervisor to see) but holds nothing: %v", v)
			}
			return id
		},
		"the guest exiting": func(r *rig, p string) string {
			_, b := r.create(name(1), p)
			r.s.launching.Wait()
			id := b["id"].(string)
			r.f.mu.Lock()
			r.f.alive["unit-"+id] = false
			r.f.mu.Unlock()
			r.s.tick()
			return id
		},
		"a lapsed lease": func(r *rig, p string) string {
			_, b := r.create(name(1), p)
			r.s.launching.Wait()
			r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xother"}})
			r.advance(r.s.LeaseTTL + time.Second)
			r.do("POST", "/vms/lease", map[string]any{"ids": []string{"0xother"}})
			r.s.tick()
			return b["id"].(string)
		},
		"a delete during startup": func(r *rig, p string) string {
			r.f.startGate = make(chan struct{})
			_, b := r.create(name(1), p)
			id := b["id"].(string)
			if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 202 {
				r.t.Fatalf("a delete during startup: %d", code)
			}
			// startup still owns the guest, so it still holds its room
			if got := r.allocated(); got != oneGuest {
				r.t.Fatalf("while startup owns it the guest holds its room: %+v", got)
			}
			close(r.f.startGate)
			r.s.launching.Wait()
			r.f.startGate = nil
			return id
		},
		"a delete": func(r *rig, p string) string {
			_, b := r.create(name(1), p)
			r.s.launching.Wait()
			id := b["id"].(string)
			if code, _ := r.do("DELETE", "/vms/"+id, nil); code != 200 {
				r.t.Fatalf("delete: %d", code)
			}
			return id
		},
	}
	for what, end := range endings {
		t.Run(what, func(t *testing.T) {
			r := newRig(t)
			r.s.Budget = budgetFor(1)
			p, _ := r.bundle("A", contract.Policy{})
			id := end(r, p)
			if got := r.allocated(); got != (reservation{}) {
				t.Fatalf("after %s the pool still holds %+v", what, got)
			}
			if r.f.stopsOf(id) > 1 {
				t.Fatalf("reclaimed %d times", r.f.stopsOf(id))
			}
			if code, body := r.create(name(2), p); code != 201 {
				t.Fatalf("after %s the next guest is refused: %d %v", what, code, body)
			}
			r.s.launching.Wait()
		})
	}
}

// A guest that ended still holds its room while its unit is being stopped: "failed" is a status, the room comes back
// only once nothing of it runs on the host.
func TestAnEndedGuestHoldsItsRoomUntilItsUnitIsStopped(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(1)
	p, _ := r.bundle("A", contract.Policy{})
	_, b := r.create(name(1), p)
	r.s.launching.Wait()
	id := b["id"].(string)
	r.f.stopGate = make(chan struct{})
	r.f.mu.Lock()
	r.f.alive["unit-"+id] = false
	r.f.mu.Unlock()
	ticked := make(chan struct{})
	go func() { r.s.tick(); close(ticked) }() // it marks the guest failed, then blocks stopping its unit
	for deadline := time.Now().Add(5 * time.Second); ; {
		r.s.mu.Lock()
		st := r.s.vms[id].Status
		r.s.mu.Unlock()
		if st == "failed" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the dead guest was never marked failed")
		}
		time.Sleep(time.Millisecond)
	}
	if got := r.allocated(); got != oneGuest {
		t.Fatalf("while its unit is still being stopped the guest holds its room: %+v", got)
	}
	if code, body := r.create(name(2), p); code != 507 || body["error"] != "pool_full" {
		t.Fatalf("a create while the old unit still runs: %d %v", code, body)
	}
	close(r.f.stopGate)
	<-ticked
	r.f.stopGate = nil
	if got := r.allocated(); got != (reservation{}) {
		t.Fatalf("stopped, it holds %+v", got)
	}
	if code, _ := r.create(name(2), p); code != 201 {
		t.Fatal("the room is back once the unit is stopped")
	}
	r.s.launching.Wait()
}

func TestAnAbsentBudgetRefusesEveryCreateAndStillAdopts(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	_, b := r.create(name(1), p) // with the rig's budget: a guest that is running when guestd restarts
	r.s.launching.Wait()
	id := b["id"].(string)
	// a guestd restarted WITHOUT -guest-mem-mib/-guest-cpus
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	keep, adopted, dropped := s2.adoptOnBoot(context.Background())
	if len(adopted) != 1 || adopted[0] != id || len(dropped) != 0 || !keep["unit-"+id] || r.f.stopsOf(id) != 0 {
		t.Fatalf("an absent budget must not cost a verified guest its life: adopted %v dropped %v stops %d", adopted, dropped, r.f.stopsOf(id))
	}
	s2.logPoolAfterRecovery()
	r2 := &rig{t: t, s: s2, f: r.f, dir: r.dir, clock: r.clock}
	r2.ts = httptest.NewServer(s2)
	t.Cleanup(r2.ts.Close)
	pool := r2.pool()
	if pool["budget"] != nil || pool["overcommitted"] != false || res(pool["allocated"]) != oneGuest || res(pool["free"]) != (reservation{}) {
		t.Fatalf("an unconfigured pool with one adopted guest: %v", pool)
	}
	builds := r.f.builds
	code, body := r2.create(name(2), p)
	if code != 507 || body["error"] != "pool_unconfigured" || !strings.Contains(body["detail"].(string), "-guest-mem-mib") || r.f.builds != builds {
		t.Fatalf("a create with no budget: %d %v (builds %d -> %d)", code, body, builds, r.f.builds)
	}
}

func TestARecoveryOverBudgetAdmitsNothingKillsNothingAndDrains(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(3)
	p, _ := r.bundle("A", contract.Policy{})
	var ids []string
	for i := 1; i <= 3; i++ {
		_, b := r.create(name(i), p)
		ids = append(ids, b["id"].(string))
	}
	r.s.launching.Wait()
	// restarted with a budget for two: the three verified guests are all adopted, and none is ended
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	s2.Budget = budgetFor(2)
	_, adopted, dropped := s2.adoptOnBoot(context.Background())
	if len(adopted) != 3 || len(dropped) != 0 {
		t.Fatalf("adopted %v, dropped %v", adopted, dropped)
	}
	for _, id := range ids {
		if r.f.stopsOf(id) != 0 {
			t.Fatalf("%s was stopped to fit a number", id)
		}
	}
	s2.logPoolAfterRecovery()
	r2 := &rig{t: t, s: s2, f: r.f, dir: r.dir, clock: r.clock}
	r2.ts = httptest.NewServer(s2)
	t.Cleanup(r2.ts.Close)
	pool := r2.pool()
	if pool["overcommitted"] != true || res(pool["free"]) != (reservation{}) || res(pool["allocated"]) != (reservation{MemMiB: 3 * oneGuest.MemMiB, CPUPct: 300}) {
		t.Fatalf("three guests in a pool for two: %v", pool)
	}
	code, body := r2.create(name(9), p)
	if code != 507 || body["error"] != "pool_full" || !strings.Contains(body["detail"].(string), "overcommitted") {
		t.Fatalf("an overcommitted pool admits nothing: %d %v", code, body)
	}
	// one ends: exactly at the budget, no longer overcommitted, and still full
	r2.do("DELETE", "/vms/"+ids[0], nil)
	if pool := r2.pool(); pool["overcommitted"] != false {
		t.Fatalf("at the budget the pool is not overcommitted: %v", pool)
	}
	if code, body := r2.create(name(9), p); code != 507 || strings.Contains(body["detail"].(string), "overcommitted") {
		t.Fatalf("a full pool at its budget: %d %v", code, body)
	}
	// another ends: room for one again, and creates resume
	r2.do("DELETE", "/vms/"+ids[1], nil)
	if code, body := r2.create(name(9), p); code != 201 {
		t.Fatalf("the drained pool admits again: %d %v", code, body)
	}
	s2.launching.Wait()
}

func TestHealthStatesThePoolAsReservations(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(4)
	pool := r.pool()
	if res(pool["budget"]) != (reservation{MemMiB: 4 * 1792, CPUPct: 400}) || res(pool["allocated"]) != (reservation{}) ||
		res(pool["free"]) != res(pool["budget"]) || pool["overcommitted"] != false || pool["guests"] != float64(0) {
		t.Fatalf("an empty pool: %v", pool)
	}
	pg, _ := pool["perGuest"].(map[string]any)
	if pg["floorMiB"] != float64(guestFloorMiB) || pg["runtimeMiB"] != float64(guestRuntimeMiB) || pg["unitOverheadMiB"] != float64(unitOverheadMiB) {
		t.Fatalf("perGuest: %v", pg)
	}
	// the constants the pool states are the ones guestMemMiB sizes a guest with
	if guestMemMiB(0) != guestFloorMiB || guestMemMiB(4096) != 4096+guestRuntimeMiB {
		t.Fatal("guestMemMiB does not follow the stated floor and runtime")
	}
	if !strings.Contains(pool["basis"].(string), "not observed use") || !strings.Contains(pool["pricing"].(string), "share") {
		t.Fatalf("the pool must say what its numbers are: %v", pool)
	}
}

// The 768 is run-domain.sh's, read from it: the unit's MemoryMax above the guest's RAM. If one moves, this fails.
func TestTheUnitOverheadIsRunDomainsMemoryMax(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "m2", "run-domain.sh"))
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`MemoryMax="\$\(\(mem \+ (\d+)\)\)M"`).FindAllSubmatch(b, -1)
	if len(m) != 1 {
		t.Fatalf("run-domain.sh has %d MemoryMax lines of the known shape, want exactly 1", len(m))
	}
	if n, _ := strconv.Atoi(string(m[0][1])); n != unitOverheadMiB {
		t.Fatalf("run-domain.sh lets a unit use mem+%d MiB, but the pool reserves mem+%d", n, unitOverheadMiB)
	}
	if !regexp.MustCompile(`CPUQuota="\$\{quota\}%"`).Match(b) {
		t.Fatal("run-domain.sh no longer sets CPUQuota from the quota the pool reserves")
	}
}

// poolSeam runs the REAL supervisor's GUEST_POOL_SELFTEST against this guestd over guestd-control/1: the supervisor's
// view of the pool comes from vmHealth(), the production path, so a field guestd renames or drops fails here.
func poolSeam(t *testing.T, r *rig, memMb int, resumeOf string) map[string]any {
	t.Helper()
	key := filepath.Join(t.TempDir(), "pair.key")
	_ = os.WriteFile(key, []byte(hex.EncodeToString(testKey)+"\n"), 0o600)
	via := map[string]any{"memMb": memMb}
	if resumeOf != "" {
		via["resumeOf"] = resumeOf // judged as a resume: the supervisor looks up the guest guestd holds for it
	}
	cj, _ := json.Marshal(map[string]any{"viaHealth": via})
	cmd := exec.Command("node", "../../../supervisor.js")
	cmd.Env = append(os.Environ(), "SECRET=test-secret", "GUEST_POOL_SELFTEST="+string(cj), "GUESTD_TRANSPORT_SELFTEST=",
		"ISOLATION_SELFTEST=", "INSTANCE_SELFTEST=", "POOL_SELFTEST=", "SWEEP_SELFTEST=", "REACH_SELFTEST=",
		"ACME_SELFTEST=", "CFG_EDIT_SELFTEST=", "ADDRESS_BOOK_ADDRESS=", "REGISTRY_ENABLED=", "CLAIM_ENABLED=",
		"ACME_EAB_KID=", "ACME_EAB_HMAC=", "APP_CERT_DOMAIN=", "DNS_API=", "NODE_RAM_GB=6", "NODE_VCPUS=4", "NODE_GFLOPS=250",
		"ISOLATION_BACKEND=snp-guest-per-app", "VMMGR_URL="+r.ts.URL, "GUESTD_KEY_FILE="+key)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("supervisor seam: %v %s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var got map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return got
}

func TestTheSupervisorMirrorsThePoolThisGuestdReports(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	if _, err := os.Stat("../../../node_modules"); err != nil {
		t.Skip("the supervisor's node_modules are not installed (npm ci at the repository root)")
	}
	r := newRig(t)
	r.s.Budget = budgetFor(3)
	auth := newControlAuth(testKey, r.s.Now)
	p, _ := r.bundle("A", contract.Policy{})
	if code, _ := r.create(name(1), p); code != 201 { // the rig's own requests go unauthenticated (lab mode)...
		t.Fatal("the first guest")
	}
	r.s.launching.Wait()
	r.s.Auth = auth // ...and the supervisor's over guestd-control/1, as in production
	got := poolSeam(t, r, 128, "")
	node, _ := got["node"].(map[string]any)
	gp, _ := got["guestPool"].(map[string]any)
	if got["healthError"] != nil || node["pool"] != true || node["ramGb"] != float64(3*1792)/1024 || node["vcpus"] != float64(3) {
		t.Fatalf("the supervisor's node is not this guestd's pool: %v", got)
	}
	if gp["heard"] != true || res(gp["allocated"]) != oneGuest || res(gp["free"]) != (reservation{MemMiB: 2 * 1792, CPUPct: 200}) {
		t.Fatalf("the supervisor's pool: %v", gp)
	}
	if got["maxFreeCpu"] != 0.667 || got["healthVerdict"] != nil {
		t.Fatalf("two rooms of three free: maxFreeCpu %v, verdict %v", got["maxFreeCpu"], got["healthVerdict"])
	}
	// full: the supervisor advertises nothing and claims nothing
	r.s.Auth = nil
	for i := 2; i <= 3; i++ {
		if code, _ := r.create(name(i), p); code != 201 {
			t.Fatalf("guest %d", i)
		}
	}
	r.s.launching.Wait()
	r.s.Auth = auth
	got = poolSeam(t, r, 128, "")
	why, _ := got["healthVerdict"].(string)
	if got["maxFreeCpu"] != float64(0) || !strings.Contains(why, "cannot fit this app's guest") {
		t.Fatalf("a full pool: maxFreeCpu %v, verdict %q", got["maxFreeCpu"], why)
	}
	// ...but the RESUME of a guest it already holds passes (the CVM restarted, guestd kept the guest): the supervisor
	// finds it by name in guestd's own listing and counts the room it holds (enclave-99's review of 829ea21b)
	got = poolSeam(t, r, 128, name(1))
	held, _ := got["held"].(map[string]any)
	if got["healthVerdict"] != nil || held == nil || held["name"] != name(1) || res(held["reserved"]) != oneGuest {
		t.Fatalf("the resume of a held guest on a full pool: verdict %v, held %v", got["healthVerdict"], held)
	}
}

type errTest string

func (e errTest) Error() string { return string(e) }

// The live host floor (enclave-99's flag on the 64 GiB budget): a create is admitted only while MemAvailable - R.mem stays
// at or above the floor. Exactly at the floor is admitted; one MiB under is refused, with a stable body.
func TestAHostMemoryFloorAdmitsDownToItAndRefusesBelow(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(4)
	r.s.HostFloorMiB = 16384
	avail := 16384 + oneGuest.MemMiB // exactly room for one guest above the floor
	r.s.MemAvailable = func() (int, error) { return avail, nil }
	r.s.UnitMem = func(string) (int, error) { return oneGuest.MemMiB, nil } // a running guest that holds all of its room
	p, _ := r.bundle("A", contract.Policy{})
	if code, body := r.create(name(1), p); code != 201 {
		t.Fatalf("a guest that leaves exactly the floor: %d %v", code, body)
	}
	r.s.launching.Wait()
	avail -= 1 // the host lost a MiB elsewhere (a build, /tmp): the same guest no longer fits
	builds := r.f.builds
	code, body := r.create(name(2), p)
	if code != 507 || body["error"] != "host_memory_low" || body["floorMiB"] != float64(16384) || res(body["needs"]) != oneGuest || r.f.builds != builds {
		t.Fatalf("one MiB under the floor: %d %v (builds %d -> %d)", code, body, builds, r.f.builds)
	}
	// enclave-e3: the refusal travels on (the supervisor's public claim-hint states its reason), so it carries neither
	// the host's MemAvailable nor what is pending nor the remainder: only the floor, which is configuration
	for _, k := range []string{"hostMemAvailableMiB", "pendingMiB", "memAvailableMiB"} {
		if _, ok := body[k]; ok {
			t.Fatalf("the refusal carries %s: %v", k, body)
		}
	}
	if d, _ := body["detail"].(string); strings.Contains(d, strconv.Itoa(avail)) || strings.Contains(d, strconv.Itoa(avail-oneGuest.MemMiB)) || !strings.Contains(d, "16384") {
		t.Fatalf("the refusal text: %q", d)
	}
	pool := r.pool()
	h, _ := pool["host"].(map[string]any)
	if h["floorMiB"] != float64(16384) || h["memAvailableMiB"] != float64(avail) {
		t.Fatalf("/health.pool.host: %v", h)
	}
}

func TestAnUnreadableHostMemoryRefusesEveryCreate(t *testing.T) {
	r := newRig(t)
	r.s.HostFloorMiB = 16384
	r.s.MemAvailable = func() (int, error) { return 0, errTest("no /proc/meminfo") }
	p, _ := r.bundle("A", contract.Policy{})
	code, body := r.create(name(1), p)
	if code != 507 || body["error"] != "host_memory_unknown" || r.f.builds != 0 {
		t.Fatalf("an unreadable MemAvailable must refuse: %d %v", code, body)
	}
	if h, _ := r.pool()["host"].(map[string]any); h["memAvailableMiB"] != nil {
		t.Fatalf("an unreadable reading is reported as null: %v", h)
	}
}

func TestTheFloorOffNeverReadsTheHostAndAdoptionIgnoresIt(t *testing.T) {
	r := newRig(t)
	reads := 0
	r.s.MemAvailable = func() (int, error) { reads++; return 1, nil } // a host that would refuse everything
	p, _ := r.bundle("A", contract.Policy{})
	if code, _ := r.create(name(1), p); code != 201 || reads != 0 {
		t.Fatalf("floor 0 must not read or refuse: reads %d", reads)
	}
	r.s.launching.Wait()
	// a restart WITH a floor, on a host far below it: the running guest is adopted, not refused
	s2 := newServer(r.f, r.s.Root)
	s2.Now, s2.Budget, s2.HostFloorMiB = r.s.Now, r.s.Budget, 1<<20
	s2.MemAvailable = func() (int, error) { return 1, nil }
	if _, adopted, dropped := s2.adoptOnBoot(context.Background()); len(adopted) != 1 || len(dropped) != 0 {
		t.Fatalf("adoption must ignore the host floor: adopted %v dropped %v", adopted, dropped)
	}
}

func TestReadMemAvailableParsesProcMeminfo(t *testing.T) {
	if _, err := os.Stat("/proc/meminfo"); err != nil {
		t.Skip("no /proc/meminfo here")
	}
	n, err := readMemAvailableMiB()
	if err != nil || n <= 0 {
		t.Fatalf("readMemAvailableMiB: %d %v", n, err)
	}
}

// The real supervisor reads guestd's real host block over guestd-control/1: a host one MiB short of the floor is refused
// by the supervisor's gate and advertised as nothing free (no field drift between pool.go and supervisor.js).
func TestTheSupervisorMirrorsTheHostFloorThisGuestdReports(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	if _, err := os.Stat("../../../node_modules"); err != nil {
		t.Skip("the supervisor's node_modules are not installed (npm ci at the repository root)")
	}
	r := newRig(t)
	r.s.Budget = budgetFor(3)
	r.s.HostFloorMiB = 16384
	r.s.MemAvailable = func() (int, error) { return 16384 + oneGuest.MemMiB - 1, nil }
	r.s.Auth = newControlAuth(testKey, r.s.Now)
	got := poolSeam(t, r, 128, "")
	gp, _ := got["guestPool"].(map[string]any)
	h, _ := gp["host"].(map[string]any)
	why, _ := got["healthVerdict"].(string)
	// the supervisor publishes the floor's VERDICT, never the host's live MemAvailable (enclave-99 #4)
	if h["floorMiB"] != float64(16384) || h["admitsSmallestGuest"] != false || h["memAvailableMiB"] != nil {
		t.Fatalf("the supervisor's host block: %v", gp)
	}
	if got["maxFreeCpu"] != float64(0) || !strings.Contains(why, "too low on memory") {
		t.Fatalf("a host one MiB short: maxFreeCpu %v, verdict %q", got["maxFreeCpu"], why)
	}
}

// enclave-99 #1: a guest admitted but still STARTING has not taken its RAM, so MemAvailable cannot show it. With room above
// the floor for exactly one guest, two back-to-back creates must admit ONE: the second counts the first as pending.
func TestAStartingGuestCountsAgainstTheFloorUntilItRuns(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(4)
	r.s.HostFloorMiB = 16384
	r.s.MemAvailable = func() (int, error) { return 16384 + oneGuest.MemMiB, nil } // the host does not see the first guest yet
	r.s.UnitMem = func(string) (int, error) { return oneGuest.MemMiB, nil }        // once running, it holds all of its room
	r.f.startGate = make(chan struct{})                                            // the first guest stays starting
	p, _ := r.bundle("A", contract.Policy{})
	if code, body := r.create(name(1), p); code != 201 {
		t.Fatalf("the first guest: %d %v", code, body)
	}
	code, body := r.create(name(2), p)
	if code != 507 || body["error"] != "host_memory_low" {
		t.Fatalf("the second, while the first is starting: %d %v", code, body)
	}
	if h, _ := r.pool()["host"].(map[string]any); h["pendingMiB"] != float64(oneGuest.MemMiB) {
		t.Fatalf("/health.pool.host pendingMiB: %v", h)
	}
	close(r.f.startGate)
	r.s.launching.Wait()
	r.f.startGate = nil
	if h, _ := r.pool()["host"].(map[string]any); h["pendingMiB"] != float64(0) {
		t.Fatalf("a running guest is no longer pending: %v", h)
	}
}

// enclave-99 #3: MemAvailable is in kB (KiB): MiB = kB / 1024, rounded down. A /1000 slip would fail OPEN by ~2.4%.
func TestParseMemAvailableIsKiBToMiBRoundedDown(t *testing.T) {
	fixture := "MemTotal:       130876608 kB\nMemFree:        13456076 kB\nMemAvailable:   86030360 kB\nBuffers:         4473996 kB\n"
	n, err := parseMemAvailableMiB(strings.NewReader(fixture))
	if err != nil || n != 84014 { // 86030360 / 1024 = 84014.02; a /1000 slip would give 86030
		t.Fatalf("parse: %d %v, want 84014", n, err)
	}
	if n, err := parseMemAvailableMiB(strings.NewReader("MemAvailable:   1023 kB\n")); err != nil || n != 0 {
		t.Fatalf("under 1 MiB rounds down to 0: %d %v", n, err)
	}
	for _, bad := range []string{"MemTotal: 1 kB\n", "MemAvailable: lots kB\n", ""} {
		if _, err := parseMemAvailableMiB(strings.NewReader(bad)); err == nil {
			t.Fatalf("%q must be an error", bad)
		}
	}
}

// enclave-e3: SNP memory is allocated as the guest touches it (a memfd backend without prealloc; a Linux guest may accept
// lazily), so a RUNNING guest may still draw up to its unit's MemoryMax. What it may still draw is its reservation minus
// what its unit holds, and it counts against the floor; so the floor holds even if every guest grows to its ceiling.
func TestARunningGuestCountsWhatItMayStillDraw(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(4)
	r.s.HostFloorMiB = 16384
	held := 1067 // what a live canary's unit holds of its 1792 MiB (warden-host, 09-25)
	r.s.UnitMem = func(string) (int, error) { return held, nil }
	avail := 16384 + oneGuest.MemMiB + (oneGuest.MemMiB - held) // room for one more guest only if the first's rest is counted
	r.s.MemAvailable = func() (int, error) { return avail, nil }
	p, _ := r.bundle("A", contract.Policy{})
	if code, body := r.create(name(1), p); code != 201 {
		t.Fatalf("the first guest: %d %v", code, body)
	}
	r.s.launching.Wait()
	h, _ := r.pool()["host"].(map[string]any)
	if h["pendingMiB"] != float64(oneGuest.MemMiB-held) || h["unreadUnits"] != float64(0) {
		t.Fatalf("a running guest holding %d of %d MiB: %v", held, oneGuest.MemMiB, h)
	}
	if code, body := r.create(name(2), p); code != 201 {
		t.Fatalf("exactly room for the second with the first's rest counted: %d %v", code, body)
	}
	r.s.launching.Wait()
	avail-- // one MiB less: the third cannot fit whatever the first two already hold
	if code, body := r.create(name(3), p); code != 507 || body["error"] != "host_memory_low" {
		t.Fatalf("the third: %d %v", code, body)
	}
	// a unit that cannot be read counts its WHOLE reservation, and a running one is reported as unread
	r.s.UnitMem = func(string) (int, error) { return 0, errTest("no cgroup") }
	h, _ = r.pool()["host"].(map[string]any)
	if h["pendingMiB"] != float64(2*oneGuest.MemMiB) || h["unreadUnits"] != float64(2) {
		t.Fatalf("unreadable units: %v", h)
	}
	// a unit holding MORE than its reservation (page cache charged to it) draws nothing more: never negative
	r.s.UnitMem = func(string) (int, error) { return oneGuest.MemMiB + 500, nil }
	if h, _ = r.pool()["host"].(map[string]any); h["pendingMiB"] != float64(0) {
		t.Fatalf("a unit over its reservation: %v", h)
	}
}

// A guest that fails to start holds its room only until its reclaim finishes, like the budget: then nothing is pending.
func TestAFailedStartLeavesNothingPendingOnceReclaimed(t *testing.T) {
	r := newRig(t)
	r.s.Budget = budgetFor(4)
	r.s.HostFloorMiB = 16384
	r.s.MemAvailable = func() (int, error) { return 1 << 20, nil }
	r.s.UnitMem = func(string) (int, error) { return 0, errTest("the unit is gone") }
	r.f.verifyErr = errTest("the guest does not verify")
	p, _ := r.bundle("A", contract.Policy{})
	if code, body := r.create(name(1), p); code != 201 {
		t.Fatalf("create: %d %v", code, body)
	}
	r.s.launching.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for {
		pool := r.pool()
		h, _ := pool["host"].(map[string]any)
		if h["pendingMiB"] == float64(0) && h["unreadUnits"] == float64(0) && res(pool["allocated"]) == (reservation{}) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a failed start still holds: %v", pool)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// The unit's memory is read beside guestd's own cgroup (systemd-run --user puts both in app.slice), in MiB rounded DOWN;
// anything unexpected is an error (and its guest then counts its whole reservation).
func TestReadUnitMemMiBReadsTheSiblingCgroup(t *testing.T) {
	d := t.TempDir()
	self := filepath.Join(d, "self")
	root := filepath.Join(d, "cg")
	app := filepath.Join(root, "user.slice", "user-1000.slice", "user@1000.service", "app.slice")
	unit := filepath.Join(app, "m2-gdab-1.service")
	if err := os.MkdirAll(unit, 0o755); err != nil {
		t.Fatal(err)
	}
	must := func(p, b string) {
		if err := os.WriteFile(p, []byte(b), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	must(self, "0::/user.slice/user-1000.slice/user@1000.service/app.slice/enclave-guestd.service\n")
	must(filepath.Join(unit, "memory.current"), "1118830592\n") // 1067.0 MiB (a live canary)
	for _, u := range []string{"m2-gdab-1", "m2-gdab-1.service"} {
		if n, err := readUnitMemMiB(self, root, u); err != nil || n != 1067 {
			t.Fatalf("%s: %d %v", u, n, err)
		}
	}
	must(filepath.Join(unit, "memory.current"), "1118830591\n") // one byte under 1067 MiB rounds DOWN to 1066
	if n, _ := readUnitMemMiB(self, root, "m2-gdab-1"); n != 1066 {
		t.Fatalf("rounding: %d", n)
	}
	for what, u := range map[string]string{"missing": "m2-gdcd-2", "a path": "../app.slice/m2-gdab-1", "dotted": ".hidden"} {
		if _, err := readUnitMemMiB(self, root, u); err == nil {
			t.Fatalf("%s must be an error", what)
		}
	}
	must(filepath.Join(unit, "memory.current"), "lots\n")
	if _, err := readUnitMemMiB(self, root, "m2-gdab-1"); err == nil {
		t.Fatal("a non-number must be an error")
	}
	// a hybrid host lists v1 hierarchies too: only the v2 line (0::) names guestd's cgroup
	must(self, "1:name=systemd:/elsewhere/enclave-guestd.service\n0::/user.slice/user-1000.slice/user@1000.service/app.slice/enclave-guestd.service\n")
	must(filepath.Join(unit, "memory.current"), "1118830592\n")
	if n, err := readUnitMemMiB(self, root, "m2-gdab-1"); err != nil || n != 1067 {
		t.Fatalf("hybrid: %d %v", n, err)
	}
	must(self, "1:name=systemd:/x\n") // no cgroup v2 line
	if _, err := readUnitMemMiB(self, root, "m2-gdab-1"); err == nil {
		t.Fatal("no cgroup v2 path must be an error")
	}
}
