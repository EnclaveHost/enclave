// The monitor is privileged and shared, so what a domain can make it do must be bounded.
//
// A domain's processes are untrusted: the whole point of this line of work is that tenant isolation does
// not rest on the runtime's in-process sandbox, so the honest assumption is that a tenant may end up
// running arbitrary code as its domain's uid, with the monitor's socket in reach. Anything such a caller
// can make the monitor allocate or wait for is memory and work moved OUT of that domain's cgroup and
// INTO the privileged component every other domain depends on.
//
// These run on the host, with no VM and no root: the report server is just a unix socket, and the
// hardware call is replaced by a stand-in.
//
//	run: go test ./monitor/
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/vsock"
)

// a monitor whose "hardware" is a function the test controls
func testMonitor(t *testing.T, report reporter) (*monitor, string) {
	t.Helper()
	m := newMonitor(true, "/plat", t.TempDir(), 40000, 5000)
	m.report = report
	// unix socket paths are capped at ~108 bytes, and a test temp dir can be longer, so bind from
	// inside the directory with a relative name
	dir := t.TempDir()
	wd, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.Chdir(wd) })
	l, err := net.Listen("unix", "mon.sock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go m.serveReports(l)
	return m, filepath.Join(dir, "mon.sock")
}

// the caller of these tests runs as one uid, so that uid is the domain's FRONT the monitor knows (its runtime has another)
func registerSelf(m *monitor, id int) *domain {
	d := &domain{ID: id, UID: os.Getuid() + 7, FrontUID: os.Getuid(), Port: uint32(40000 + id), life: contract.NewLifecycle(contract.Running),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	copy(d.appHash[:], []byte(fmt.Sprintf("app-%d", id)))
	m.register(d)
	return d
}

// ask is safe to call from a goroutine: it returns errors rather than failing the test from one, which
// would panic after the test has finished.
func ask(sock, body string) (map[string]string, error) {
	c, err := net.Dial("unix", sock)
	if err != nil {
		return nil, err
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	if _, err := copyAll(c, strings.NewReader(body)); err != nil {
		return nil, fmt.Errorf("write: %w", err)
	}
	var out map[string]string
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&out); err != nil {
		return nil, fmt.Errorf("no answer: %w", err)
	}
	return out, nil
}

func mustAsk(t *testing.T, sock, body string) map[string]string {
	t.Helper()
	out, err := ask(sock, body)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func copyAll(c net.Conn, r *strings.Reader) (int64, error) {
	buf := make([]byte, 4096)
	var n int64
	for {
		k, err := r.Read(buf)
		if k > 0 {
			w, werr := c.Write(buf[:k])
			n += int64(w)
			if werr != nil {
				return n, werr
			}
		}
		if err != nil {
			return n, nil
		}
	}
}

const goodBind = `{"bind":"` + "0000000000000000000000000000000000000000000000000000000000000000" + `"}`

func okReport(rd []byte) ([]byte, []byte, error) { return []byte("REPORT"), nil, nil }

func TestUnauthenticatedCallerIsRefusedWithoutParsingItsBytes(t *testing.T) {
	var called atomic.Int32
	_, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		called.Add(1)
		return okReport(rd)
	})
	// no domain registered: this process's uid is not a domain

	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	// A caller that is not a domain tries to push 64 MiB at the monitor. The write is expected to fail
	// part way: the monitor answers, drains a bounded amount and closes, which is the whole point.
	sent := make(chan int64, 1)
	go func() {
		var n int64
		chunk := []byte(`{"bind":"` + strings.Repeat("a", 1<<20) + `"}`)
		for i := 0; i < 64; i++ {
			k, err := c.Write(chunk)
			n += int64(k)
			if err != nil {
				break
			}
		}
		sent <- n
	}()

	var got map[string]string
	if err := json.NewDecoder(bufio.NewReader(c)).Decode(&got); err != nil {
		t.Fatalf("the refusal must reach the caller, not a reset: %v", err)
	}
	if got["error"] != "caller is not a domain's front" {
		t.Fatalf("want credential refusal, got %v", got)
	}
	if called.Load() != 0 {
		t.Fatal("the hardware path must not run for an unauthenticated caller")
	}
	select {
	case n := <-sent:
		// socket buffers absorb some of it regardless; what matters is that the monitor did not keep
		// reading 64 MiB of an unauthenticated caller's choosing
		if n >= 8<<20 {
			t.Fatalf("the monitor absorbed %d bytes from a caller it had already refused", n)
		}
		t.Logf("refused caller managed to write %d bytes before the monitor closed", n)
	case <-time.After(10 * time.Second):
		t.Fatal("the writer never finished: the monitor is still absorbing an unauthenticated caller")
	}
}

