package main

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const rpcHealthy = `{"localReady":true,"chains":[1,8453]}`

func TestRPCHealthStrictBody(t *testing.T) {
	for _, body := range []string{rpcHealthy, `{"chains":[1,8453],"localReady":true}`} {
		if err := rpcHealthBody([]byte(body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, body := range []string{
		`{"localReady":false,"chains":[1,8453]}`,
		`{"localReady":null,"chains":[1,8453]}`,
		`{"localReady":true,"chains":null}`,
		`{"localReady":true,"chains":[8453,1]}`,
		`{"localReady":true,"chains":[1,8453,1]}`,
		`{"localReady":true,"chains":[1,8453],"localReady":true}`,
		`{"localReady":true,"chains":[1,8453],"extra":0}`,
		`{"localReady":"true","chains":[1,8453]}`,
		`{"localReady":true}`, rpcHealthy + `{}`, `[]`, `{`,
	} {
		if err := rpcHealthBody([]byte(body)); err == nil {
			t.Fatalf("accepted %s", body)
		}
	}
}

func TestRPCHealthFreshAndReadiness(t *testing.T) {
	var calls atomic.Int32
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.Path != "/health" {
			t.Error("wrong health request")
		}
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			io.WriteString(w, rpcHealthy)
		} else {
			io.WriteString(w, `{"localReady":false,"chains":[1,8453]}`)
		}
	}))
	defer s.Close()
	addr := strings.TrimPrefix(s.URL, "http://")
	if err := rpcHealth(context.Background(), addr); err != nil {
		t.Fatal(err)
	}
	if err := rpcHealth(context.Background(), addr); err == nil {
		t.Fatal("cached a prior healthy response")
	}
	if calls.Load() != 2 {
		t.Fatal("not freshly queried")
	}
	if nativeRPCFront {
		rd := &readiness{upstream: addr, mode: "run", appID: "bound-app"}
		w := httptest.NewRecorder()
		rd.serve(w, httptest.NewRequest("GET", readyPath, nil))
		if w.Code != 503 || !strings.Contains(w.Body.String(), `"ready":false`) {
			t.Fatal("listening unhealthy controller was ready", w.Body.String())
		}
		calls.Store(0)
		w = httptest.NewRecorder()
		rd.serve(w, httptest.NewRequest("GET", readyPath, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"appId":"bound-app"`) || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestRPCHealthBoundsAndRefusals(t *testing.T) {
	for _, kind := range []string{"redirect", "content-type", "large", "large-chunked", "status", "header-stall", "body-stall"} {
		t.Run(kind, func(t *testing.T) {
			var redirected atomic.Bool
			s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/health" {
					redirected.Store(true)
					io.WriteString(w, rpcHealthy)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				switch kind {
				case "redirect":
					w.Header().Set("Location", "/elsewhere")
					w.WriteHeader(302)
				case "content-type":
					w.Header().Set("Content-Type", "text/plain")
					io.WriteString(w, rpcHealthy)
				case "large":
					io.WriteString(w, rpcHealthy+strings.Repeat(" ", 600))
				case "large-chunked":
					w.(http.Flusher).Flush()
					io.WriteString(w, rpcHealthy+strings.Repeat(" ", 600))
				case "status":
					w.WriteHeader(503)
					io.WriteString(w, rpcHealthy)
				case "header-stall":
					<-r.Context().Done()
				case "body-stall":
					w.(http.Flusher).Flush()
					<-r.Context().Done()
				}
			}))
			defer s.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			start := time.Now()
			if err := rpcHealth(ctx, strings.TrimPrefix(s.URL, "http://")); err == nil {
				t.Fatal("accepted invalid health")
			}
			if time.Since(start) > time.Second {
				t.Fatal("lost original request deadline")
			}
			if redirected.Load() {
				t.Fatal("followed redirect")
			}
		})
	}
	for _, addr := range []string{"localhost:8000", "192.0.2.1:8000", "[::1]:8000", "127.0.0.1:http"} {
		if err := rpcHealth(context.Background(), addr); err == nil {
			t.Fatal("nonliteral loopback accepted")
		}
	}
}

func TestRPCPackageCancellation(t *testing.T) {
	host, guest := net.Pipe()
	defer host.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	var id [32]byte
	id[31] = 1
	start := time.Now()
	if _, err := readRPCPackage(ctx, func() (net.Conn, error) { return guest, nil }, id); err == nil {
		t.Fatal("unanswered package accepted")
	}
	if time.Since(start) > time.Second {
		t.Fatal("frame read escaped deadline")
	}
	if _, err := readRPCPackage(context.Background(), nil, id); err == nil {
		t.Fatal("nil transport accepted")
	}
	if _, err := readRPCPackage(context.Background(), nil, [32]byte{}); err == nil {
		t.Fatal("zero deployment accepted")
	}
}
