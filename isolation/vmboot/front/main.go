// The whole-VM front: the attested front of a whole-VM app that serves its own HTTP on the guest's loopback and
// declares protected ports (a desktop's GameStream ports). The contract is rpc/snp/front.py's. One binary serves it
// on every platform a whole VM runs on: where the report comes from is a source (source.go), AMD SEV-SNP on a host
// like metal0, the paravisor's report on an Enclave Shield host, behind the same endpoints.
//
// At start it makes a TLS key that never leaves this process, asks the platform for a report over
// sha256(SubjectPublicKeyInfo) then 32 zero bytes, and serves on -listen (and on -vsock, where the host reaches a
// guest over sockets, not a network):
//
//	GET  /.well-known/enclave-attestation           {report, certificate, reportData, measurement}: the boot document
//	GET  /.well-known/enclave-attestation?nonce=H   a fresh report over sha256(SPKI || nonce), in the source's format
//	GET  /.well-known/enclave-ready                 200 once the front serves
//	GET  /.well-known/enclave-csr                   a certificate request for the app name, signed by the same key
//	POST /.well-known/enclave-cert                  a CA-issued chain for it, installed only if it verifies here
//	GET  /health                                    whether the app's own HTTP port answers
//	GET  /.well-known/enclave-tunnel/{tcp|udp}/N    protected ports (isolation/m2/tunnel), upgrade enclave-port/1
//	everything else                                 the app, at -upstream on the loopback
//
// Two names, one key, as in the RPC front: the local name is served on the boot's self-signed certificate (the host's
// manager pins the attested key and needs no CA); the app name is <first 8 hex of the deployment id>.<zone>, served on the
// chain a public CA issued once it has been delivered and has verified against the roots this image carries. Whoever
// delivers the chain is not trusted and need not be.
//
// What it does not do: authenticate anybody (the app owns sign-in), hold a secret other than its TLS key, or reach
// anything but the loopback.
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"enclave.host/isolation/m2/tunnel"
	"enclave.host/isolation/m2/vsock"
)

const (
	maxChain     = 64 << 10
	freshWaiters = 4 // a platform answers one report at a time; beyond this a caller is told to retry
)

var (
	nonceQuery  = regexp.MustCompile(`^nonce=([0-9a-f]{64})$`)
	rootHashArg = regexp.MustCompile(`(?:^|\s)enclave\.roothash=([0-9a-f]{64})(?:\s|$)`)
)

type front struct {
	key        *ecdsa.PrivateKey
	spki       []byte
	localCert  tls.Certificate
	localPEM   []byte
	bootDoc    []byte
	rootHash   string
	deployment string
	appName    string
	csr        []byte
	src        source
	roots      *x509.CertPool
	now        func() time.Time

	reports sync.Mutex
	waiters chan struct{}

	mu          sync.RWMutex
	appCert     *tls.Certificate
	appNotAfter time.Time
	installing  sync.Mutex

	upstream string
	proxy    http.Handler
	tunnels  *tunnel.Tunnels
}

func newFront(src source, cmdline, localName, zone string, roots *x509.CertPool, now func() time.Time) (*front, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 120))
	if err != nil {
		return nil, err
	}
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: localName}, DNSNames: []string{localName},
		NotBefore: now().Add(-time.Hour), NotAfter: now().AddDate(10, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	spki, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	f := &front{key: key, spki: spki, src: src, roots: roots, now: now, waiters: make(chan struct{}, freshWaiters),
		localCert: tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key},
		localPEM:  pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
	sum := sha256.Sum256(spki)
	reportData := append(sum[:], make([]byte, 32)...)
	rep, err := src.Report(reportData)
	if err != nil {
		return nil, fmt.Errorf("boot report: %w", err)
	}
	f.deployment = src.Deployment(rep) // SEV-SNP: HOST_DATA, signed with the report; Shield: what the launcher named
	if m := rootHashArg.FindStringSubmatch(cmdline); m != nil {
		f.rootHash = m[1] // on the kernel command line, which the launch identity covers
	}
	f.bootDoc, err = json.Marshal(map[string]string{"schema": "enclave-vm-attestation/1", "platform": src.Platform(),
		"report": base64.StdEncoding.EncodeToString(rep), "certificate": string(f.localPEM),
		"reportData": hex.EncodeToString(reportData), "measurement": src.Measurement(rep)})
	if err != nil {
		return nil, err
	}
	// A VM launched for no deployment (a smoke boot) has no app name and asks for no certificate.
	if f.deployment != "" && zone != "" {
		f.appName = f.deployment[:8] + "." + zone
		csr, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: f.appName},
			DNSNames: []string{f.appName}, SignatureAlgorithm: x509.ECDSAWithSHA256}, key)
		if err != nil {
			return nil, err
		}
		f.csr = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: csr})
	}
	return f, nil
}

