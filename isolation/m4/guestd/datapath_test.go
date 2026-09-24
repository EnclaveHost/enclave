package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

// The data plane against the real server, lifecycle and admission, with plain TCP guests standing in for a guest's
// forwarder. These say nothing about TLS or attestation (the fixture chain in datapath_chain_test.go does); they
// test what guestd itself decides: who is admitted, what is bounded, and what ends with an instance.

var (
	testRuntime = strings.Repeat("7e", 32)
	fakeMeas    = "ab" + hex.EncodeToString(make([]byte, 47))
)

type dp struct {
	*rig
	addr  string
	pmu   sync.Mutex
	ports []int
}

// newDP starts the data plane; opts set its bounds BEFORE it serves (Serve's goroutines read them).
func newDP(t *testing.T, opts ...func(*dataPlane)) *dp {
	r := newRig(t)
	r.s.RuntimeID = testRuntime
	r.s.Data = newDataPlane(r.s)
	for _, o := range opts {
		o(r.s.Data)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go r.s.Data.Serve(l)
	d := &dp{rig: r, addr: l.Addr().String()}
	r.f.fwdPort = func(string) int {
		d.pmu.Lock()
		defer d.pmu.Unlock()
		p := d.ports[0]
		d.ports = d.ports[1:]
		return p
	}
	return d
}

func (d *dp) launch(label string, guestPort int) (id, app string) {
	p, app := d.bundle(label, contract.Policy{})
	d.pmu.Lock()
	d.ports = append(d.ports, guestPort)
	d.pmu.Unlock()
	code, body := d.create("0x"+label, p)
	if code != 202 && code != 201 {
		d.t.Fatalf("create %s: %d %v", label, code, body)
	}
	d.s.launching.Wait()
	return body["id"].(string), app
}

func line(id, app, meas, rt, key string) string {
	return fmt.Sprintf("ENCLAVE-SPLICE/1 id=%s app=%s measurement=%s runtime=%s key=%s\n", id, app, meas, rt, key)
}

func (d *dp) good(id, app string) string { return line(id, app, fakeMeas, testRuntime, fakeKeySha) }

// open sends a first line and returns the connection and the answer line.
func (d *dp) open(first string) (net.Conn, string) {
	c, err := net.Dial("tcp", d.addr)
	if err != nil {
		d.t.Fatal(err)
	}
	d.t.Cleanup(func() { c.Close() })
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(c, first); err != nil {
		return c, "WRITE-FAILED " + err.Error()
	}
	ans, err := readLine(c, 600)
	if err != nil {
		return c, "NO-ANSWER " + err.Error()
	}
	_ = c.SetDeadline(time.Time{})
	return c, ans
}

type fakeGuest struct {
	port    int
	written atomic.Int64
	conns   atomic.Int64
}

// guest modes: "echo" says its name, then echoes; "stream" writes until the writes block or fail; "halfclose" reads
// to EOF and then answers with the byte count.
func startGuest(t *testing.T, name, mode string) *fakeGuest {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	g := &fakeGuest{port: l.Addr().(*net.TCPAddr).Port}
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			g.conns.Add(1)
			go func() {
				defer c.Close()
				switch mode {
				case "echo":
					fmt.Fprintf(c, "I am %s\n", name)
					_, _ = io.Copy(c, c)
				case "stream":
					buf := bytes.Repeat([]byte("s"), 64<<10)
					for {
						n, err := c.Write(buf)
						g.written.Add(int64(n))
						if err != nil {
							return
						}
					}
				case "halfclose":
					n, _ := io.Copy(io.Discard, c)
					fmt.Fprintf(c, "got %d\n", n)
				}
			}()
		}
	}()
	return g
}

