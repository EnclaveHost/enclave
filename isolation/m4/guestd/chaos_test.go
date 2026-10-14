package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

// restartForTest is what a guestd restart does to the channel: a new instance, no sessions, no nonces.
func (a *controlAuth) restartForTest() {
	a.mu.Lock()
	a.instance = randHex(16)
	a.sessions = map[string]*session{}
	a.nonces = map[string]time.Time{}
	a.mu.Unlock()
}

type chaosCfg struct {
	HelloDelayN     int    `json:"helloDelayN"`
	HelloDelayMs    int    `json:"helloDelayMs"`
	HelloStall      bool   `json:"helloStall"`
	RespDelayMs     int    `json:"respDelayMs"`
	StallPath       string `json:"stallPath"`
	TruncatePath    string `json:"truncatePath"`
	OversizePath    string `json:"oversizePath"`
	OversizeBytes   int    `json:"oversizeBytes"`
	OversizeChunked bool   `json:"oversizeChunked"`
	Fake401Method   string `json:"fake401Method"`
	Fake401Path     string `json:"fake401Path"`
	Fake401Times    int    `json:"fake401Times"`
}

// chaos stands between the client and the REAL server and misbehaves on request. Everything it asserts about what
// happened comes from the server's own state (/__stats), never from the client's account of it. Test-only.
type chaos struct {
	s                *server
	mu               sync.Mutex
	cfg              chaosCfg
	hellos, sessions int
}

func (c *chaos) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/__chaos":
		var cfg chaosCfg
		_ = json.NewDecoder(r.Body).Decode(&cfg)
		c.mu.Lock()
		c.cfg = cfg
		c.mu.Unlock()
		w.WriteHeader(204)
		return
	case "/__restart":
		c.s.Auth.restartForTest()
		w.WriteHeader(204)
		return
	case "/__stats":
		c.mu.Lock()
		h, ss := c.hellos, c.sessions
		c.mu.Unlock()
		names := map[string]int{}
		c.s.mu.Lock()
		for _, v := range c.s.vms {
			names[v.Name]++
		}
		c.s.mu.Unlock()
		writeJSON(w, 200, map[string]any{"hellos": h, "sessions": ss, "names": names})
		return
	}
	c.mu.Lock()
	cfg := c.cfg
	fake := false
	n := 0
	if r.URL.Path == "/control/hello" {
		c.hellos++
		n = c.hellos
	} else if cfg.Fake401Path == r.URL.Path && cfg.Fake401Method == r.Method && c.cfg.Fake401Times > 0 {
		fake = true
		c.cfg.Fake401Times--
	}
	c.mu.Unlock()
	if r.URL.Path == "/control/hello" {
		if cfg.HelloStall {
			<-r.Context().Done()
			return
		}
		if n == cfg.HelloDelayN {
			time.Sleep(time.Duration(cfg.HelloDelayMs) * time.Millisecond)
		}
	}
	rec := httptest.NewRecorder()
	c.s.ServeHTTP(rec, r) // the request is really processed, whatever happens to its answer below
	if r.URL.Path == "/control/session" && rec.Code == 200 {
		c.mu.Lock()
		c.sessions++
		c.mu.Unlock()
	}
	switch {
	case cfg.StallPath != "" && cfg.StallPath == r.URL.Path:
		<-r.Context().Done()
		return
	case fake: // an unsigned "handshake again" in place of the real, signed answer
		writeJSON(w, 401, map[string]any{"error": "session expired or unknown: handshake again", "reauth": true})
		return
	case cfg.TruncatePath != "" && cfg.TruncatePath == r.URL.Path:
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		body := rec.Body.Bytes()
		fmt.Fprintf(buf, "HTTP/1.1 %d OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\nX-Guestd-Response-Mac: %s\r\n\r\n",
			rec.Code, len(body)+100, rec.Header().Get("X-Guestd-Response-Mac"))
		buf.Write(body[:len(body)/2])
		buf.Flush()
		conn.Close()
		return
	case cfg.OversizePath != "" && cfg.OversizePath == r.URL.Path:
		big := bytes.Repeat([]byte("x"), cfg.OversizeBytes)
		if !cfg.OversizeChunked {
			w.Header().Set("Content-Length", fmt.Sprint(len(big)))
		}
		w.WriteHeader(200)
		for i := 0; i < len(big); i += 64 << 10 {
			_, _ = w.Write(big[i:min(i+64<<10, len(big))])
			w.(http.Flusher).Flush()
		}
		return
	}
	if r.Header.Get("X-Guestd-Session") != "" && cfg.RespDelayMs > 0 {
		time.Sleep(time.Duration(cfg.RespDelayMs) * time.Millisecond)
	}
	for k, v := range rec.Header() {
		w.Header()[k] = v
	}
	w.WriteHeader(rec.Code)
	_, _ = w.Write(rec.Body.Bytes())
}