// fresh is a report made now, binding this key to the caller's nonce. busy is true when too many callers already wait.
func (f *front) fresh(nonceHex string) (doc []byte, busy bool, err error) {
	select {
	case f.waiters <- struct{}{}:
		defer func() { <-f.waiters }()
	default:
		return nil, true, nil
	}
	nonce, _ := hex.DecodeString(nonceHex)
	sum := sha256.Sum256(append(append([]byte{}, f.spki...), nonce...))
	reportData := append(sum[:], make([]byte, 32)...)
	f.reports.Lock()
	rep, err := f.src.Report(reportData)
	f.reports.Unlock()
	if err != nil {
		return nil, false, err
	}
	// hostData is the deployment under the name SEV-SNP verifiers already read; on that platform it is the report's
	// own HOST_DATA field.
	doc, err = json.Marshal(map[string]string{"format": f.src.Format(), "platform": f.src.Platform(), "nonce": nonceHex,
		"transportKey": base64.StdEncoding.EncodeToString(f.spki), "appSha256": f.rootHash,
		"report": base64.StdEncoding.EncodeToString(rep), "measurement": f.src.Measurement(rep), "hostData": f.src.Deployment(rep)})
	return doc, false, err
}

// install serves the app name on this chain if it is this key's, for this name, in date and from a root this image
// trusts. A chain that does not pass changes nothing.
func (f *front) install(body []byte) (time.Time, error) {
	if f.appName == "" {
		return time.Time{}, errors.New("this VM has no app name")
	}
	var ders [][]byte
	for rest := body; ; {
		var b *pem.Block
		b, rest = pem.Decode(rest)
		if b == nil {
			if len(bytes.TrimSpace(rest)) != 0 {
				return time.Time{}, errors.New("the body must be a PEM certificate chain")
			}
			break
		}
		if b.Type != "CERTIFICATE" {
			return time.Time{}, errors.New("the body must be a PEM certificate chain")
		}
		ders = append(ders, b.Bytes)
	}
	if len(ders) < 1 || len(ders) > 6 {
		return time.Time{}, errors.New("the body must be a PEM certificate chain")
	}
	if !f.installing.TryLock() {
		return time.Time{}, errors.New("another chain is being installed")
	}
	defer f.installing.Unlock()
	leaf, err := x509.ParseCertificate(ders[0])
	if err != nil {
		return time.Time{}, errors.New("the chain does not verify for " + f.appName)
	}
	pub, err := x509.MarshalPKIXPublicKey(leaf.PublicKey)
	if err != nil || !bytes.Equal(pub, f.spki) {
		return time.Time{}, errors.New("the certificate is not for this key")
	}
	inter := x509.NewCertPool()
	for _, d := range ders[1:] {
		c, err := x509.ParseCertificate(d)
		if err != nil {
			return time.Time{}, errors.New("the chain does not verify for " + f.appName)
		}
		inter.AddCert(c)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{DNSName: f.appName, Roots: f.roots, Intermediates: inter, CurrentTime: f.now(),
		KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
		return time.Time{}, errors.New("the chain does not verify for " + f.appName)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if !leaf.NotAfter.After(f.appNotAfter) {
		return f.appNotAfter, nil // nothing newer than what is served
	}
	f.appCert, f.appNotAfter = &tls.Certificate{Certificate: ders, PrivateKey: f.key, Leaf: leaf}, leaf.NotAfter
	log.Printf("vmfront: certificate for %s installed, not after %s", f.appName, leaf.NotAfter.UTC().Format(time.RFC3339))
	return leaf.NotAfter, nil
}

func (f *front) certificate(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.appCert != nil && strings.EqualFold(h.ServerName, f.appName) {
		return f.appCert, nil
	}
	return &f.localCert, nil
}

func reply(w http.ResponseWriter, code int, kind string, body []byte) {
	h := w.Header()
	h.Set("content-type", kind)
	h.Set("content-length", strconv.Itoa(len(body)))
	h.Set("access-control-allow-origin", "*") // public and read-only, nothing keyed to a cookie
	h.Set("x-content-type-options", "nosniff")
	w.WriteHeader(code)
	w.Write(body)
}

func replyJSON(w http.ResponseWriter, code int, v any) {
	b, _ := json.Marshal(v)
	reply(w, code, "application/json", b)
}

func (f *front) health() map[string]any {
	c, err := net.DialTimeout("tcp", f.upstream, 2*time.Second)
	if err == nil {
		c.Close()
	}
	return map[string]any{"app": map[string]any{"listening": err == nil}}
}

func (f *front) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if strings.HasPrefix(p, tunnel.Prefix) {
		f.tunnels.ServeHTTP(w, r)
		return
	}
	get := r.Method == http.MethodGet || r.Method == http.MethodHead
	switch {
	case p == "/.well-known/enclave-attestation" && get:
		if r.URL.RawQuery == "" {
			reply(w, 200, "application/json", f.bootDoc)
			return
		}
		m := nonceQuery.FindStringSubmatch(r.URL.RawQuery)
		if m == nil {
			replyJSON(w, 400, map[string]string{"error": "nonce must be 64 lowercase hex characters"})
			return
		}
		doc, busy, err := f.fresh(m[1])
		if busy {
			w.Header().Set("retry-after", "2")
			replyJSON(w, 500, map[string]string{"error": "attestation busy; retry"})
			return
		}
		if err != nil {
			replyJSON(w, 500, map[string]string{"error": "the report request failed"})
			return
		}
		w.Header().Set("cache-control", "no-store")
		reply(w, 200, "application/json", doc)
	case p == "/.well-known/enclave-ready" && get:
		replyJSON(w, 200, map[string]bool{"ready": true})
	case p == "/.well-known/enclave-csr" && get:
		if len(f.csr) == 0 {
			replyJSON(w, 404, map[string]string{"error": "this VM has no app name"})
			return
		}
		w.Header().Set("x-enclave-app-name", f.appName)
		reply(w, 200, "application/pkcs10", f.csr)
	case p == "/.well-known/enclave-cert" && r.Method == http.MethodPost:
		if r.ContentLength <= 0 || r.ContentLength > maxChain {
			replyJSON(w, 413, map[string]string{"error": "unsupported"})
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxChain))
		if err != nil {
			replyJSON(w, 400, map[string]string{"error": "unreadable"})
			return
		}
		notAfter, err := f.install(body)
		if err != nil {
			replyJSON(w, 422, map[string]any{"installed": false, "error": err.Error()})
			return
		}
		replyJSON(w, 200, map[string]any{"installed": true, "notAfter": notAfter.Unix()})
	case strings.HasPrefix(p, "/.well-known/enclave-"):
		replyJSON(w, 404, map[string]string{"error": "not found"}) // the platform's namespace never reaches the app
	case p == "/health" && get:
		replyJSON(w, 200, f.health())
	default:
		f.proxy.ServeHTTP(w, r)
	}
}

