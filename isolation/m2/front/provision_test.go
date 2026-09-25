package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/domtls"
	"enclave.host/isolation/m2/release"
)

// ---- a synthetic world: a PSP, a relay, guestd's ticket and egress services, and one internet origin ----

type provCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newProvCA(t *testing.T) *provCA {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "prov root"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	p := x509.NewCertPool()
	p.AddCert(c)
	return &provCA{c, k, p}
}

func (c *provCA) tlsListener(t *testing.T, name string) net.Listener {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.cert, &k.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: k}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	return l
}

// sealTo is the relay's sealRelease (contract v1.1), written from the contract text rather than taken from the
// package under test.
func sealTo(id, ticket [32]byte, sealKey, plaintext []byte) []byte {
	eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	peer, err := ecdh.X25519().NewPublicKey(sealKey)
	if err != nil {
		return nil // the guest's open then fails, which is what a test of a bad seal wants
	}
	shared, _ := eph.ECDH(peer)
	info := append([]byte("enclave-secrets-release-v1 seal\n"), id[:]...)
	info = append(append(info, eph.PublicKey().Bytes()...), sealKey...)
	key, _ := hkdf.Key(sha256.New, shared, ticket[:], string(info), 32)
	blk, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(blk)
	iv := make([]byte, 12)
	rand.Read(iv)
	return append(append(append([]byte{}, eph.PublicKey().Bytes()...), iv...), g.Seal(nil, iv, plaintext, nil)...)
}

type provWorld struct {
	id      [32]byte
	ticket  release.Ticket
	spki    []byte
	rt      *runtimeState
	appSha  []byte
	p       *provisioner
	relayN  atomic.Int32 // requests the relay saw
	ticketN atomic.Int32 // ticket reads
	audited []netip.AddrPort
	checks  []string // what the relay found wrong, if anything

	// the relay's behaviour
	status  int
	config  any
	secrets map[string]string
	sealFor []byte // seal to this key instead of the request's
	mu      sync.Mutex
}

func newProvWorld(t *testing.T) *provWorld {
	w := &provWorld{status: 200}
	w.id = [32]byte{0xa6, 0x9d, 0xbb, 0xa1, 0x11}
	w.ticket = release.Ticket{ID: w.id, Ticket: [32]byte{0x7e, 0x57}}
	_, spki, err := domtls.Mint("enclave-domain")
	if err != nil {
		t.Fatal(err)
	}
	w.spki = spki
	rid := contract.RuntimeIdentity{Name: "wasmtime", Version: "48.0.1", Execution: contract.ExecJIT, TargetISA: "x86_64",
		HostISA: "x86_64", CPUFeatures: "baseline", WX: contract.WXEnforced, Cache: contract.CacheNone}
	r, err := contract.RuntimeID(rid)
	if err != nil {
		t.Fatal(err)
	}
	w.rt = &runtimeState{ID: rid, RID: r}
	sum := sha256.Sum256([]byte("the app bundle"))
	w.appSha = sum[:]
	w.config = map[string]any{"api_key": "$MCP_ADAPTER_API_KEY", "http": []any{map[string]any{"url": "${IMAGE_ENDPOINT}/v1/images"}}}
	w.secrets = map[string]string{"MCP_ADAPTER_API_KEY": "k-1", "IMAGE_ENDPOINT": "https://images.example"}

	ca := newProvCA(t)
	relayL := ca.tlsListener(t, release.RelayHost)
	srv := &http.Server{Handler: http.HandlerFunc(w.relay)}
	go srv.Serve(relayL)
	t.Cleanup(func() { srv.Close() })
	img := ca.tlsListener(t, "images.example")
	go func() {
		for {
			c, err := img.Accept()
			if err != nil {
				return
			}
			go func() { defer c.Close(); io.WriteString(c, "IMG") }()
		}
	}()

	// guestd's two services (TCP stands in for vsock)
	tl, _ := net.Listen("tcp", "127.0.0.1:0")
	t.Cleanup(func() { tl.Close() })
	go func() {
		for {
			c, err := tl.Accept()
			if err != nil {
				return
			}
			w.ticketN.Add(1)
			w.mu.Lock()
			tk := w.ticket
			w.mu.Unlock()
			release.WriteTicket(c, tk)
			c.Close()
		}
	}()
	routes := map[string]string{release.RelayHost: relayL.Addr().String(), "images.example": img.Addr().String()}
	el, _ := net.Listen("tcp", "127.0.0.1:0")
	t.Cleanup(func() { el.Close() })
	go func() {
		for {
			c, err := el.Accept()
			if err != nil {
				return
			}
			go hostEgress(c, routes)
		}
	}()

	pl, _ := net.Listen("tcp", "127.0.0.1:0")
	port := pl.Addr().(*net.TCPAddr).Port
	pl.Close()
	w.p = &provisioner{
		ticket:    func() (net.Conn, error) { return net.Dial("tcp", tl.Addr().String()) },
		egress:    func() (net.Conn, error) { return net.Dial("tcp", el.Addr().String()) },
		report:    w.psp,
		relayHost: release.RelayHost, roots: ca.pool,
		etc: filepath.Join(t.TempDir(), "etc"), fwdPort: port,
		audit: func(want []netip.AddrPort) error { w.audited = want; return nil },
		logf:  t.Logf,
	}
	return w
}

