package egress

// Opt-in integration against the real eyesoff-ai component and deployed
// Wasmtime. No inference, credentials, or mutable third-party endpoints.
import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPublicHTTPSWasiHTTP(t *testing.T) {
	runtime, app := os.Getenv("EGRESS_WASMTIME"), os.Getenv("EGRESS_EYESOFF_WASM")
	if runtime == "" || app == "" {
		t.Skip("set EGRESS_WASMTIME and EGRESS_EYESOFF_WASM for public-network integration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	hl, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer hl.Close()
	srv := &Server{Dialer: &Dialer{Resolver: net.DefaultResolver, MaxConcurrent: 8, MaxPerMinute: 30}, CIDOf: func(net.Conn) uint32 { return 1 }, Admit: func(id uint32) bool { return id == 1 }}
	go srv.Serve(ctx, hl)
	f := &Forwarder{Policy: &Policy{PublicHTTPS: true}, PublicListen: "127.0.0.1:0", Upstream: func() (net.Conn, error) { return net.Dial("tcp", hl.Addr().String()) }}
	if err = f.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	addr, _ := f.PublicAddr()
	al, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	appAddr := al.Addr().String()
	al.Close()
	log, err := os.Create(filepath.Join(t.TempDir(), "wasmtime.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd := exec.CommandContext(ctx, runtime, "serve", "-S", "cli", "-S", "nn", "-S", "egress="+addr.String(), "--env", "ENCLAVE_CONFIG", "--addr", appAddr, app)
	cmd.Env = append(os.Environ(), "ENCLAVE_EGRESS_CRED=guest:public-https", "ENCLAVE_HTTP_POOL=1", `ENCLAVE_CONFIG={"egress":"public-https","search":{"provider":"exa","endpoint":"https://api.exa.ai/search","timeout_s":20}}`)
	cmd.Stdout = log
	cmd.Stderr = log
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cancel()
		cmd.Wait()
		b, _ := os.ReadFile(log.Name())
		if t.Failed() {
			t.Logf("runtime: %s", b)
		}
	}()
	cl := &http.Client{Timeout: 30 * time.Second}
	for deadline := time.Now().Add(20 * time.Second); ; {
		c, e := net.DialTimeout("tcp", appAddr, 100*time.Millisecond)
		if e == nil {
			c.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("runtime did not start")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, target := range []string{"https://example.com", "https://enclave.host", "https://example.com"} {
		r, err := cl.Get("http://" + appAddr + "/search?url=" + url.QueryEscape(target))
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(r.Body)
		r.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]any
		if r.StatusCode != 200 || json.Unmarshal(b, &result) != nil || len(b) < 40 {
			t.Fatalf("%s: HTTP %d %.600s", target, r.StatusCode, b)
		}
		t.Logf("%s: HTTP %d, %d bytes", target, r.StatusCode, len(b))
	}
	r, err := cl.Get("http://" + appAddr + "/search?url=" + url.QueryEscape("http://example.com"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(r.Body)
	r.Body.Close()
	if r.StatusCode == 200 || !strings.Contains(string(b), "error") {
		t.Fatal("plaintext HTTP unexpectedly allowed")
	}
}
