package main

// The console guard (console.go): an app's or client's bytes never reach the host's console through the front's
// process. Each scenario runs TWICE: once through a raw logger, which must SHOW the unique marker (the positive
// control: the scenario really leaks without the guard), and once through the guard, which must not.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"runtime/debug"
	"strings"
	"sync"
	"testing"
	"time"
)

func marker(t *testing.T) string {
	b := make([]byte, 8)
	rand.Read(b)
	return "LEAKMARK-" + hex.EncodeToString(b)
}

type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

// withConsole points the std logger and consoleLog at w for one test (guarded: through consoleFilter; raw: straight).
func withConsole(t *testing.T, guarded bool) *syncBuf {
	buf := &syncBuf{}
	var w io.Writer = buf
	if guarded {
		w = &consoleFilter{out: buf}
	}
	prevOut, prevFlags, prevCL := log.Writer(), log.Flags(), consoleLog
	log.SetOutput(w)
	log.SetFlags(log.LstdFlags)
	consoleLog = log.New(w, "", log.LstdFlags)
	t.Cleanup(func() { log.SetOutput(prevOut); log.SetFlags(prevFlags); consoleLog = prevCL })
	return buf
}

func TestFilterPassesDOMLinesAndWithholdsEverythingElse(t *testing.T) {
	m := marker(t)
	cases := []struct{ in, want string }{
		{"DOM serving 127.0.0.1:1 spki_sha256=ab ready_ms=3\n", "DOM serving 127.0.0.1:1 spki_sha256=ab ready_ms=3\n"},
		{"2026/09/26 00:00:00 DOM proxy: GET unreachable\n", "2026/09/26 00:00:00 DOM proxy: GET unreachable\n"},
		{"2026/09/26 00:00:00 Unsolicited response received on idle HTTP channel starting with \"" + m + "\"; err=<nil>\n",
			"DOM front: unsolicited upstream response ("},
		{"2026/09/26 00:00:00 http: TLS handshake error from 10.0.0.1:5555: " + m + "\n", "DOM front: tls handshake error\n"},
		{"2026/09/26 00:00:00 http: panic serving 10.0.0.1:1: " + m + "\ngoroutine 5 [running]:\nmain.x()\n", "DOM front: panic (withheld)\n"},
		{"panic: " + m + "\n\ngoroutine 1 [running]:\n", "DOM front: panic (withheld)\n"},
		{m + "\n", "DOM front: output withheld ("},
		{"xDOM " + m + "\n", "DOM front: output withheld ("},
		{" DOM " + m + "\n", "DOM front: output withheld ("},
	}
	for _, c := range cases {
		got := string(filter([]byte(c.in)))
		if strings.Contains(got, m) {
			t.Errorf("filter(%q) leaked the marker: %q", c.in, got)
		}
		if !strings.HasPrefix(got, c.want) {
			t.Errorf("filter(%q) = %q, want prefix %q", c.in, got, c.want)
		}
		if strings.Count(got, "\n") != 1 {
			t.Errorf("filter(%q) = %q: a write must become exactly one console line", c.in, got)
		}
	}
	// ONE message is judged whole: a multi-line message is withheld whole even when a later line starts with DOM, so a
	// withheld value cannot carry a line past the filter (enclave-d1's review of 8be920fa)
	for _, in := range []string{
		"DOM a\n" + m + "\n",
		"2026/09/26 00:00:00 http: panic serving 10.0.0.1:1: x\nDOM smuggled " + m + "\ngoroutine 5 [running]:\n",
		"2026/09/26 00:00:00 httputil: ReverseProxy read error during body copy: x\nDOM smuggled " + m + "\n",
		"DOM a\nDOM b " + m + "\n",
		// enclave-d1's measured input on 8be920fa, verbatim but for the marker
		"2026/09/26 00:00:00 http: panic serving 10.0.0.1:5: x\nDOM smuggled " + m + "\ngoroutine 1 [running]:\n",
	} {
		got := string(filter([]byte(in)))
		if strings.Contains(got, m) || strings.Contains(got, "smuggled") || strings.Count(got, "\n") != 1 || !strings.HasPrefix(got, "DOM front: ") {
			t.Errorf("filter(%q) = %q: a multi-line message must become ONE class line", in, got)
		}
	}
}