func chaosRun(t *testing.T, client string, only string) (map[string]any, *chaos) {
	t.Helper()
	r := newRig(t)
	r.s.Auth = newControlAuth(testKey, r.s.Now)
	ch := &chaos{s: r.s}
	ts := httptest.NewServer(ch)
	t.Cleanup(ts.Close)
	p, _ := r.bundle("A", contract.Policy{})
	cmd := exec.Command("node", "testdata/client-chaos.mjs", ts.URL, hex.EncodeToString(testKey), client, p, only)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	var last string
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		last = sc.Text()
	}
	t.Logf("%s: %s", client, last)
	var got map[string]any
	if err := json.Unmarshal([]byte(last), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	return got, ch
}

func field(m map[string]any, path ...string) any {
	var v any = m
	for _, k := range path {
		mm, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = mm[k]
	}
	return v
}

// The GENUINE failure, kept: the client as it was at a40f1019 fails the concurrent-first-request case - two
// handshakes, and the first request's authentic answer checked against the second session's key.
func TestTheReportedRaceIsRealInTheOldClient(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	got, _ := chaosRun(t, "./control-client-a40f1019.mjs", "concurrent")
	res := fmt.Sprint(field(got, "concurrentFirst", "results"))
	if !strings.Contains(res, "failed its MAC") || fmt.Sprint(field(got, "concurrentFirst", "handshakes")) != "2" {
		t.Fatalf("the reported repro no longer reproduces against the old client, so the test below would prove nothing: %v", got)
	}
}

func TestTheClientUnderChaos(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	got, _ := chaosRun(t, "../control-client.mjs", "")
	eq := func(what string, v any, want string) {
		if s := fmt.Sprint(v); s != want {
			t.Errorf("%s: got %s, want %s", what, s, want)
		}
	}
	eq("concurrent first requests", field(got, "concurrentFirst", "results"), "[200 200]")
	eq("... with ONE handshake", field(got, "concurrentFirst", "handshakes"), "1")
	eq("concurrent requests after a restart", field(got, "restartConcurrent", "results"), "[200 200 200]")
	eq("... renewed ONCE", field(got, "restartConcurrent", "handshakes"), "1")
	eq("a stalled answer", field(got, "stall", "kind"), "timeout")
	eq("... bounded", field(got, "stall", "bounded"), "true")
	eq("a stalled handshake", field(got, "helloStall", "kind"), "timeout")
	eq("a truncated answer is refused", field(got, "truncated", "refused"), "true")
	eq("... and the session survives it", field(got, "truncated", "after"), "200")
	eq("an oversized declared answer", field(got, "oversize", "kind"), "oversize")
	eq("an oversized streamed answer", field(got, "oversizeChunked", "kind"), "oversize")
	eq("a mutating request whose reply was replaced, no reconcile", field(got, "mutNoReconcile", "kind"), "outcome-unknown")
	eq("... is reported as possibly executed", field(got, "mutNoReconcile", "mayHaveExecuted"), "true")
	eq("... and executed exactly ONCE", field(got, "mutNoReconcile", "executed"), "1")
	eq("the same with reconcile", field(got, "mutReconcile", "status"), "reconciled")
	eq("... executed exactly ONCE", field(got, "mutReconcile", "executed"), "1")
	eq("a genuine restart, reconcile finds nothing, sent once more", field(got, "mutAfterRestart", "status"), "201")
	eq("... executed exactly ONCE", field(got, "mutAfterRestart", "executed"), "1")
	eq("a read whose reply was replaced is retried once", field(got, "getReplaced", "status"), "200")
	eq("a declared-idempotent lease is retried once", field(got, "leaseReplaced", "status"), "200")
}