func TestDataPlaneAdmitsOnlyTheVerifiedIdentity(t *testing.T) {
	d := newDP(t)
	ga, gb := startGuest(t, "A", "echo"), startGuest(t, "B", "echo")
	idA, appA := d.launch("A", ga.port)
	idB, appB := d.launch("B", gb.port)

	c, ans := d.open(d.good(idA, appA))
	if ans != "OK" {
		t.Fatalf("the verified identity was refused: %q", ans)
	}
	if b, _ := readLine(c, 64); b != "I am A" {
		t.Fatalf("A's splice reached %q", b)
	}
	if _, ans := d.open(d.good(idB, appB)); ans != "OK" {
		t.Fatalf("B: %q", ans)
	}

	other := strings.Repeat("00", 32)
	refusals := map[string]string{
		"A's instance under B's app":          d.good(idA, appB),
		"a different measurement":             line(idA, appA, "cd"+fakeMeas[2:], testRuntime, fakeKeySha),
		"a different runtime":                 line(idA, appA, fakeMeas, other, fakeKeySha),
		"a different transport key":           line(idA, appA, fakeMeas, testRuntime, other),
		"an instance that does not exist":     d.good("gd00000000", appA),
		"uppercase hex":                       d.good(idA, strings.ToUpper(appA)),
		"a missing field":                     fmt.Sprintf("ENCLAVE-SPLICE/1 id=%s app=%s measurement=%s runtime=%s\n", idA, appA, fakeMeas, testRuntime),
		"an extra field":                      strings.TrimSuffix(d.good(idA, appA), "\n") + " x=1\n",
		"reordered fields":                    fmt.Sprintf("ENCLAVE-SPLICE/1 app=%s id=%s measurement=%s runtime=%s key=%s\n", appA, idA, fakeMeas, testRuntime, fakeKeySha),
		"another protocol word":               strings.Replace(d.good(idA, appA), "SPLICE/1", "SPLICE/2", 1),
		"a TLS ClientHello instead of a line": "\x16\x03\x01\x00\x05hello\n",
		"an overlong first line":              strings.Repeat("x", 600),
	}
	for what, first := range refusals {
		if _, ans := d.open(first); !strings.HasPrefix(ans, "NO ") {
			t.Errorf("%s: answered %q, want a refusal", what, ans)
		}
	}
	st := d.s.Data.Stats()
	t.Logf("outcomes: %v", st)
	if st["spliced"] != 2 || st["refused:identity"] != 4 || st["refused:no-instance"] != 1 || st["refused:malformed"] != 6 ||
		st["refused:oversized"] != 1 {
		t.Fatalf("the outcomes are not what was sent: %v", st)
	}
	if ga.conns.Load() != 1 || gb.conns.Load() != 1 {
		t.Fatalf("a refused connection reached a guest: A saw %d, B saw %d", ga.conns.Load(), gb.conns.Load())
	}
}

func TestDataPlaneRefusesAnInstanceThatIsNotRunning(t *testing.T) {
	d := newDP(t)
	g := startGuest(t, "A", "echo")
	d.f.startGate = make(chan struct{})
	p, app := d.bundle("A", contract.Policy{})
	d.pmu.Lock()
	d.ports = append(d.ports, g.port)
	d.pmu.Unlock()
	_, body := d.create("0xA", p)
	id := body["id"].(string)
	if _, ans := d.open(d.good(id, app)); !strings.HasPrefix(ans, "NO the instance is starting") {
		t.Errorf("a starting instance: %q", ans)
	}
	close(d.f.startGate)
	d.s.launching.Wait()
	if _, ans := d.open(d.good(id, app)); ans != "OK" {
		t.Fatalf("once running: %q", ans)
	}

	d.f.verifyErr = fmt.Errorf("VERDICT reject")
	d.f.startGate = nil
	idF, appF := d.launch("F", g.port)
	if _, ans := d.open(d.good(idF, appF)); !strings.HasPrefix(ans, "NO the instance is failed") {
		t.Errorf("a failed instance: %q", ans)
	}
	if g.conns.Load() != 1 {
		t.Fatalf("the guest saw %d connections, want only the admitted one", g.conns.Load())
	}
}