// the fake app: a raw TCP server that answers each request with the given bytes, so it can break HTTP on purpose
func rawUpstream(t *testing.T, answer func(req *http.Request, c net.Conn)) string {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				br := bufio.NewReader(c)
				for {
					req, err := http.ReadRequest(br)
					if err != nil {
						return
					}
					io.Copy(io.Discard, req.Body)
					answer(req, c)
				}
			}(c)
		}
	}()
	return l.Addr().String()
}

// the front's proxy (appProxy, as main builds it) in front of the fake app, served with main's ErrorLog
func frontFor(t *testing.T, upstream string) *httptest.Server {
	srv := httptest.NewUnstartedServer(appProxy(upstream))
	srv.Config.ErrorLog = consoleLog
	srv.Start()
	t.Cleanup(srv.Close)
	return srv
}

func waitFor(buf *syncBuf, s string, d time.Duration) bool {
	for end := time.Now().Add(d); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if strings.Contains(buf.String(), s) {
			return true
		}
	}
	return false
}

// the upstream misbehaviours enclave-87 named; each makes net/http log the app's own bytes
var upstreamCases = []struct {
	name, method, class string
	answer              func(m string) func(*http.Request, net.Conn)
}{
	{"HEAD answered with a body", http.MethodHead, "unsolicited upstream response", func(m string) func(*http.Request, net.Conn) {
		return func(_ *http.Request, c net.Conn) {
			fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", len(m), m)
		}
	}},
	{"bytes after Content-Length", http.MethodGet, "unsolicited upstream response", func(m string) func(*http.Request, net.Conn) {
		return func(_ *http.Request, c net.Conn) {
			fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok%s", m)
		}
	}},
	{"a late response on the idle connection", http.MethodGet, "unsolicited upstream response", func(m string) func(*http.Request, net.Conn) {
		return func(_ *http.Request, c net.Conn) {
			fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
			time.Sleep(150 * time.Millisecond)
			fmt.Fprintf(c, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s", len(m), m)
		}
	}},
}

func TestUpstreamBytesNeverReachTheConsole(t *testing.T) {
	for _, tc := range upstreamCases {
		for _, guarded := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/guarded=%v", tc.name, guarded), func(t *testing.T) {
				m := marker(t)
				buf := withConsole(t, guarded)
				front := frontFor(t, rawUpstream(t, tc.answer(m)))
				req, _ := http.NewRequest(tc.method, front.URL+"/", nil)
				resp, err := front.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				io.Copy(io.Discard, resp.Body)
				resp.Body.Close()
				if !guarded {
					// the positive control: without the guard, net/http prints the app's bytes
					if !waitFor(buf, m, 3*time.Second) {
						t.Fatalf("control: the scenario did not leak unguarded, so the guarded run would prove nothing; log: %q", buf.String())
					}
					return
				}
				if !waitFor(buf, "DOM front: "+tc.class, 3*time.Second) {
					t.Fatalf("guarded: no %q line; log: %q", tc.class, buf.String())
				}
				if strings.Contains(buf.String(), m) {
					t.Fatalf("guarded: the marker reached the console: %q", buf.String())
				}
			})
		}
	}
}