func newProxy(upstream string) http.Handler {
	target := &url.URL{Scheme: "http", Host: upstream}
	p := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			// the app sees the caller only as the front; nothing a client sends may claim otherwise
			for _, h := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-Ip"} {
				r.Out.Header.Del(h)
			}
			r.Out.Header.Set("X-Forwarded-Proto", "https")
		},
		FlushInterval: -1, // a desktop's event streams and long polls go out as they come
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			replyJSON(w, 502, map[string]string{"error": "the app is not answering"})
		},
	}
	return p
}

func main() {
	listen := flag.String("listen", ":8443", "TCP address to serve TLS on")
	vsockPort := flag.Uint("vsock", 0, "also serve TLS on this AF_VSOCK port (virtio or Hyper-V sockets); 0 = no")
	report := flag.String("report", "auto", "where reports come from: auto, sev-snp or shield")
	tpm := flag.String("tpm", "/dev/tpm0", "the paravisor's TPM on an Enclave Shield host")
	deploymentFile := flag.String("deployment-file", "/run/enclave/deployment", "Shield: the deployment id the launcher named for this guest; absent = none")
	upstream := flag.String("upstream", "127.0.0.1:8000", "the app's HTTP port on the guest loopback")
	ports := flag.String("ports", "/vm/app.ports", "the measured image's protected ports, one tcp:N or udp:N a line; absent = none")
	localName := flag.String("local-name", "enclave-rpc", "the name the host side asks for; served on the boot certificate")
	zone := flag.String("zone", "app.enclave.host", "the app zone the deployment's name lives in; empty = never ask for a certificate")
	caFile := flag.String("ca-file", "/etc/ssl/certs/ca-certificates.crt", "the roots a delivered chain must lead to")
	tsm := flag.String("tsm", "/sys/kernel/config/tsm/report", "the kernel's report interface")
	flag.Parse()
	log.SetFlags(0)
	_, portText, err := net.SplitHostPort(*upstream)
	httpPort, perr := strconv.Atoi(portText)
	if err != nil || perr != nil {
		log.Fatalf("vmfront: -upstream must be host:port")
	}
	roots := x509.NewCertPool()
	if pemBytes, err := os.ReadFile(*caFile); err != nil || !roots.AppendCertsFromPEM(pemBytes) {
		log.Fatalf("vmfront: no trusted roots in %s", *caFile)
	}
	cmdline, err := os.ReadFile("/proc/cmdline")
	if err != nil {
		log.Fatalf("vmfront: %v", err)
	}
	src, err := pickSource(*report, *tsm, *tpm, *deploymentFile)
	if err != nil {
		log.Fatalf("vmfront: %v", err)
	}
	f, err := newFront(src, string(cmdline), *localName, *zone, roots, time.Now)
	if err != nil {
		log.Fatalf("vmfront: %v", err)
	}
	if f.tunnels, err = tunnel.Load(*ports, httpPort); err != nil {
		log.Fatalf("vmfront: %v", err)
	}
	f.upstream, f.proxy = *upstream, newProxy(*upstream)
	srv := &http.Server{Handler: f, ReadHeaderTimeout: 30 * time.Second, ErrorLog: log.New(io.Discard, "", 0),
		// HTTP/1.1 only: a tunnel is an HTTP/1.1 upgrade
		TLSConfig:    &tls.Config{MinVersion: tls.VersionTLS12, GetCertificate: f.certificate, NextProtos: []string{"http/1.1"}},
		TLSNextProto: map[string]func(*http.Server, *tls.Conn, http.Handler){}}
	l, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatalf("vmfront: %v", err)
	}
	log.Printf("vmfront: %s, serving %s, app name %q, root %s", src.Platform(), *listen, f.appName, f.rootHash)
	if *vsockPort != 0 {
		// The same image runs where the host reaches the guest over a network (QEMU's forward) and where it has only
		// sockets (Hyper-V). A boot without the socket family serves TCP alone and says so.
		if vl, err := vsock.Listen(uint32(*vsockPort)); err != nil {
			log.Printf("vmfront: no vsock listener: %v", err)
		} else {
			log.Printf("vmfront: serving vsock port %d", *vsockPort)
			go func() { log.Fatalf("vmfront: %v", srv.ServeTLS(vl, "", "")) }()
		}
	}
	log.Fatalf("vmfront: %v", srv.ServeTLS(l, "", ""))
}