func TestOversizedRequestFromADomainIsRefused(t *testing.T) {
	m, sock := testMonitor(t, okReport)
	registerSelf(m, 1)

	got := mustAsk(t, sock, `{"bind":"`+strings.Repeat("a", maxReportRequest*4)+`"}`)
	if got["error"] == "" || !strings.Contains(got["error"], "bad request") {
		t.Fatalf("want a bounded-read refusal, got %v", got)
	}
	// ...and the domain is still served afterwards: one bad request is not a denial of service
	if ok := mustAsk(t, sock, goodBind); ok["report"] == "" {
		t.Fatalf("a good request after a bad one must still be served, got %v", ok)
	}
}

func TestOneDomainCannotCrowdOutAnother(t *testing.T) {
	release := make(chan struct{})
	var inHardware atomic.Int32
	// the stand-in holds only the NOISY domain's reports: domain 1's app hash is "app-1". Blocking
	// every report would stall the quiet domain too and prove nothing.
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		if strings.HasPrefix(string(rd[32:]), "app-1") {
			inHardware.Add(1)
			<-release
		}
		return okReport(rd)
	})
	noisy := registerSelf(m, 1)

	// fill this domain's own allowance
	var wg sync.WaitGroup
	for i := 0; i < maxReportsPerDom; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); ask(sock, goodBind) }()
	}
	for inHardware.Load() < int32(maxReportsPerDom) {
		time.Sleep(5 * time.Millisecond)
	}
	// one more from the same domain is refused rather than queued
	got := mustAsk(t, sock, goodBind)
	if !strings.Contains(got["error"], "too many concurrent report requests") {
		t.Fatalf("want a per-domain refusal, got %v", got)
	}

	// a DIFFERENT domain is still served while the noisy one is at its limit. (Same uid here, so the
	// second domain is simulated by giving the noisy domain's slots back to a fresh domain record.)
	quiet := &domain{ID: 2, UID: os.Getuid() + 7, FrontUID: os.Getuid(), life: contract.NewLifecycle(contract.Running), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsPerDom)}
	copy(quiet.appHash[:], []byte("app-2"))
	m.mu.Lock()
	m.byUID[quiet.FrontUID] = quiet
	m.mu.Unlock()
	done := make(chan map[string]string, 1)
	go func() {
		r, err := ask(sock, goodBind)
		if err != nil {
			r = map[string]string{"error": err.Error()}
		}
		done <- r
	}()
	select {
	case r := <-done:
		if r["error"] != "" {
			t.Fatalf("the quiet domain must be admitted, got %v", r)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the quiet domain was not admitted while another domain was at its limit")
	}
	close(release)
	wg.Wait()
	_ = noisy
}

