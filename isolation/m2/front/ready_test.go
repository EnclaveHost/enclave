package main

import (
	"encoding/json"
	"io"
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
