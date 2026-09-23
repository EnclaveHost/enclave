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
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
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

// the caller of these tests runs as one uid, so that uid is the "domain" the monitor knows
func registerSelf(m *monitor, id int) *domain {
	d := &domain{ID: id, UID: os.Getuid(), Port: uint32(40000 + id),
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
	if got["error"] != "caller is not a domain" {
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
	quiet := &domain{ID: 2, UID: os.Getuid(), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsPerDom)}
	copy(quiet.appHash[:], []byte("app-2"))
	m.mu.Lock()
	m.byUID[quiet.UID] = quiet
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
	d := &domain{ID: 1, UID: os.Getuid(), exited: make(chan struct{}),
		inFlight: make(chan struct{}, maxReportsTotal+8)}
	m.mu.Lock()
	m.byUID[d.UID] = d
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
	_, byUID := m.byUID[d.UID]
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