// the PSP: a report whose report_data is what the guest asked for and whose HOST_DATA is what the guest was launched with
func (w *provWorld) psp(rd []byte) ([]byte, []byte, error) {
	rep := make([]byte, 0x4a0)
	copy(rep[0x50:], rd)
	copy(rep[0xc0:], w.id[:])
	return rep, nil, nil
}

// a stand-in for guestd's egress server: the header names the origin; it is dialed by name from a fixed table
func hostEgress(g net.Conn, routes map[string]string) {
	defer g.Close()
	br := bufio.NewReader(g)
	line, err := br.ReadString('\n')
	f := strings.Fields(line)
	if err != nil || len(f) != 3 || f[0] != "egress-v1" || f[2] != "443" || routes[f[1]] == "" {
		io.WriteString(g, "refused\n")
		return
	}
	up, err := net.Dial("tcp", routes[f[1]])
	if err != nil {
		io.WriteString(g, "refused\n")
		return
	}
	defer up.Close()
	io.WriteString(g, "ok\n")
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, br); done <- struct{}{} }()
	go func() { io.Copy(g, up); done <- struct{}{} }()
	<-done
}

// the relay, doing the checks the contract says it does, from the request alone
func (w *provWorld) relay(rw http.ResponseWriter, r *http.Request) {
	w.relayN.Add(1)
	var req struct {
		ID, Ticket, SealKey string
		Evidence            map[string]json.RawMessage
	}
	if json.NewDecoder(r.Body).Decode(&req) != nil || r.URL.Path != "/v1/secrets/release" {
		rw.WriteHeader(422)
		return
	}
	fail := func(what string) { w.mu.Lock(); w.checks = append(w.checks, what); w.mu.Unlock() }
	w.mu.Lock()
	status, config, secrets, sealFor := w.status, w.config, w.secrets, w.sealFor
	w.mu.Unlock()
	id, _ := release.ID(req.ID)
	tk, _ := base64.StdEncoding.DecodeString(req.Ticket)
	sk, _ := base64.StdEncoding.DecodeString(req.SealKey)
	var str = func(k string) string { var s string; json.Unmarshal(req.Evidence[k], &s); return s }
	if _, has := req.Evidence["nonce"]; has {
		fail("nonce")
	}
	if str("format") != contract.FormatSNP || str("abi") != contract.ABI2 {
		fail("format/abi")
	}
	var rid contract.RuntimeIdentity
	json.Unmarshal(req.Evidence["runtime"], &rid)
	runtimeID, err := contract.RuntimeID(rid)
	if err != nil {
		fail("runtime")
	}
	spki, _ := base64.StdEncoding.DecodeString(str("transportKey"))
	rep, _ := base64.StdEncoding.DecodeString(str("report"))
	var ticket [32]byte
	copy(ticket[:], tk)
	want, err := release.Binding(id, spki, ticket, runtimeID, sk)
	if err != nil || len(rep) < 0xe0 || !bytes.Equal(rep[0x50:0x70], want[:]) {
		fail("binding")
	}
	if len(rep) < 0xe0 || !bytes.Equal(rep[0x70:0x90], w.appSha) || !bytes.Equal(rep[0xc0:0xe0], id[:]) {
		fail("appid/hostdata")
	}
	if status != 200 {
		rw.WriteHeader(status)
		io.WriteString(rw, `{"error":"evidence_refused","message":"not for the guest's log"}`)
		return
	}
	plain, _ := json.Marshal(map[string]any{"id": req.ID, "envelopeSha256": strings.Repeat("ab", 32), "config": config,
		"secrets": secrets, "issuedAt": "2026-09-25T20:00:00.000Z"})
	to := sk
	if sealFor != nil {
		to = sealFor
	}
	json.NewEncoder(rw).Encode(map[string]string{"id": req.ID, "sealed": base64.StdEncoding.EncodeToString(sealTo(id, ticket, to, plain))})
}