func TestDataPlaneBoundsTheFirstLine(t *testing.T) {
	d := newDP(t, func(p *dataPlane) { p.PreambleTimeout = 300 * time.Millisecond })
	c, err := net.Dial("tcp", d.addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, _ = io.WriteString(c, "ENCLAVE-SPLICE/1 id=")
	t0 := time.Now()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	n, err := c.Read(make([]byte, 16))
	if el := time.Since(t0); n != 0 || err == nil || el > 2*time.Second {
		t.Fatalf("a partial first line: read %d, %v after %v; want a close within the bound", n, err, el)
	}
	c2, _ := net.Dial("tcp", d.addr)
	_, _ = io.WriteString(c2, "ENCLAVE-SPL")
	c2.Close()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && d.s.Data.Stats()["closed:preamble-incomplete"] == 0 {
		time.Sleep(10 * time.Millisecond)
	}
	st := d.s.Data.Stats()
	if st["closed:preamble-timeout"] != 1 || st["closed:preamble-incomplete"] != 1 {
		t.Fatalf("outcomes: %v", st)
	}
}

func TestDataPlaneRefusesWhenTheGuestDoesNotAnswer(t *testing.T) {
	d := newDP(t)
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close() // nothing listens there now
	id, app := d.launch("A", port)
	if _, ans := d.open(d.good(id, app)); ans != "NO the guest's endpoint did not answer" {
		t.Fatalf("an unreachable guest: %q", ans)
	}
	_, pub := d.do("GET", "/vms/"+id, nil)
	if pub["openSplices"] != nil {
		t.Fatalf("a refused splice stayed registered: %v", pub)
	}
}

func TestReclamationClosesEverySpliceToThatInstanceOnly(t *testing.T) {
	d := newDP(t)
	ga, gb := startGuest(t, "A", "echo"), startGuest(t, "B", "echo")
	idA, appA := d.launch("A", ga.port)
	idB, appB := d.launch("B", gb.port)
	var as []net.Conn
	for i := 0; i < 3; i++ {
		c, ans := d.open(d.good(idA, appA))
		if ans != "OK" {
			t.Fatal(ans)
		}
		_, _ = readLine(c, 64)
		as = append(as, c)
	}
	cb, _ := d.open(d.good(idB, appB))
	_, _ = readLine(cb, 64)
	if _, pub := d.do("GET", "/vms/"+idA, nil); pub["openSplices"] != float64(3) {
		t.Fatalf("A's open splices: %v", pub["openSplices"])
	}
	if code, _ := d.do("DELETE", "/vms/"+idA, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
	for i, c := range as {
		_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
		if n, err := c.Read(make([]byte, 8)); n != 0 || err == nil || isTimeout(err) {
			t.Fatalf("A's splice %d outlived its instance: read %d, %v", i, n, err)
		}
	}
	_, _ = io.WriteString(cb, "still here\n")
	if got, _ := readLine(cb, 64); got != "still here" {
		t.Fatalf("ending A touched B's splice: %q", got)
	}
	if _, ans := d.open(d.good(idA, appA)); ans != "NO no such instance" {
		t.Fatalf("after the delete: %q", ans)
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && d.s.Data.Stats()["closed:the instance ended"] < 3 {
		time.Sleep(10 * time.Millisecond)
	}
	if st := d.s.Data.Stats(); st["closed:the instance ended"] != 3 {
		t.Fatalf("outcomes: %v", st)
	}
}

func TestIdleSplicesAreClosedAndActiveOnesAreNot(t *testing.T) {
	d := newDP(t, func(p *dataPlane) { p.Idle = 400 * time.Millisecond })
	g := startGuest(t, "A", "echo")
	id, app := d.launch("A", g.port)
	idle, _ := d.open(d.good(id, app))
	_, _ = readLine(idle, 64)
	busy, _ := d.open(d.good(id, app))
	_, _ = readLine(busy, 64)
	stop := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(stop) {
		_, _ = io.WriteString(busy, "k\n")
		if got, err := readLine(busy, 8); got != "k" {
			t.Fatalf("an active splice was cut: %q %v", got, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
	_ = idle.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	if n, err := idle.Read(make([]byte, 1)); n != 0 || err == nil || isTimeout(err) {
		t.Fatalf("an idle splice survived %v of silence: %d %v", 1500*time.Millisecond, n, err)
	}
	if st := d.s.Data.Stats(); st["closed:idle"] != 1 {
		t.Fatalf("outcomes: %v", st)
	}
}

func TestTheCapRefusesInsteadOfQueuing(t *testing.T) {
	d := newDP(t, func(p *dataPlane) { p.MaxPerGuest = 2 })
	g := startGuest(t, "A", "echo")
	id, app := d.launch("A", g.port)
	c1, a1 := d.open(d.good(id, app))
	_, a2 := d.open(d.good(id, app))
	_, a3 := d.open(d.good(id, app))
	if a1 != "OK" || a2 != "OK" || a3 != "NO too many open connections" {
		t.Fatalf("answers %q %q %q", a1, a2, a3)
	}
	c1.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, a4 := d.open(d.good(id, app))
		if a4 == "OK" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("a closed splice never freed its slot: %q", a4)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A reader that stops reading must stop the writer: nothing in guestd queues the guest's output for it.
func TestBackpressureHoldsNothingBeyondTheSockets(t *testing.T) {
	d := newDP(t)
	g := startGuest(t, "A", "stream")
	id, app := d.launch("A", g.port)
	c, ans := d.open(d.good(id, app))
	if ans != "OK" {
		t.Fatal(ans)
	}
	time.Sleep(1000 * time.Millisecond)
	at1 := g.written.Load()
	time.Sleep(500 * time.Millisecond)
	at2 := g.written.Load()
	t.Logf("written by the guest with nobody reading: %d bytes at 1.0 s, %d at 1.5 s", at1, at2)
	if at1 != at2 || at2 > 64<<20 {
		t.Fatalf("the guest kept writing into a reader that reads nothing: %d -> %d bytes", at1, at2)
	}
	n, err := io.CopyN(io.Discard, c, 32<<20)
	if err != nil || n != 32<<20 {
		t.Fatalf("reading after the stall: %d %v", n, err)
	}
	if g.written.Load() <= at2 {
		t.Fatal("the guest did not resume once the reader did")
	}
}

func TestHalfCloseCarriesARequestToItsEnd(t *testing.T) {
	d := newDP(t)
	g := startGuest(t, "A", "halfclose")
	id, app := d.launch("A", g.port)
	c, ans := d.open(d.good(id, app))
	if ans != "OK" {
		t.Fatal(ans)
	}
	body := bytes.Repeat([]byte("b"), 100<<10)
	_, _ = c.Write(body)
	_ = c.(*net.TCPConn).CloseWrite()
	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	if got, err := readLine(c, 64); got != fmt.Sprintf("got %d", len(body)) {
		t.Fatalf("the answer after a half-close: %q %v", got, err)
	}
}

func TestConcurrentTenantsNeverCross(t *testing.T) {
	d := newDP(t)
	ga, gb := startGuest(t, "A", "echo"), startGuest(t, "B", "echo")
	idA, appA := d.launch("A", ga.port)
	idB, appB := d.launch("B", gb.port)
	var wg sync.WaitGroup
	var crossed, failed atomic.Int64
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name, first := "A", d.good(idA, appA)
			if i%2 == 1 {
				name, first = "B", d.good(idB, appB)
			}
			c, err := net.Dial("tcp", d.addr)
			if err != nil {
				failed.Add(1)
				return
			}
			defer c.Close()
			_ = c.SetDeadline(time.Now().Add(10 * time.Second))
			_, _ = io.WriteString(c, first)
			if a, _ := readLine(c, 600); a != "OK" {
				failed.Add(1)
				return
			}
			if b, _ := readLine(c, 64); b != "I am "+name {
				crossed.Add(1)
				return
			}
			tok := make([]byte, 16)
			_, _ = rand.Read(tok)
			_, _ = fmt.Fprintf(c, "%x\n", tok)
			if e, _ := readLine(c, 64); e != hex.EncodeToString(tok) {
				crossed.Add(1)
			}
		}(i)
	}
	wg.Wait()
	t.Logf("64 concurrent splices over two tenants: %d crossed, %d failed; guests saw A=%d B=%d",
		crossed.Load(), failed.Load(), ga.conns.Load(), gb.conns.Load())
	if crossed.Load() != 0 || failed.Load() != 0 || ga.conns.Load() != 32 || gb.conns.Load() != 32 {
		t.Fatal("tenants crossed or connections failed")
	}
}
