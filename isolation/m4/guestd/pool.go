// pool.go - the guest pool: what guestd may hand to guests on this host, what the guests it owns hold of it, and what is
// left (TASK 4c, reviewed with enclave-5d and enclave-99). guestd is the authority; the supervisor mirrors /health.pool.
//
//   - The BUDGET B is the operator's: -guest-mem-mib and -guest-cpus, host RAM and CPU set aside for guests. Without it
//     guestd refuses every create (it cannot keep a promise it has no number for) and still adopts on recovery.
//   - A guest's RESERVATION R is its unit's ceilings, not what it happens to use: memory = the guest's RAM plus the
//     unit's QEMU allowance (run-domain.sh: MemoryMax = mem + 768), cpu = its CPUQuota (policy cpuPercent; 100 = one
//     core). The 768 is a CAP, reserved whole on purpose: the host lets the unit use it, so the pool must have it. Do
//     not "reclaim" it by measuring use. vCPUs (-smp) are reported, not budgeted: the quota is the real CPU cap.
//   - R is HELD from the create that accepts it until that guest's reclaim has finished (vm.reclaimed): starting,
//     running, and a failed start whose unit is still being stopped. A record whose reclaim finished, and a removed
//     one, hold nothing. `allocated` is SUMMED from the held set on every read - no counter, so nothing to drift and
//     nothing to release twice.
//   - Admission: allocated + R <= B on both axes, checked and inserted under one s.mu. Otherwise 507 with a stable
//     {"error":"pool_full", needs, free}. The supervisor refuses such a claim from /health.pool before it is ever made,
//     so a 507 means a race, never steady state.
//   - Recovery: every guest that re-verifies is adopted and counts (ending a verified tenant is an availability
//     decision, not accounting). If that leaves allocated > B the pool is OVERCOMMITTED: free is 0, every create is
//     refused, nothing is killed, and creates resume as guests end.
//   - `allocated` is reservations ONLY, never observed use, and observed use never feeds admission.
//   - Pricing is NOT this ledger. On this tier a deployment's share is a price unit, a fraction of B at the host's posted
//     price, while its guest reserves R: a 128 MB app's 1% share is priced at 1% of B and its guest reserves ~1792 MiB.
//     Admission uses R, never the share. The gap is a pricing question for the operator, not a correctness one.
//   - B is the host's own configuration. It is no security claim and is in no attested statement: a host that lies
//     about its pool costs only availability, which the host controls anyway.
package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	guestFloorMiB   = 1024 // the least RAM a guest boots with: the kernel and the 45 MB runtime, whatever the manifest asked
	guestRuntimeMiB = 384  // what a guest gets on top of its policy's memory, for the same kernel and runtime
	unitOverheadMiB = 768  // run-domain.sh: MemoryMax="$((mem + 768))M", the unit's QEMU allowance above the guest's RAM (a CAP)
)

// poolBudget is what guestd may hand to guests. The zero value is "not configured": every create is refused.
type poolBudget struct {
	MemMiB int `json:"memMiB"`
	CPUPct int `json:"cpuPct"` // 100 = one core
}

// reservation is what one guest holds of the pool: its unit's ceilings.
type reservation struct {
	MemMiB int `json:"memMiB"`
	CPUPct int `json:"cpuPct"`
}

func (b poolBudget) configured() bool { return b.MemMiB > 0 && b.CPUPct > 0 }

// reservationFor is the reservation of a guest launched with this RAM and CPU quota.
func reservationFor(guestMem, cpuPct int) reservation {
	return reservation{MemMiB: guestMem + unitOverheadMiB, CPUPct: cpuPct}
}

func (v *vm) reservation() reservation { return reservationFor(v.MemMiB, v.CPUPct) }

// holds reports whether v holds its reservation: from accept until its reclaim has finished. s.mu must be held.
func (v *vm) holds() bool { return !v.reclaimed }

// allocatedLocked sums the reservations of the guests that hold one. s.mu must be held.
func (s *server) allocatedLocked() (reservation, int) {
	var a reservation
	n := 0
	for _, v := range s.vms {
		if v.holds() {
			r := v.reservation()
			a.MemMiB += r.MemMiB
			a.CPUPct += r.CPUPct
			n++
		}
	}
	return a, n
}

// freeOf is what is left of b after a, never negative (an overcommitted pool has nothing free).
func freeOf(b poolBudget, a reservation) reservation {
	f := reservation{MemMiB: b.MemMiB - a.MemMiB, CPUPct: b.CPUPct - a.CPUPct}
	if f.MemMiB < 0 || f.CPUPct < 0 || !b.configured() {
		return reservation{}
	}
	return f
}

func overcommitted(b poolBudget, a reservation) bool {
	return b.configured() && (a.MemMiB > b.MemMiB || a.CPUPct > b.CPUPct)
}

