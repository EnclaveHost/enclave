package main

// The owner-configured boot hook runs once, inside the guest, after the app
// listens. No browser, external ingress, or host-provided URL is involved.
import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func configuredWarmup(config string) string {
	var c struct {
		Warmup string `json:"warmup"`
	}
	if json.Unmarshal([]byte(config), &c) != nil {
		return ""
	}
	p := c.Warmup
	if len(p) == 0 || len(p) > 128 || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsAny(p, "\\\r\n\t") {
		return ""
	}
	u, err := url.ParseRequestURI(p)
	if err != nil || u.IsAbs() || u.Host != "" || u.Fragment != "" {
		return ""
	}
	return p
}

// Only bounded outcome classes reach the host console. The path, query,
// response and errors can contain owner secrets and must never be logged.
func bootWarmup(ctx context.Context, upstream, path string, timeout time.Duration) string {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	transport := &http.Transport{
		Proxy:             nil,
		DisableKeepAlives: true,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, "tcp", upstream)
		},
		MaxResponseHeaderBytes: 16 << 10,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+upstream+path, nil)
	if err != nil {
		return "invalid request"
	}
	req.Header.Set("User-Agent", "enclave-guest-warmup")
	resp, err := client.Do(req)
	if err != nil {
		return "request failed"
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "HTTP failure"
	}
	// Warmup may send headers before loading finishes; drain its bounded body
	// so an early close does not cancel the model load or prefix preparation.
	n, err := io.Copy(io.Discard, io.LimitReader(resp.Body, (1<<20)+1))
	if err != nil {
		return "response failed"
	}
	if n > 1<<20 {
		return "response too large"
	}
	return "completed"
}
