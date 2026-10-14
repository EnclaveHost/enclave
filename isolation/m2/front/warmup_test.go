package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestConfiguredWarmup(t *testing.T) {
	for _, c := range []string{"", `{}`, `{"warmup":false}`, `{"warmup":"https://evil.example/"}`, `{"warmup":"//evil.example/"}`, `{"warmup":"/x\\r\\nInjected: yes"}`, `{"warmup":"/\\\\evil.example"}`} {
		if p := configuredWarmup(c); p != "" {
			t.Fatalf("accepted invalid config: %q", p)
		}
	}
	if p := configuredWarmup(`{"warmup":"/warmup?prefix=0"}`); p != "/warmup?prefix=0" {
		t.Fatal(p)
	}
	if p := configuredWarmup(`{"warmup":"/` + strings.Repeat("a", 128) + `"}`); p != "" {
		t.Fatal("accepted oversized path")
	}
}

func TestBootWarmupWaitsForBody(t *testing.T) {
	done := make(chan struct{})
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != "/warmup?prefix=0" || r.Header.Get("User-Agent") != "enclave-guest-warmup" {
			t.Error("wrong warmup request")
		}
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		time.Sleep(20 * time.Millisecond)
		w.Write([]byte(`{"ok":true}`))
		close(done)
	}))
	defer s.Close()
	if got := bootWarmup(context.Background(), strings.TrimPrefix(s.URL, "http://"), "/warmup?prefix=0", time.Second); got != "completed" {
		t.Fatal(got)
	}
	select {
	case <-done:
	default:
		t.Fatal("returned before warmup finished")
	}
}

func TestBootWarmupDoesNotFollowRedirects(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/warmup" {
			t.Error("followed redirect")
		}
		http.Redirect(w, r, "/private-secret", http.StatusFound)
	}))
	defer s.Close()
	if got := bootWarmup(context.Background(), strings.TrimPrefix(s.URL, "http://"), "/warmup", time.Second); got != "HTTP failure" {
		t.Fatal(got)
	}
}

func TestBootWarmupTimeoutAndFailure(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail" {
			http.Error(w, "private error", 500)
			return
		}
		<-r.Context().Done()
	}))
	defer s.Close()
	upstream := strings.TrimPrefix(s.URL, "http://")
	if got := bootWarmup(context.Background(), upstream, "/fail", time.Second); got != "HTTP failure" {
		t.Fatal(got)
	}
	if got := bootWarmup(context.Background(), upstream, "/slow", 20*time.Millisecond); got != "request failed" {
		t.Fatal(got)
	}
}