func (w *provWorld) run(t *testing.T) (*provisioned, error) {
	t.Helper()
	p, err := w.p.run(context.Background(), w.id[:], w.spki, w.rt, w.appSha)
	if p != nil && p.fwd != nil {
		t.Cleanup(p.fwd.Close)
	}
	return p, err
}

// ---- the tests ----

func TestProvisionReleasesTheOwnersConfigAndOpensOnlyItsAllowlist(t *testing.T) {
	w := newProvWorld(t)
	p, err := w.run(t)
	if err != nil {
		t.Fatal(err)
	}
	w.mu.Lock()
	checks := w.checks
	w.mu.Unlock()
	if len(checks) != 0 || w.relayN.Load() != 1 {
		t.Fatalf("the relay's checks failed: %v (requests %d)", checks, w.relayN.Load())
	}
	// ENCLAVE_CONFIG is the standard runtime's substitution of the owner's config
	if want := `{"api_key":"k-1","http":[{"url":"https://images.example/v1/images"}]}`; p.config != want {
		t.Fatalf("config %q, want %q", p.config, want)
	}
	if p.envelope != strings.Repeat("ab", 32) {
		t.Fatalf("envelope %q", p.envelope)
	}
	hosts, _ := os.ReadFile(filepath.Join(w.p.etc, "hosts"))
	ns, _ := os.ReadFile(filepath.Join(w.p.etc, "nsswitch.conf"))
	if string(ns) != "hosts: files\n" || string(hosts) != "127.0.0.1 localhost\n127.64.0.2 api.enclave.host\n127.64.0.3 images.example\n" {
		t.Fatalf("resolver files:\n%s\n%s", ns, hosts)
	}
	if len(w.audited) != 2 {
		t.Fatalf("the audit was asked for %v", w.audited)
	}
	// the tenant reaches the allowed origin through its forwarder, TLS end to end
	a, ok := p.fwd.Addr("images.example")
	if !ok {
		t.Fatal("no forwarder for images.example")
	}
	c, err := net.DialTimeout("tcp", a.String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(5 * time.Second))
	tc := tls.Client(c, &tls.Config{ServerName: "images.example", RootCAs: w.p.roots})
	if b, err := io.ReadAll(tc); err != nil || string(b) != "IMG" {
		t.Fatalf("the tenant's request: %q %v", b, err)
	}
	if _, ok := p.fwd.Addr("evil.example"); ok {
		t.Fatal("an origin outside the owner's config has a forwarder")
	}
}

// HOST_DATA == id: a ticket issued for another deployment stops in the guest, before the relay burns it
func TestATicketForAnotherDeploymentStopsBeforeTheRelay(t *testing.T) {
	w := newProvWorld(t)
	w.mu.Lock()
	w.ticket.ID[0] ^= 0xff
	w.mu.Unlock()
	_, err := w.run(t)
	if err == nil || !strings.Contains(err.Error(), "refused before the relay sees it") || w.relayN.Load() != 0 {
		t.Fatalf("err %v, relay requests %d", err, w.relayN.Load())
	}
}

func TestProvisionNeedsADeploymentAndARuntimeIdentity(t *testing.T) {
	w := newProvWorld(t)
	if _, err := w.p.run(context.Background(), make([]byte, 32), w.spki, w.rt, w.appSha); err == nil {
		t.Fatal("an all-zero HOST_DATA was provisioned")
	}
	if _, err := w.p.run(context.Background(), w.id[:], w.spki, nil, w.appSha); err == nil {
		t.Fatal("an ABI/1 image (no runtime identity) was provisioned")
	}
	if w.ticketN.Load() != 0 || w.relayN.Load() != 0 {
		t.Fatalf("a refused provision still asked for a ticket (%d) or the relay (%d)", w.ticketN.Load(), w.relayN.Load())
	}
}