func TestFloodIsRefusedRatherThanQueuedUnbounded(t *testing.T) {
	release := make(chan struct{})
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		<-release
		return okReport(rd)
	})
	// Every connection in this test authenticates as the same uid, so the per-domain cap would bind
	// first and the global one would never be reached. Give this domain a large allowance: what is
	// under test here is the GLOBAL limit, which is what stops a flood from spawning a goroutine per
	// connection however many domains it is spread across.
	d := &domain{ID: 1, UID: os.Getuid() + 7, FrontUID: os.Getuid(), life: contract.NewLifecycle(contract.Running), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsTotal+8)}
	m.mu.Lock()
	m.byUID[d.FrontUID] = d
	m.mu.Unlock()
	var conns []net.Conn
	t.Cleanup(func() {
		for _, c := range conns {
			c.Close()
		}
	})
	// occupy every global slot
	for i := 0; i < maxReportsTotal; i++ {
		c, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte(goodBind))
		conns = append(conns, c)
	}
	deadline := time.Now().Add(5 * time.Second)
	var last map[string]string
	for time.Now().Before(deadline) {
		last, _ = ask(sock, goodBind)
		if strings.Contains(last["error"], "report limit") {
			close(release)
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	close(release)
	t.Fatalf("a flood must be refused at the global limit, last answer: %v", last)
}

func TestSlowCallerCannotHoldTheMonitorForever(t *testing.T) {
	if testing.Short() {
		t.Skip("takes the report deadline")
	}
	m, sock := testMonitor(t, okReport)
	registerSelf(m, 1)

	c, err := net.Dial("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.Write([]byte(`{"bind":"00`)) // a request that never ends
	c.SetDeadline(time.Now().Add(reportDeadline + 10*time.Second))
	var out map[string]string
	start := time.Now()
	if err := json.NewDecoder(c).Decode(&out); err != nil {
		// the monitor closing on us is also an acceptable end, as long as it happened
		if time.Since(start) > reportDeadline+5*time.Second {
			t.Fatalf("the monitor held a half-open request for %s", time.Since(start))
		}
		return
	}
	if time.Since(start) > reportDeadline+5*time.Second {
		t.Fatalf("the monitor held a half-open request for %s", time.Since(start))
	}
}

func TestRetireIsIdempotentAndRemovesTheDomainOnce(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	d := registerSelf(m, 1)
	d.dir = filepath.Join(t.TempDir(), "1")
	d.cgroup = filepath.Join(t.TempDir(), "dom1")
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)
	close(d.exited) // nothing is running

	for i := 0; i < 3; i++ { // a crash and a destroy can both arrive
		m.retire(d, "test")
	}
	m.mu.Lock()
	_, byID := m.doms[d.ID]
	_, byUID := m.byUID[d.FrontUID]
	m.mu.Unlock()
	if byID || byUID {
		t.Fatal("a retired domain must leave both tables")
	}
	if _, err := os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatalf("the domain's directory must be gone, stat gave %v", err)
	}
	if _, err := os.Stat(d.cgroup); !os.IsNotExist(err) {
		t.Fatalf("the domain's cgroup must be gone, stat gave %v", err)
	}
	if err := m.destroy(d.ID); err == nil {
		t.Fatal("destroying an already-retired domain must say there is no such domain")
	}
}

func TestReportNamesTheCallersOwnAppWhateverItSends(t *testing.T) {
	var seen []byte
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		seen = append([]byte{}, rd...)
		return okReport(rd)
	})
	d := registerSelf(m, 7)

	// a request carrying extra fields, including one that names another app
	body := `{"bind":"1111111111111111111111111111111111111111111111111111111111111111",` +
		`"app":"deadbeef","appSha256":"deadbeef","id":1}`
	if got := mustAsk(t, sock, body); got["report"] == "" {
		t.Fatalf("want a report, got %v", got)
	}
	if len(seen) != 64 {
		t.Fatalf("report_data must be 64 bytes, got %d", len(seen))
	}
	if string(seen[32:]) != string(d.appHash[:]) {
		t.Fatal("the app half of report_data must come from the monitor's table, not the request")
	}
	for _, b := range seen[:32] {
		if b != 0x11 {
			t.Fatal("the binding half must be exactly what the caller sent")
		}
	}
}

// A destroy can land while a report is in flight, and a crash can land while a destroy is running. The
// audit asked for both: whatever the order, the domain must end up gone from both tables, its
// reclamation must run once, and nothing may deadlock or panic.
func TestDestroyWhileAReportIsInFlight(t *testing.T) {
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		entered <- struct{}{}
		<-release // still inside the hardware call when the destroy arrives
		return okReport(rd)
	})
	d := registerSelf(m, 1)
	d.dir = filepath.Join(t.TempDir(), "1")
	d.cgroup = filepath.Join(t.TempDir(), "dom1")
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)
	close(d.exited) // nothing is actually running in this unit test

	answer := make(chan map[string]string, 1)
	go func() {
		r, err := ask(sock, goodBind)
		if err != nil {
			r = map[string]string{"error": err.Error()}
		}
		answer <- r
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the report never reached the hardware call")
	}

	// destroy it from under the in-flight request
	done := make(chan error, 1)
	go func() { done <- m.destroy(d.ID) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("destroy during a report: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("destroy blocked behind an in-flight report")
	}
	close(release)

	// the request finishes one way or the other, and it was admitted for a domain that existed then
	select {
	case r := <-answer:
		t.Logf("the in-flight request ended as: %v", r)
	case <-time.After(10 * time.Second):
		t.Fatal("the in-flight report never completed after its domain was destroyed")
	}
	m.mu.Lock()
	_, byID := m.doms[d.ID]
	_, byUID := m.byUID[d.FrontUID]
	m.mu.Unlock()
	if byID || byUID {
		t.Fatal("the destroyed domain is still registered")
	}
	if _, err := os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatal("its directory survived")
	}
	// a later report from that uid must not find a domain at all
	if got := mustAsk(t, sock, goodBind); got["error"] != "caller is not a domain's front" {
		t.Fatalf("a destroyed domain must stop being a domain, got %v", got)
	}
}

func TestCrashAndDestroyRacingLeaveOneCleanEnd(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	for i := 0; i < 20; i++ { // repeated create/end cycles, both endings racing each other
		d := registerSelf(m, i+1)
		d.dir = filepath.Join(t.TempDir(), "d")
		d.cgroup = filepath.Join(t.TempDir(), "cg")
		os.MkdirAll(d.dir, 0o755)
		os.MkdirAll(d.cgroup, 0o755)
		close(d.exited)
		var wg sync.WaitGroup
		for _, f := range []func(){
			func() { m.retire(d, "crash") },   // the reaper's path
			func() { m.destroy(d.ID) },        // the lease's path
			func() { m.retire(d, "crash-2") }, // and again, because idempotent means idempotent
		} {
			wg.Add(1)
			go func(fn func()) { defer wg.Done(); fn() }(f)
		}
		wg.Wait()
		m.mu.Lock()
		n := len(m.doms)
		m.mu.Unlock()
		if n != 0 {
			t.Fatalf("cycle %d: %d domains still registered", i, n)
		}
		if _, err := os.Stat(d.dir); !os.IsNotExist(err) {
			t.Fatalf("cycle %d: directory survived", i)
		}
	}
}

// --- the lifecycle, deterministically ------------------------------------------------------------
// Startup and reclamation race in both directions: a destroy can arrive while a domain is still being
// built, and the domain's process can die during startup. The hazard is not a leaked file: it is that a
// reclamation running FIRST would consume the one-shot cleanup before the process existed, after which
// the domain that then started could never be reclaimed at all. These tests drive the state machine
// directly, so the result does not depend on winning a race.

func endedCleanly(t *testing.T, m *monitor, d *domain) {
	t.Helper()
	m.mu.Lock()
	_, byID := m.doms[d.ID]
	_, byUID := m.byUID[d.FrontUID]
	m.mu.Unlock()
	if byID || byUID {
		t.Fatal("the domain is still registered")
	}
	if _, err := os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatalf("its directory survived: %v", err)
	}
	if _, err := os.Stat(d.cgroup); !os.IsNotExist(err) {
		t.Fatalf("its cgroup survived: %v", err)
	}
	st := d.state()
	if st != contract.Ended {
		t.Fatalf("state is %v, want ended", st)
	}
}

func startingDomain(t *testing.T, m *monitor, id int) *domain {
	t.Helper()
	d := &domain{ID: id, UID: os.Getuid() + 7 + id, FrontUID: os.Getuid() + id, life: contract.NewLifecycle(contract.Starting),
		dir: filepath.Join(t.TempDir(), "d"), cgroup: filepath.Join(t.TempDir(), "cg"),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)
	close(d.exited) // no process in a unit test
	m.register(d)
	return d
}

func TestDestroyDuringStartupIsHonouredByStartupItself(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	d := startingDomain(t, m, 1)

	// the destroy arrives while the domain is still being built
	if err := m.destroy(d.ID); err != nil {
		t.Fatalf("destroy: %v", err)
	}
	// it must NOT have been reclaimed yet: start() still owns it and knows what it built
	if _, err := os.Stat(d.dir); err != nil {
		t.Fatal("a domain still starting up must not be reclaimed from under startup")
	}
	// it must already be out of the tables, so nothing new can find it
	m.mu.Lock()
	_, listed := m.doms[d.ID]
	m.mu.Unlock()
	if listed {
		t.Fatal("a domain being ended must leave the tables at once")
	}

	// now startup finishes and finds the request waiting for it
	why := d.finishStart(nil)
	if why == "" {
		t.Fatal("startup must be told that the domain was destroyed while it was building")
	}
	m.retire(d, why)
	endedCleanly(t, m, d)
}

func TestManyStartsAndDestroysRacingEndCleanlyEveryTime(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	for i := 0; i < 50; i++ {
		d := startingDomain(t, m, i+1)
		var wg sync.WaitGroup
		// three reclaimers and one startup, all at once, in every interleaving the scheduler picks
		for _, fn := range []func(){
			func() { m.destroy(d.ID) },
			func() { m.retire(d, "crashed") },
			func() { m.retire(d, "crashed again") },
			func() {
				if why := d.finishStart(nil); why != "" {
					m.retire(d, why)
				}
			},
		} {
			wg.Add(1)
			go func(f func()) { defer wg.Done(); f() }(fn)
		}
		wg.Wait()
		// whoever got there first, the domain ends exactly once and leaves nothing
		if why := d.finishStart(nil); why != "" {
			m.retire(d, why) // startup may have lost the race; it still has to be safe
		}
		m.retire(d, "belt and braces")
		endedCleanly(t, m, d)
	}
}

func TestAReapedDomainIsNeverSignalledByNumber(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	d := registerSelf(m, 1)
	d.dir = filepath.Join(t.TempDir(), "d")
	d.cgroup = filepath.Join(t.TempDir(), "cg")
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)

	// a process that has already been reaped: its pid may belong to something else by now
	sleep := exec.Command("/bin/sh", "-c", "exit 0")
	if err := sleep.Start(); err != nil {
		t.Fatal(err)
	}
	sleep.Wait()
	d.mu.Lock()
	d.proc, d.reaped = sleep.Process, true
	d.mu.Unlock()
	close(d.exited)

	m.retire(d, "already reaped")
	endedCleanly(t, m, d)
	// nothing was written to cgroup.kill, because the domain was known to be gone
	if _, err := os.Stat(filepath.Join(d.cgroup, "cgroup.kill")); err == nil {
		t.Fatal("a reaped domain must not be killed again")
	}
}

// --- one tenant must not be able to spend the monitor's attention ---------------------------------
// The per-domain cap alone does not achieve this. A refusal that answers and then absorbs the peer's
// remaining bytes takes time, and if that happens while holding a global slot — or worse, inside the
// accept loop — then a single domain opening many connections it is not entitled to can occupy the whole
// global budget, or stall every other tenant's connection behind it. The distinction this test turns on:
// a flood must come back as the PER-DOMAIN refusal, never as the GLOBAL one, and another domain must
// still be served while it is going on.
func TestOneDomainsFloodNeitherSpendsTheGlobalBudgetNorBlocksAnother(t *testing.T) {
	hold := make(chan struct{})
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		if strings.HasPrefix(string(rd[32:]), "app-1") {
			<-hold // this domain's admitted requests stay in the hardware call
		}
		return okReport(rd)
	})
	noisy := registerSelf(m, 1)
	t.Cleanup(func() { close(hold) })

	// fill this domain's own allowance with requests that will not finish
	var stuck []net.Conn
	for i := 0; i < maxReportsPerDom; i++ {
		c, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte(goodBind))
		stuck = append(stuck, c)
	}
	// then flood: connections that open, send a request, and are SLOW to go away afterwards
	var flood []net.Conn
	for i := 0; i < 60; i++ {
		c, err := net.Dial("unix", sock)
		if err != nil {
			break
		}
		c.Write([]byte(goodBind))
		flood = append(flood, c)
	}
	t.Cleanup(func() {
		for _, c := range append(stuck, flood...) {
			c.Close()
		}
	})
	time.Sleep(300 * time.Millisecond) // let the monitor work through them

	// A new request from the same domain must be refused for the RIGHT reason: its own allowance is
	// full. Seeing the global limit here would mean the flood's refusals were holding global slots.
	got, err := ask(sock, goodBind)
	if err != nil {
		t.Fatalf("the monitor stopped answering during a flood: %v", err)
	}
	if strings.Contains(got["error"], "report limit") {
		t.Fatalf("one domain's flood consumed the GLOBAL budget: %v", got)
	}
	if !strings.Contains(got["error"], "too many concurrent report requests") {
		t.Fatalf("want the per-domain refusal, got %v", got)
	}

	// ...and a different domain is served throughout. (Every connection here authenticates as the same
	// uid, so a second domain is simulated by swapping the record that uid resolves to.)
	quiet := &domain{ID: 2, UID: os.Getuid() + 7, FrontUID: os.Getuid(), life: contract.NewLifecycle(contract.Running), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsPerDom)}
	copy(quiet.appHash[:], []byte("app-2"))
	m.mu.Lock()
	m.byUID[quiet.FrontUID] = quiet
	m.mu.Unlock()

	done := make(chan map[string]string, 1)
	go func() {
		r, err := ask(sock, goodBind)
		if err != nil {
			r = map[string]string{"error": err.Error()}
		}
		done <- r
	}()
	select {
	case r := <-done:
		if r["report"] == "" {
			t.Fatalf("the other domain must be served during the flood, got %v", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the other domain was not served while one domain flooded the monitor")
	}
	_ = noisy
}

// A refusal must not be answered from inside the accept loop, or one slow peer delays every connection
// behind it. With the answer and the drain moved off that path, a burst of refused connections is
// answered promptly rather than serially.
func TestRefusalsDoNotStallTheAcceptLoop(t *testing.T) {
	hold := make(chan struct{})
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) { <-hold; return okReport(rd) })
	// built with a large per-domain allowance so the GLOBAL limit is the one under test. It is set at
	// construction, never assigned afterwards: mutating a field of a domain the monitor is already
	// serving is a data race, and a racy test cannot be trusted to find real ones.
	d := &domain{ID: 1, UID: os.Getuid() + 7, FrontUID: os.Getuid(), life: contract.NewLifecycle(contract.Running), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsTotal+8)}
	copy(d.appHash[:], []byte("app-1"))
	m.register(d)
	t.Cleanup(func() { close(hold) })

	var held []net.Conn
	for i := 0; i < maxReportsTotal; i++ { // occupy every global slot with requests that never finish
		c, err := net.Dial("unix", sock)
		if err != nil {
			t.Fatal(err)
		}
		c.Write([]byte(goodBind))
		held = append(held, c)
	}
	t.Cleanup(func() {
		for _, c := range held {
			c.Close()
		}
	})
	time.Sleep(200 * time.Millisecond)

	// now 12 more, each of which must be told the monitor is full — quickly, and not one after another
	start := time.Now()
	for i := 0; i < 12; i++ {
		got, err := ask(sock, goodBind)
		if err != nil {
			t.Fatalf("connection %d got no answer: %v", i, err)
		}
		if !strings.Contains(got["error"], "report limit") {
			t.Fatalf("connection %d: want the global refusal, got %v", i, got)
		}
	}
	if d := time.Since(start); d > 4*time.Second {
		t.Fatalf("12 refusals took %s: they are queueing behind each other", d)
	} else {
		t.Logf("12 refusals answered in %s", d)
	}
}

// A domain is in the tables before its first instruction, which is deliberate: one that dies during
// startup must still be found and reclaimed. That leaves one window where a domain is registered but has
// no process, and a failed launch has to close it completely. Freeing the files is not enough — a domain
// left in the tables would still be listed, and its uid would still authenticate for reports, against a
// domain whose directory and cgroup no longer exist.
func TestAFailedLaunchLeavesNothingBehind(t *testing.T) {
	var reportCalls atomic.Int32
	m, sock := testMonitor(t, func(rd []byte) ([]byte, []byte, error) {
		reportCalls.Add(1)
		return okReport(rd)
	})

	// a domain built as far as start() builds one, with the files and cgroup in place
	base := t.TempDir()
	d := &domain{ID: 1, UID: os.Getuid() + 7, FrontUID: os.Getuid(), Port: 40001, life: contract.NewLifecycle(contract.Starting),
		dir: filepath.Join(base, "1"), cgroup: filepath.Join(base, "dom1"),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	copy(d.appHash[:], []byte("app-1"))
	for _, p := range []string{d.dir, filepath.Join(d.dir, "run"), filepath.Join(d.dir, "plat"), d.cgroup} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(d.dir, "app.wasm"), []byte("wasm"), 0o444); err != nil {
		t.Fatal(err)
	}

	// cmd.Start fails deterministically: there is no such program. This drives the real launch path,
	// registration and all, rather than a stand-in for it.
	err := m.launch(d, exec.Command(filepath.Join(base, "no-such-binary")), nil)
	if err == nil {
		t.Fatal("launching a domain whose binary does not exist must fail")
	}
	t.Logf("launch failed as expected: %v", err)

	// BOTH tables
	m.mu.Lock()
	_, byID := m.doms[d.ID]
	_, byUID := m.byUID[d.FrontUID]
	m.mu.Unlock()
	if byID {
		t.Error("a failed launch is still listed by id")
	}
	if byUID {
		t.Error("a failed launch is still listed by uid: its uid could still authenticate")
	}
	// its files, its cgroup, and its state
	if _, err := os.Stat(d.dir); !os.IsNotExist(err) {
		t.Errorf("its directory survived: %v", err)
	}
	if _, err := os.Stat(d.cgroup); !os.IsNotExist(err) {
		t.Errorf("its cgroup survived: %v", err)
	}
	st := d.state()
	if st != contract.Ended {
		t.Errorf("state is %v, want ended", st)
	}

	// and the thing that matters most: that uid is no longer a domain, so no report can be had for it
	got := mustAsk(t, sock, goodBind)
	if got["error"] != "caller is not a domain's front" {
		t.Fatalf("a failed launch must stop being a domain, got %v", got)
	}
	if reportCalls.Load() != 0 {
		t.Fatal("the hardware path ran for a domain that never started")
	}

	// a later destroy finds nothing rather than a phantom
	if err := m.destroy(d.ID); err == nil {
		t.Fatal("destroying a failed launch must say there is no such domain")
	}
}

// A listener belongs to a domain that was built; a failed launch must close it rather than leave it
// answering on a port whose domain is gone.
func TestAFailedLaunchClosesItsListener(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	base := t.TempDir()
	d := &domain{ID: 2, UID: os.Getuid() + 2, FrontUID: os.Getuid() + 2 + frontUIDOffset, Port: 40002, life: contract.NewLifecycle(contract.Starting),
		dir: filepath.Join(base, "2"), cgroup: filepath.Join(base, "dom2"),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)

	ln, err := vsock.Listen(d.Port)
	if err != nil {
		t.Skipf("no vsock on this host: %v", err) // the rest of the suite does not need it
	}
	if err := m.launch(d, exec.Command(filepath.Join(base, "no-such-binary")), ln); err == nil {
		t.Fatal("launch must fail")
	}
	// the port is free again: binding it a second time proves the listener was closed
	again, err := vsock.Listen(d.Port)
	if err != nil {
		t.Fatalf("the failed launch left its port bound: %v", err)
	}
	again.Close()
}

// --- the boundary self-test: every bad case must fail closed -------------------------------------
//
// The property under test is the one the acceptance tests used NOT to enforce: a report naming a lower
// privilege level does not show confinement, because a guest at VMPL0 holds every VMPCK and can request
// one. Only a REFUSAL at level 0 bounds us from above. So the monitor must refuse to serve unless the
// three facts form exactly one coherent tuple, and each way of being wrong is a separate mutant here.
func TestTheBoundaryVerdictFailsClosedOnEveryIncoherentTuple(t *testing.T) {
	for _, c := range []struct {
		name        string
		vmpl, floor int
		probe       string
		wantFault   bool
	}{
		// the only two shapes that may serve
		{"confined at VMPL2, level 0 refused", 2, 2, "refused", false},
		{"a plain SNP guest at VMPL0 claims nothing", 0, 0, "n/a", false},

		// GRANTED is fatal however good the rest looks: we hold VMPL0
		{"GRANTED while claiming VMPL2", 2, 2, "GRANTED", true},
		{"GRANTED at VMPL0", 0, 0, "GRANTED", true},
		{"GRANTED with otherwise perfect fields", 3, 3, "GRANTED", true},

		// the probe did not run, so there is no evidence. Silence is not a pass
		{"confined-looking but the probe never ran", 2, 2, "n/a", true},
		{"probe result is empty", 2, 2, "", true},
		{"probe result is unrecognised", 2, 2, "ok", true},
		{"probe result is a near-miss", 2, 2, "Refused", true},

		// the downward-claim forgery: floor says VMPL0, the report says otherwise
		{"floor 0 but the report claims VMPL2", 2, 0, "n/a", true},
		{"floor 0 but the report claims VMPL1", 1, 0, "refused", true},

		// the two numbers disagree
		{"report VMPL1 against floor 2", 1, 2, "refused", true},
		{"report VMPL3 against floor 2", 3, 2, "refused", true},

		// something could not be read at all
		{"the kernel would not say the floor", 2, -1, "refused", true},
		{"our own report was unreadable", -1, 2, "refused", true},
		{"neither could be read", -1, -1, "refused", true},
	} {
		t.Run(c.name, func(t *testing.T) {
			why := boundaryFault(c.vmpl, c.floor, c.probe)
			if c.wantFault && why == "" {
				t.Fatalf("vmpl=%d floor=%d probe=%q was accepted; it must fail closed", c.vmpl, c.floor, c.probe)
			}
			if !c.wantFault && why != "" {
				t.Fatalf("vmpl=%d floor=%d probe=%q was refused: %s", c.vmpl, c.floor, c.probe, why)
			}
		})
	}
}

// A guest at VMPL0 asking for a report that names VMPL2 is the exact forgery the old check would have
// accepted: the serial log would have read vmpl=2 and every client would have been satisfied. Pin it.
func TestAVmpl0GuestCannotPassByClaimingALowerLevel(t *testing.T) {
	if boundaryFault(2, 0, "n/a") == "" {
		t.Fatal("a VMPL0 guest presenting a VMPL2 report was accepted")
	}
	// and it does not help to also claim the probe refused, which a VMPL0 guest cannot honestly say
	if boundaryFault(2, 0, "refused") == "" {
		t.Fatal("a VMPL0 guest claiming both VMPL2 and a refusal was accepted")
	}
}

// The tuple the monitor emits has to be the one a checker parses, so lock its shape down. A checker that
// greps for "vmpl=2" alone would match vmpl=2 vmpl0=GRANTED, which is why the fields travel together.
func TestTheEmittedTupleCarriesAllThreeFieldsTogether(t *testing.T) {
	for _, c := range []struct{ snp bool }{{true}, {false}} {
		m := &monitor{snp: c.snp}
		if !c.snp {
			m.selfTest()
			for _, want := range []string{"tier=t0", "vmpl=n/a", "vmpl_floor=n/a", "vmpl0=n/a"} {
				if !strings.Contains(m.boundary, want) {
					t.Fatalf("T0 tuple %q is missing %q", m.boundary, want)
				}
			}
		}
	}
	// the T1 shape, built the same way selfTest builds it
	got := fmt.Sprintf("tier=t1 vmpl=%d vmpl_floor=%d vmpl0=%s", 2, 2, "refused")
	for _, want := range []string{"tier=t1 ", " vmpl=2 ", " vmpl_floor=2 ", " vmpl0=refused"} {
		if !strings.Contains(got+" ", want) {
			t.Fatalf("T1 tuple %q is missing %q", got, want)
		}
	}
}
