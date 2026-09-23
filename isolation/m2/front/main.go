// front: the one port an M2 app domain exposes (isolation/DESIGN.md section 10). It runs inside the
// domain, beside the app:
//   - mints the domain's TLS key in guest memory at start; the key is never written anywhere;
//   - terminates TLS on vsock (the domain has no NIC, so this is its only channel);
//   - answers GET /.well-known/enclave-attestation?nonce=<64 hex> itself;
//   - proxies everything else, as plaintext on the guest's loopback, to the app (wasmtime serve).
//
// Under SEV-SNP the report's 64-byte report_data is
//
//	[0:32]  sha256(transport key SPKI DER || nonce)   the binding relay/snp-verify.mjs checks
//	[32:64] sha256 of the app .wasm                    names the app, as M1 did
//
// so a verifier that checks the report against the key ITS OWN handshake saw knows its traffic ends
// inside this measured domain. On T0 there is no hardware report, and the endpoint says so.
package main

import (
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"enclave.host/isolation/m2/domtls"
	"enclave.host/isolation/m2/vsock"
)

const attestPath = "/.well-known/enclave-attestation"

type doc struct {
	Tier         string `json:"tier"`
	Format       string `json:"format"`
	Report       string `json:"report,omitempty"` // base64 raw SNP report
	Certs        string `json:"certs,omitempty"`  // base64 auxblob (VCEK chain) when the host supplies one
	TransportKey string `json:"transportKey"`     // base64 SPKI DER; a verifier uses its handshake's, not this
	AppSha256    string `json:"appSha256"`
	Nonce        string `json:"nonce"`
	Reason       string `json:"reason,omitempty"`
}

type front struct {
	spki, appSha []byte
	snp          bool
	app          http.Handler
	tsmMu        sync.Mutex
}

func main() {
	port := flag.Uint("port", 443, "vsock port to serve TLS on")
	upstream := flag.String("upstream", "127.0.0.1:8080", "the app on the guest loopback")
	appShaPath := flag.String("app-sha", "/app.sha256", "hex sha256 of the app, written at build time")
	snp := flag.Bool("snp", false, "this domain is an SEV-SNP guest: serve hardware reports")
	flag.Parse()

	raw, err := os.ReadFile(*appShaPath)
	must(err)
	appSha, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(appSha) != 32 {
		die("app sha256 in %s is not 32 bytes of hex", *appShaPath)
	}
	cert, spki, err := domtls.Mint("enclave-domain")
	must(err)
	l, err := vsock.Listen(uint32(*port))
	must(err)

	rp := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: *upstream})
	rp.Transport = &http.Transport{DialContext: (&net.Dialer{}).DialContext, MaxIdleConnsPerHost: 64}
	f := &front{spki: spki, appSha: appSha, snp: *snp, app: rp}
	srv := &http.Server{Handler: f, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 2 * time.Minute}
	// No session tickets: every connection then proves the attested key in a full handshake, so a
	// client pins by comparing that key, never by tracking which session came from which handshake.
	tl := tls.NewListener(l, &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS13,
		SessionTicketsDisabled: true})

	// "serving" means both halves answer: TLS here, and the app behind it
	go func() {
		for deadline := time.Now().Add(120 * time.Second); ; time.Sleep(10 * time.Millisecond) {
			if c, err := net.DialTimeout("tcp", *upstream, time.Second); err == nil {
				c.Close()
				break
			}
			if time.Now().After(deadline) {
				die("app never listened on %s", *upstream)
			}
		}
		fp := sha256.Sum256(spki)
		fmt.Printf("DOM serving vsock=%d spki_sha256=%x ready_ms=%.0f\n", *port, fp, monoMs())
	}()
	must(srv.Serve(tl))
}

func (f *front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == attestPath {
		f.attest(w, r)
		return
	}
	f.app.ServeHTTP(w, r)
}

func (f *front) attest(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	nonce, err := hex.DecodeString(r.URL.Query().Get("nonce"))
	if err != nil || len(nonce) != 32 {
		http.Error(w, "nonce must be 32 bytes of hex", http.StatusBadRequest)
		return
	}
	d := doc{Tier: "T0", Format: "none", TransportKey: base64.StdEncoding.EncodeToString(f.spki),
		AppSha256: hex.EncodeToString(f.appSha), Nonce: hex.EncodeToString(nonce),
		Reason: "T0 domain: an ordinary KVM guest with no hardware attestation; the host can read its memory"}
	if f.snp {
		bind := sha256.Sum256(append(append([]byte{}, f.spki...), nonce...))
		rd := make([]byte, 64)
		copy(rd, bind[:])
		copy(rd[32:], f.appSha)
		rep, certs, err := f.report(rd)
		if err != nil {
			http.Error(w, "report: "+err.Error(), http.StatusInternalServerError)
			return
		}
		d.Tier, d.Format, d.Reason = "T1", "sev-snp-guest-domain-v1", ""
		d.Report = base64.StdEncoding.EncodeToString(rep)
		if len(certs) > 0 {
			d.Certs = base64.StdEncoding.EncodeToString(certs)
		}
	}
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(d)
}

// report asks the PSP, through configfs-tsm, for a report carrying rd, plus the certificate table the
// host attached (empty unless the host loaded one). One entry, used serially, so the outblob read is
// always the one for the inblob just written. The certificates come from the host and prove nothing by
// themselves: a verifier chains the VCEK to AMD's pinned root.
func (f *front) report(rd []byte) ([]byte, []byte, error) {
	f.tsmMu.Lock()
	defer f.tsmMu.Unlock()
	dir := "/sys/kernel/config/tsm/report/front"
	if err := os.Mkdir(dir, 0o755); err != nil && !os.IsExist(err) {
		return nil, nil, err
	}
	if err := os.WriteFile(dir+"/inblob", rd, 0); err != nil {
		return nil, nil, err
	}
	rep, err := os.ReadFile(dir + "/outblob")
	if err != nil {
		return nil, nil, err
	}
	certs, _ := os.ReadFile(dir + "/auxblob")
	return rep, certs, nil
}

// monotonic time since boot, the clock dominit's boot_ms uses
func monoMs() float64 {
	var ts syscall.Timespec
	syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1 /* CLOCK_MONOTONIC */, uintptr(unsafe.Pointer(&ts)), 0)
	return float64(ts.Sec)*1e3 + float64(ts.Nsec)/1e6
}

func must(err error) {
	if err != nil {
		die("%v", err)
	}
}

func die(f string, a ...any) {
	fmt.Printf("DOM ERROR front: "+f+"\n", a...)
	os.Exit(1)
}
