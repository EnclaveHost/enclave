// The app half of "running", and the proxy to it.
//
// READINESS. A manager must not call a domain running because its front answered: the front starts before the app
// has bound its port, and a command app (enclave-catalog-bundle/2) binds whenever it gets there. So the front answers
//
//	GET /.well-known/enclave-ready  200 {"ready":true, "appId", "mode", "port"}   the app's upstream accepted a TCP
//	                                                                              connect, just now
//	                                503 {"ready":false, "why", ...}               it did not
//
// on the same TLS as the attestation document, so it is said by the key a manager just verified. A manager's rule:
// running = the attestation verified on THIS handshake's key with a fresh nonce, AND enclave-ready 200 on a session
// with the same key, within a deadline. It proves the app's port accepts connections inside this domain, not that
// the app answers any particular request well.
//
// THE PROXY sets no X-Forwarded-For, and strips one the client sent. No client address reaches a domain: its only
// channel is a vsock or hv_sock stream from the host, so the peer the front sees is the HOST (its CID, e.g. "2"),
// and a header naming it would tell the app something false (finding F13, isolation/m4/evidence/
// production-canary-2026-09-24/f10-hookbin/README.txt). The Host header the client sent is kept.
package main

import (
	"encoding/json"
	"errors"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"time"
)

const readyPath = "/.well-known/enclave-ready"

type readiness struct {
	upstream string // host:port of the app on this domain's loopback
	mode     string // "serve": the runtime serves a wasi:http component; "run": a wasi:cli command binds the port itself
	appID    string // hex, the same AppID the attestation names
	dial     time.Duration
}

func (rd *readiness) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	out := map[string]any{"appId": rd.appID, "mode": rd.mode}
	if _, p, err := net.SplitHostPort(rd.upstream); err == nil {
		if n, err := strconv.Atoi(p); err == nil {
			out["port"] = n
		}
	}
	status := http.StatusOK
	if c, err := net.DialTimeout("tcp", rd.upstream, rd.dial); err != nil {
		status = http.StatusServiceUnavailable
		out["ready"], out["why"] = false, "the app is not accepting connections on "+rd.upstream+" yet"
	} else {
		c.Close()
		out["ready"] = true
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("cache-control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(out)
}

// appHeaderTimeout bounds how long the app may take to START answering (enclave-63's G3). Without it a wedged app
// (accepting, never answering) held every client connection open indefinitely, so the host's view was accepted
// connections that never close. 180 s is the window the platform's app path already gives a response
// (supervisor.js headersTimeout 185 s; a non-streamed completion dies at about 180 s), so no request that works today is cut
// sooner. It bounds the headers only: a stream that has sent its headers may run as long as it keeps going, which is
// also why the front's server has no WriteTimeout.
const appHeaderTimeout = 180 * time.Second

// appProxy forwards to the app at upstream as plaintext on the domain's loopback. Rewrite (not Director) is what
// keeps X-Forwarded-For out: with Rewrite the forwarding headers are removed from the outbound request and none is
// added unless SetXForwarded is called, which it is not.
func appProxy(upstream string) *httputil.ReverseProxy {
	return appProxyWithin(upstream, appHeaderTimeout)
}

func appProxyWithin(upstream string, headerTimeout time.Duration) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: upstream}
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host // the name the client asked for, as the app has always seen it
		},
		Transport: &http.Transport{DialContext: (&net.Dialer{}).DialContext, MaxIdleConnsPerHost: 64,
			ResponseHeaderTimeout: headerTimeout},
		// the proxy's own error lines (a body-copy error) go through the console filter; the Transport logs an app's
		// unsolicited bytes through the std logger, which guardConsole routes through the same filter (console.go)
		ErrorLog: consoleLog,
		// A client is told which it was: 504 when the app did not start answering in time, 502 when it could not be
		// reached at all. Neither leaves the connection hanging.
		//
		// The log line goes to the console, which is the HOST's serial file, so it carries a bounded outcome and
		// nothing of the request: no path, no query, no header, and the method only as one of a fixed set (a client
		// chooses the method token). The same rule as the host's egress log (enclave-d1's review of aeb3d328).
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				log.Printf("DOM proxy: %s timeout (no response headers within %s)", methodClass(r.Method), headerTimeout)
				http.Error(w, "the app did not start answering within "+headerTimeout.String(), http.StatusGatewayTimeout)
				return
			}
			log.Printf("DOM proxy: %s unreachable", methodClass(r.Method))
			http.Error(w, "the app could not be reached", http.StatusBadGateway)
		},
	}
}

// methodClass is the request method as the console may show it: a standard method's name, else "other".
func methodClass(m string) string {
	switch m {
	case http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete,
		http.MethodOptions, http.MethodConnect, http.MethodTrace:
		return m
	}
	return "other"
}