// nothing starts, and nothing is written, on any failure after the ticket
func TestAFailedReleaseStartsNothing(t *testing.T) {
	other, _ := release.NewSealKey()
	for what, set := range map[string]func(*provWorld){
		"the relay refuses":                  func(w *provWorld) { w.status = 403 },
		"a reply sealed to another key":      func(w *provWorld) { w.sealFor = other.Public() },
		"a config that is a JSON string":     func(w *provWorld) { w.config = `{"a":1}` },
		"a config over the env ceiling":      func(w *provWorld) { w.config = map[string]any{"x": strings.Repeat("y", 70*1024)} },
		"a placeholder value over the limit": func(w *provWorld) { w.secrets["IMAGE_ENDPOINT"] = strings.Repeat("z", 5000) },
	} {
		w := newProvWorld(t)
		w.mu.Lock()
		set(w)
		w.mu.Unlock()
		p, err := w.run(t)
		if err == nil {
			t.Fatalf("%s: provisioned", what)
		}
		if strings.Contains(err.Error(), "not for the guest's log") || strings.Contains(err.Error(), "k-1") {
			t.Fatalf("%s: the error carries the relay's message or a secret: %v", what, err)
		}
		if p != nil {
			t.Fatalf("%s: a partial provision was returned", what)
		}
		if _, err := os.Stat(filepath.Join(w.p.etc, "hosts")); !os.IsNotExist(err) {
			t.Fatalf("%s: /etc/hosts was written", what)
		}
	}
}

func TestAFailedListenerAuditClosesTheForwarders(t *testing.T) {
	w := newProvWorld(t)
	var seen []netip.AddrPort
	w.p.audit = func(want []netip.AddrPort) error { seen = want; return errors.New("listener audit: a stray listener") }
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "stray") {
		t.Fatalf("%v", err)
	}
	for _, a := range seen {
		if c, err := net.DialTimeout("tcp", a.String(), time.Second); err == nil {
			c.Close()
			t.Fatalf("forwarder %s still listens after the audit failed", a)
		}
	}
}

// ---- the audit itself, on /proc/net tables ----

func writeTables(t *testing.T, tables map[string]string) string {
	d := t.TempDir()
	hdr := "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
	for name, rows := range tables {
		os.WriteFile(filepath.Join(d, name), []byte(hdr+rows), 0o644)
	}
	return d
}

func TestTheListenerAuditRequiresExactlyTheForwarders(t *testing.T) {
	fwd := []netip.AddrPort{netip.MustParseAddrPort("127.64.0.2:443"), netip.MustParseAddrPort("127.64.0.3:443")}
	listen2 := "   0: 0200407F:01BB 00000000:0000 0A 0 0 0 0 0 0 1\n   1: 0300407F:01BB 00000000:0000 0A 0 0 0 0 0 0 2\n"
	established := "   2: 0200407F:01BB 0100007F:D431 01 0 0 0 0 0 0 3\n" // a connection, not a listener
	if err := auditListeners(writeTables(t, map[string]string{"tcp": listen2 + established, "tcp6": "", "udp": "", "udp6": ""}), fwd); err != nil {
		t.Fatal(err)
	}
	for what, tables := range map[string]map[string]string{
		"an extra loopback listener":  {"tcp": listen2 + "   3: 0100007F:1F90 00000000:0000 0A 0 0 0 0 0 0 4\n"},
		"a listener on every address": {"tcp": listen2, "tcp6": "   0: 00000000000000000000000000000000:1F91 00000000000000000000000000000000:0000 0A 0 0 0 0 0 0 5\n"},
		"a missing forwarder":         {"tcp": "   0: 0200407F:01BB 00000000:0000 0A 0 0 0 0 0 0 1\n"},
		"a bound UDP socket":          {"tcp": listen2, "udp": "   0: 0100007F:0035 00000000:0000 07 0 0 0 0 0 0 6\n"},
	} {
		if err := auditListeners(writeTables(t, tables), fwd); err == nil {
			t.Fatalf("%s: passed the audit", what)
		}
	}
}

func TestProcAddr(t *testing.T) {
	for in, want := range map[string]string{
		"0100007F:1F90":                         "127.0.0.1:8080",
		"0200407F:01BB":                         "127.64.0.2:443",
		"0000000000000000FFFF00000100007F:01BB": "127.0.0.1:443", // v4-mapped: judged as the IPv4 address
		"00000000000000000000000001000000:0050": "[::1]:80",
	} {
		a, err := procAddr(in)
		if err != nil || a.String() != want {
			t.Fatalf("%s: %v %v, want %s", in, a, err, want)
		}
	}
}

func TestHandToInit(t *testing.T) {
	for config, want := range map[string]string{"": "N", `{"a":"k"}`: `C{"a":"k"}`} {
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := handToInit(w, config); err != nil {
			t.Fatal(err)
		}
		got, _ := io.ReadAll(r) // EOF: handToInit closed its end
		r.Close()
		if string(got) != want {
			t.Fatalf("%q: init read %q", config, got)
		}
	}
}
