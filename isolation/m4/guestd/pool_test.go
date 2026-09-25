package main

import (
	"context"
	"net/http/httptest"
	"os"
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

type errTest string

func (e errTest) Error() string { return string(e) }