func TestAHandlerPanicNeverPrintsItsValue(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		t.Run(fmt.Sprintf("guarded=%v", guarded), func(t *testing.T) {
			m := marker(t)
			buf := withConsole(t, guarded)
			srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic("value " + m) }))
			srv.Config.ErrorLog = consoleLog
			srv.Start()
			defer srv.Close()
			if resp, err := srv.Client().Get(srv.URL); err == nil {
				resp.Body.Close()
			}
			if !guarded {
				if !waitFor(buf, m, 3*time.Second) {
					t.Fatalf("control: net/http did not print the panic value unguarded; log: %q", buf.String())
				}
				return
			}
			if !waitFor(buf, "DOM front: panic (withheld)", 3*time.Second) || strings.Contains(buf.String(), m) {
				t.Fatalf("guarded: %q", buf.String())
			}
		})
	}
}

func TestAPanicValueCannotSmuggleADOMLine(t *testing.T) {
	m := marker(t)
	buf := withConsole(t, true)
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("x\nDOM smuggled " + m)
	}))
	srv.Config.ErrorLog = consoleLog
	srv.Start()
	defer srv.Close()
	if resp, err := srv.Client().Get(srv.URL); err == nil {
		resp.Body.Close()
	}
	if !waitFor(buf, "DOM front: panic (withheld)", 3*time.Second) || strings.Contains(buf.String(), m) ||
		strings.Contains(buf.String(), "smuggled") {
		t.Fatalf("log: %q", buf.String())
	}
}

func TestATLSHandshakeErrorIsAClassOnly(t *testing.T) {
	buf := withConsole(t, true)
	srv := httptest.NewUnstartedServer(http.NotFoundHandler())
	srv.Config.ErrorLog = consoleLog
	srv.StartTLS()
	defer srv.Close()
	c, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	m := marker(t)
	fmt.Fprintf(c, "%s not a tls hello\r\n\r\n", m)
	c.Close()
	if !waitFor(buf, "DOM front: tls handshake error", 3*time.Second) || strings.Contains(buf.String(), m) ||
		strings.Contains(buf.String(), "127.0.0.1") {
		t.Fatalf("log: %q", buf.String())
	}
	_ = tls.VersionTLS13
}

func TestTheFrontsOwnDOMLinesStillPass(t *testing.T) {
	buf := withConsole(t, true)
	// the proxy's own statement (ready.go), through the std logger with its timestamp
	front := frontFor(t, "127.0.0.1:1") // nothing listens: the proxy says "unreachable"
	resp, err := front.Client().Get(front.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if !waitFor(buf, "DOM proxy: GET unreachable", 3*time.Second) || strings.Contains(buf.String(), "DOM front:") {
		t.Fatalf("log: %q", buf.String())
	}
}

// fd 2 itself: the Go runtime writes a fatal panic's value straight to fd 2, below any logger. A child process runs
// guardConsole and then does exactly that; its stderr (what the console would get) must not carry the marker, while
// its DOM line does. The unguarded child is the control.
func TestGuardChild(t *testing.T) {
	m := os.Getenv("FRONT_GUARD_CHILD")
	if m == "" {
		t.Skip("run as a child by TestTheRuntimesCrashOutputNeverReachesTheConsole")
	}
	if os.Getenv("FRONT_GUARD_ON") == "1" {
		if err := guardConsole(); err != nil {
			fmt.Printf("DOM ERROR guard: %v\n", err)
			os.Exit(3)
		}
	}
	log.Printf("DOM proxy: GET unreachable")
	// fd 2 carries nothing of the front's, so NOTHING on it passes, not even a line that starts with DOM (the smuggle
	// twin of the logger case); written directly so it is pumped deterministically before the crash below
	fmt.Fprintf(os.Stderr, "a direct stderr write %s\nDOM smuggled %s\n", m, m)
	time.Sleep(200 * time.Millisecond) // the pump drains the direct write first
	go func() { panic("fatal\nDOM smuggled " + m) }()
	time.Sleep(5 * time.Second)
}

func TestTheRuntimesCrashOutputNeverReachesTheConsole(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		t.Run(fmt.Sprintf("guarded=%v", guarded), func(t *testing.T) {
			m := marker(t)
			cmd := exec.Command(os.Args[0], "-test.run=^TestGuardChild$", "-test.count=1")
			on := "0"
			if guarded {
				on = "1"
			}
			cmd.Env = append(os.Environ(), "FRONT_GUARD_CHILD="+m, "FRONT_GUARD_ON="+on)
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			cmd.Stdout = io.Discard
			if err := cmd.Run(); err == nil {
				t.Fatal("the child should have crashed")
			}
			out := stderr.String()
			if !guarded {
				if !strings.Contains(out, m) {
					t.Fatalf("control: the unguarded crash did not show the marker: %q", out)
				}
				return
			}
			if strings.Contains(out, m) || strings.Contains(out, "smuggled") {
				t.Fatalf("guarded: the marker (or a smuggled DOM line) reached the console: %q", out)
			}
			if !strings.Contains(out, "DOM proxy: GET unreachable") || !strings.Contains(out, "DOM front: output withheld") {
				t.Fatalf("guarded: the DOM line or the withheld class is missing: %q", out)
			}
		})
	}
}

