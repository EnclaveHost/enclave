package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestReadyAnswersOnlyWhenTheAppAcceptsConnections(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := l.Addr().String()
	rd := &readiness{upstream: addr, mode: "run", appID: strings.Repeat("ab", 32), dial: time.Second}
	get := func() (int, map[string]any) {
		w := httptest.NewRecorder()
		rd.serve(w, httptest.NewRequest("GET", readyPath, nil))
		var m map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &m)
		return w.Code, m
	}
	code, m := get()
	if code != 200 || m["ready"] != true || m["appId"] != rd.appID || m["mode"] != "run" || m["port"] == nil {
		t.Fatalf("a listening app: %d %v", code, m)
	}
	l.Close()
	code, m = get()
	if code != 503 || m["ready"] != false || m["why"] == nil {
		t.Fatalf("an app that is not listening was called ready: %d %v", code, m)
	}
	w := httptest.NewRecorder()
	rd.serve(w, httptest.NewRequest("POST", readyPath, nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d", w.Code)
	}
}

// F13: the app must not be told the host's transport address as the client's, nor a client-supplied one as if
// the front had vouched for it; the Host the client asked for, the path and the query reach it unchanged.
func TestTheProxySetsNoForwardedForAndKeepsTheHost(t *testing.T) {
	var got *http.Request
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Clone(r.Context())
		b, _ := io.ReadAll(r.Body)
		_, _ = w.Write(append([]byte("echo:"), b...))
	}))
	defer app.Close()
	up := strings.TrimPrefix(app.URL, "http://")
	front := httptest.NewServer(appProxy(up))
	defer front.Close()
	req, _ := http.NewRequest("POST", front.URL+"/b/bin1?x=1", strings.NewReader("body"))
	req.Host = "0ddbd824.app.enclave.host"
	req.Header.Set("X-Forwarded-For", "203.0.113.9")
	req.Header.Set("X-Forwarded-Host", "evil.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(b) != "echo:body" {
		t.Fatalf("body %q", b)
	}
	for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "Forwarded"} {
		if v := got.Header.Values(h); len(v) != 0 {
			t.Errorf("the app was sent %s: %v", h, v)
		}
	}
	if got.Host != "0ddbd824.app.enclave.host" || got.URL.Path != "/b/bin1" || got.URL.RawQuery != "x=1" {
		t.Fatalf("host %q path %q query %q", got.Host, got.URL.Path, got.URL.RawQuery)
	}
}

// enclave-63's G3: a wedged app (accepts, never answers) gets the client a 504 at the header deadline instead of a
// connection held open forever; a slow stream that has sent its headers is not cut by that deadline.
func TestAWedgedAppIsAnsweredWith504AtTheHeaderDeadline(t *testing.T) {
	release := make(chan struct{})
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer app.Close()
	defer close(release)
	front := httptest.NewServer(appProxyWithin(strings.TrimPrefix(app.URL, "http://"), 200*time.Millisecond))
	defer front.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	start := time.Now()
	res, err := client.Get(front.URL + "/wedged")
	if err != nil {
		t.Fatalf("the client was left waiting instead of answered: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusGatewayTimeout {
		t.Fatalf("a wedged app must give 504, got %d", res.StatusCode)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("answered after %s, not at the header deadline", d)
	}
}

func TestAStreamThatSentItsHeadersOutlivesTheHeaderDeadline(t *testing.T) {
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		for i := 0; i < 4; i++ {
			time.Sleep(150 * time.Millisecond) // 600 ms in all, three times the header deadline
			_, _ = w.Write([]byte("x"))
			w.(http.Flusher).Flush()
		}
	}))
	defer app.Close()
	front := httptest.NewServer(appProxyWithin(strings.TrimPrefix(app.URL, "http://"), 200*time.Millisecond))
	defer front.Close()
	res, err := (&http.Client{Timeout: 5 * time.Second}).Get(front.URL + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != 200 || string(b) != "xxxx" {
		t.Fatalf("a stream past the header deadline was cut: status %d body %q err %v", res.StatusCode, b, err)
	}
}

func TestTheProductionProxyHasAHeaderDeadline(t *testing.T) {
	tr := appProxy("127.0.0.1:1").Transport.(*http.Transport)
	if tr.ResponseHeaderTimeout != appHeaderTimeout || appHeaderTimeout <= 0 {
		t.Fatalf("the proxy the front serves with has header timeout %s", tr.ResponseHeaderTimeout)
	}
}

// The proxy's log line reaches the HOST (the console is the serial file), so a failure logs a bounded outcome and
// nothing of the request: not its path, its query or a header, and a non-standard method only as "other"
// (enclave-d1's review of aeb3d328). Both failures are driven: a wedged app (504) and an unreachable one (502).
func TestTheProxyLogsNoRequestData(t *testing.T) {
	var buf bytes.Buffer
	log.SetOutput(&buf)
	defer log.SetOutput(io.Discard)
	release := make(chan struct{})
	wedged := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-release }))
	defer wedged.Close()
	defer close(release)
	gone := httptest.NewServer(http.NotFoundHandler())
	goneAddr := strings.TrimPrefix(gone.URL, "http://")
	gone.Close() // nothing listens there now
	const path, query, header = "/users/alice-7f3a/notes", "q=private-query-5d0c", "private-header-9e1b"
	for _, c := range []struct {
		upstream, method, want string
		status                 int
	}{
		{strings.TrimPrefix(wedged.URL, "http://"), http.MethodGet, "DOM proxy: GET timeout", http.StatusGatewayTimeout},
		{goneAddr, http.MethodPost, "DOM proxy: POST unreachable", http.StatusBadGateway},
		{goneAddr, "PROPFIND-alice-7f3a", "DOM proxy: other unreachable", http.StatusBadGateway},
	} {
		buf.Reset()
		front := httptest.NewServer(appProxyWithin(c.upstream, 200*time.Millisecond))
		req, _ := http.NewRequest(c.method, front.URL+path+"?"+query, nil)
		req.Header.Set("Authorization", header)
		res, err := (&http.Client{Timeout: 5 * time.Second}).Do(req)
		front.Close()
		if err != nil {
			t.Fatalf("%s: %v", c.want, err)
		}
		res.Body.Close()
		if res.StatusCode != c.status {
			t.Fatalf("%s: status %d, want %d", c.want, res.StatusCode, c.status)
		}
		got := buf.String()
		if !strings.Contains(got, c.want) {
			t.Fatalf("the log line %q does not say %q", got, c.want)
		}
		for _, secret := range []string{"alice-7f3a", "notes", "private-query-5d0c", "private-header-9e1b", "/users", "127.0.0.1"} {
			if strings.Contains(got, secret) {
				t.Fatalf("the host-visible log line %q carries %q", got, secret)
			}
		}
	}
}