// admitLocked decides whether a new guest with reservation r fits: nil, or the stable refusal body. s.mu must be held.
func (s *server) admitLocked(r reservation) map[string]any {
	if !s.Budget.configured() {
		log.Printf("REFUSED a create: no guest budget is configured (start guestd with -guest-mem-mib and -guest-cpus)")
		return map[string]any{"error": "pool_unconfigured", "needs": r,
			"detail": "this host has configured no guest budget (-guest-mem-mib, -guest-cpus), so it admits no guest"}
	}
	a, _ := s.allocatedLocked()
	free := freeOf(s.Budget, a)
	if r.MemMiB > free.MemMiB || r.CPUPct > free.CPUPct {
		why := "the guest pool cannot fit this guest"
		if overcommitted(s.Budget, a) {
			why = "the guest pool is overcommitted (recovered guests exceed the budget); nothing is admitted until guests end"
		}
		return map[string]any{"error": "pool_full", "needs": r, "free": free, "detail": why}
	}
	return s.hostRefusal(r)
}

// The LIVE host check (enclave-99, on the 64 GiB budget). The budget is the operator's promise; MemAvailable is what the
// host actually has, and a guest's RAM is PINNED (SEV: it is never swapped or reclaimed), so a /tmp or build surge on a
// shared host cannot give it back. With HostFloorMiB > 0 a create is admitted only if MemAvailable - R.mem stays at or
// above the floor; an unreadable MemAvailable refuses (fail closed). 0 = off, and the start log says so. Adoption never
// checks it: the guests that exist already hold their memory.
func readMemAvailableMiB() (int, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	return parseMemAvailableMiB(f)
}

// parseMemAvailableMiB reads a /proc/meminfo body: MemAvailable is in kB (KiB), so MiB = kB / 1024, rounded DOWN.
func parseMemAvailableMiB(r io.Reader) (int, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		if fs := strings.Fields(sc.Text()); len(fs) >= 2 && fs[0] == "MemAvailable:" {
			kb, err := strconv.Atoi(fs[1])
			if err != nil || kb < 0 {
				return 0, errors.New("MemAvailable is not a number")
			}
			return kb / 1024, nil
		}
	}
	return 0, errors.New("no MemAvailable line in /proc/meminfo")
}

func (s *server) memAvailableMiB() (int, error) {
	if s.MemAvailable != nil {
		return s.MemAvailable()
	}
	return readMemAvailableMiB()
}

// pendingLocked is the memory the guests guestd holds may STILL draw from the host, beyond what MemAvailable already
// shows: a STARTING guest has taken none of its RAM (enclave-99), so its whole reservation counts; a RUNNING one has taken
// what its unit holds now, and SNP memory is allocated as the guest first touches it (the backend is a memfd without
// prealloc, and a Linux guest may accept lazily), so its reservation MINUS that counts (enclave-e3); so does one that
// ended and is not reclaimed yet. A guest whose unit cannot be read counts its whole reservation (a running one is
// reported in unread). So the floor holds even if every
// guest grows to its unit's MemoryMax (R.mem). s.mu must be held: it reads sysfs, it runs no command.
func (s *server) pendingLocked() (pending, unread int) {
	for _, v := range s.vms {
		if !v.holds() {
			continue
		}
		r := v.reservation().MemMiB
		if v.Status == "starting" || v.unit == "" {
			pending += r
			continue
		}
		// running, or ended and not yet reclaimed (its room is held until then): what its unit may still draw
		held, err := s.unitMemMiB(v.unit)
		if err != nil {
			pending += r
			if v.Status == "running" {
				unread++
			}
			continue
		}
		if held < r {
			pending += r - held
		}
	}
	return pending, unread
}

// unitMemMiB is what a guest's unit holds now: its cgroup v2 memory.current, in MiB rounded DOWN, so what it may still
// draw (R.mem minus this) is never undercounted.
func (s *server) unitMemMiB(unit string) (int, error) {
	if s.UnitMem != nil {
		return s.UnitMem(unit)
	}
	return readUnitMemMiB("/proc/self/cgroup", "/sys/fs/cgroup", unit)
}

// readUnitMemMiB finds the unit's cgroup beside guestd's own: systemd-run --user (run-domain.sh) puts a transient
// service in app.slice, where enclave-guestd.service runs too. A guestd run from anywhere else reads nothing, and every
// running guest then counts its whole reservation (reported as unread; conservative, never open).
func readUnitMemMiB(selfCgroup, cgroupRoot, unit string) (int, error) {
	name := unit
	if !strings.HasSuffix(name, ".service") {
		name += ".service"
	}
	if strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		return 0, fmt.Errorf("unit %q is not a plain unit name", unit)
	}
	b, err := os.ReadFile(selfCgroup)
	if err != nil {
		return 0, err
	}
	own := ""
	for _, l := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(l, "0::/") {
			own = strings.TrimPrefix(l, "0::")
		}
	}
	if own == "" {
		return 0, errors.New("guestd's own cgroup (v2) is unknown")
	}
	m, err := os.ReadFile(filepath.Join(cgroupRoot, filepath.Dir(own), name, "memory.current"))
	if err != nil {
		return 0, err
	}
	n, err := strconv.ParseInt(strings.TrimSpace(string(m)), 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s memory.current is not a number", name)
	}
	return int(n >> 20), nil
}