// Another package's lines reach stdout only as the front's own statements (enclave-e3's L1): the egress forwarder's
// Logf is domLogf(p.logf), so each of its lines is "DOM egress origin #N: <closed-set class>".
func TestTheForwardersLinesAreDOMStatements(t *testing.T) {
	var got []string
	logf := domLogf(func(format string, a ...any) { got = append(got, fmt.Sprintf(format, a...)) })
	logf("egress origin #%d: %s", 2, "refused by the host")
	if len(got) != 1 || got[0] != "DOM egress origin #2: refused by the host" {
		t.Fatalf("%q", got)
	}
	if domLogf(nil) != nil {
		t.Fatal("no logger stays no logger")
	}
}

// LIVENESS (enclave-bf's review of fbc50ea4): a guarded front whose runtime THROWS with thousands of goroutines (a
// stack overflow here; "runtime: out of memory" is the same kind of throw) must EXIT, not block forever writing its
// traceback into a pipe nobody can drain while the world is stopped. Unfixed (a blocking fd 2) this child hangs.
func TestGuardHangChild(t *testing.T) {
	if os.Getenv("FRONT_GUARD_HANG_CHILD") != "1" {
		t.Skip("run as a child by TestARuntimeThrowUnderTheGuardStillExits")
	}
	if err := guardConsole(); err != nil {
		fmt.Printf("DOM ERROR guard: %v\n", err)
		os.Exit(3)
	}
	block := make(chan struct{})
	for i := 0; i < 20000; i++ {
		go func() { <-block }()
	}
	debug.SetMaxStack(1 << 20)
	var recurse func(n int) int
	recurse = func(n int) int { var pad [256]byte; pad[0] = byte(n); return recurse(n+1) + int(pad[0]) }
	fmt.Println(recurse(0))
}

func TestARuntimeThrowUnderTheGuardStillExits(t *testing.T) {
	for _, tb := range []string{"", "all"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestGuardHangChild$", "-test.count=1")
		cmd.Env = append(os.Environ(), "FRONT_GUARD_HANG_CHILD=1", "GOTRACEBACK="+tb)
		var stderr bytes.Buffer
		cmd.Stderr = &stderr
		cmd.Stdout = io.Discard
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- cmd.Wait() }()
		select {
		case err := <-done:
			if err == nil {
				t.Fatalf("GOTRACEBACK=%q: the child should have died of its throw", tb)
			}
			if strings.Contains(stderr.String(), "goroutine ") {
				t.Fatalf("GOTRACEBACK=%q: a traceback reached the console: %.200q", tb, stderr.String())
			}
		case <-time.After(20 * time.Second):
			cmd.Process.Kill()
			<-done
			t.Fatalf("GOTRACEBACK=%q: the guarded child HUNG after a runtime throw (blocking fd 2)", tb)
		}
	}
}