// hostRefusal is the live-memory refusal for a guest reserving r, or nil. s.mu must be held.
func (s *server) hostRefusal(r reservation) map[string]any {
	if s.HostFloorMiB <= 0 {
		return nil
	}
	pending, _ := s.pendingLocked()
	avail, err := s.memAvailableMiB()
	if err != nil {
		log.Printf("REFUSED a create: the host's available memory cannot be read (%v)", err)
		return map[string]any{"error": "host_memory_unknown", "needs": r, "floorMiB": s.HostFloorMiB,
			"detail": "the host's available memory cannot be read, so no guest is admitted: " + err.Error()}
	}
	if avail-pending-r.MemMiB < s.HostFloorMiB {
		// the host's numbers go to this host's own log only: the body carries none of MemAvailable, pending or the
		// remainder, because a refusal's text travels on (the supervisor's public claim-hint states its reason; enclave-e3)
		log.Printf("REFUSED a create: MemAvailable %d MiB - %d MiB the held guests may still draw - %d MiB for this guest is under the %d MiB floor",
			avail, pending, r.MemMiB, s.HostFloorMiB)
		return map[string]any{"error": "host_memory_low", "needs": r, "floorMiB": s.HostFloorMiB,
			"detail": fmt.Sprintf("admitting this guest would take the host under its %d MiB memory floor", s.HostFloorMiB)}
	}
	return nil
}

// poolLocked is /health.pool. s.mu must be held.
func (s *server) poolLocked() map[string]any {
	a, n := s.allocatedLocked()
	var budget any // null when not configured
	if s.Budget.configured() {
		budget = s.Budget
	}
	host := map[string]any{"floorMiB": s.HostFloorMiB, "memAvailableMiB": nil, "pendingMiB": 0, "unreadUnits": 0} // null = unread (floor off) or unreadable
	if s.HostFloorMiB > 0 {
		host["pendingMiB"], host["unreadUnits"] = s.pendingLocked()
		if avail, err := s.memAvailableMiB(); err == nil {
			host["memAvailableMiB"] = avail
		}
	}
	return map[string]any{
		"budget": budget, "allocated": a, "free": freeOf(s.Budget, a), "guests": n, "host": host,
		"overcommitted": overcommitted(s.Budget, a),
		// how a guest's reservation follows from its policy, so a consumer sizes a claim exactly as guestd admits it:
		// memMiB = max(floorMiB, policy memMiB + runtimeMiB) + unitOverheadMiB, cpuPct = policy cpuPercent
		"perGuest": map[string]int{"floorMiB": guestFloorMiB, "runtimeMiB": guestRuntimeMiB, "unitOverheadMiB": unitOverheadMiB},
		"basis":    "allocated = the reservations of the guests guestd holds (each unit's MemoryMax and CPUQuota), not observed use",
		"pricing":  "a deployment's share is priced as a fraction of the budget; its guest reserves its own reservation, which admission uses",
	}
}

// logPoolAfterRecovery states the pool once adoption has run, loudly when it is unconfigured or overcommitted.
func (s *server) logPoolAfterRecovery() {
	s.mu.Lock()
	a, n := s.allocatedLocked()
	b := s.Budget
	s.mu.Unlock()
	switch {
	case !b.configured():
		log.Printf("NO GUEST BUDGET: -guest-mem-mib/-guest-cpus are unset, so every create is REFUSED (%d adopted guest(s) keep running)", n)
	case overcommitted(b, a):
		log.Printf("GUEST POOL OVERCOMMITTED after recovery: %d guest(s) hold %s of %s; nothing is admitted until guests end, nothing is killed",
			n, fmtRes(a), fmtRes(reservation(b)))
	default:
		log.Printf("guest pool: %d guest(s) hold %s of %s", n, fmtRes(a), fmtRes(reservation(b)))
	}
	if s.HostFloorMiB <= 0 {
		log.Printf("host memory floor OFF (-guest-host-floor-mib 0): admission checks the budget only, not the host's live MemAvailable")
	} else if avail, err := s.memAvailableMiB(); err != nil {
		log.Printf("host memory floor %d MiB, but MemAvailable cannot be read (%v): every create is REFUSED", s.HostFloorMiB, err)
	} else {
		log.Printf("host memory floor %d MiB: MemAvailable now %d MiB", s.HostFloorMiB, avail)
	}
}

func fmtRes(r reservation) string { return fmt.Sprintf("%d MiB / %d%% CPU", r.MemMiB, r.CPUPct) }
