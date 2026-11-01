package rpcbootstrap

import (
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

func fixture(t *testing.T, left time.Duration) *Identity {
	t.Helper()
	now, e := rpcservice.MonotonicNow()
	if e != nil || now < uint64(rpcservice.StartupWindow) {
		t.Fatal("fixture monotonic clock", e)
	}
	req := contract.RPCStorageRequest{AppID: strings.Repeat("a", 64), BaseVolume: strings.Repeat("b", 64), L1Volume: strings.Repeat("c", 64), Profile: strings.Repeat("d", 64), Nonce: strings.Repeat("e", 64), Deployment: "0x" + strings.Repeat("f", 64), Boot: "11111111-2222-3333-4444-555555555555", Origin: now - uint64(rpcservice.StartupWindow) + uint64(left), Schema: contract.RPCStorageRequestSchema}
	req.Deadline = req.Origin + uint64(rpcservice.StartupWindow)
	rt := contract.RuntimeIdentity{Name: "wasmtime", Version: "49.0.3", Execution: contract.ExecJIT, TargetISA: contract.ISAx86_64, HostISA: contract.ISAx86_64, CPUFeatures: "baseline", WX: contract.WXEnforced, Cache: contract.CacheNone}
	i, e := New(req, rt)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(i.Close)
	return i
}
func report(t *testing.T, i *Identity) Evidence {
	t.Helper()
	p, e := i.Public()
	if e != nil {
		t.Fatal(e)
	}
	v, e := i.Attest(p.Request.Boot, p.RequestSHA256, bytes.Repeat([]byte{7}, 32), func(rd []byte) ([]byte, error) {
		if len(rd) != 64 {
			t.Fatal("report size")
		}
		return []byte("synthetic-not-hardware"), nil
	})
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestBootstrapKeyRemainsGuestOwned(t *testing.T) {
	i := fixture(t, 5*time.Second)
	p, _ := i.Public()
	if _, e := i.TakeCredential(); e == nil {
		t.Fatal("credential before report")
	}
	cert, e := x509.ParseCertificate(p.Certificate)
	if e != nil || cert.IsCA {
		t.Fatal("certificate", e)
	}
	p.Certificate[0] ^= 1
	p.TransportKey[0] ^= 1
	evi := report(t, i)
	credential, e := i.TakeCredential()
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Equal(credential.Certificate[0], evi.Certificate) {
		t.Fatal("different credential")
	}
	if _, e = i.TakeCredential(); e == nil {
		t.Fatal("second handoff")
	}
	// Actual in-process TLS handshake proves possession of the generated key.
	// Server trust is deliberately local-fixture-only; not a production owner.
	other := fixture(t, 5*time.Second)
	report(t, other)
	serverCert, _ := other.TakeCredential()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	a.SetDeadline(time.Now().Add(time.Second))
	b.SetDeadline(time.Now().Add(time.Second))
	server := tls.Server(a, &tls.Config{Certificates: []tls.Certificate{serverCert}, ClientAuth: tls.RequireAnyClientCert, MinVersion: tls.VersionTLS13})
	client := tls.Client(b, &tls.Config{Certificates: []tls.Certificate{credential}, InsecureSkipVerify: true, MinVersion: tls.VersionTLS13})
	done := make(chan error, 1)
	go func() { done <- server.Handshake() }()
	if e = client.Handshake(); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	peer := server.ConnectionState().PeerCertificates
	if len(peer) != 1 || !bytes.Equal(peer[0].Raw, evi.Certificate) {
		t.Fatal("TLS did not use attested certificate")
	}
	raw, _ := json.Marshal(evi)
	if bytes.Contains(raw, []byte("PRIVATE")) || bytes.Contains(raw, []byte("PrivateKey")) {
		t.Fatal("wire key exposure")
	}
}
func TestBootstrapReportIsOneShotAndPurposeBound(t *testing.T) {
	i := fixture(t, 5*time.Second)
	p, _ := i.Public()
	nonce := bytes.Repeat([]byte{7}, 32)
	if e := i.Acquire(p.Request.Boot, p.RequestSHA256); e == nil {
		t.Fatal("unreported acquisition")
	}
	var rd []byte
	evidence, e := i.Attest(p.Request.Boot, p.RequestSHA256, nonce, func(b []byte) ([]byte, error) {
		rd = append([]byte(nil), b...)
		return []byte("synthetic-not-hardware"), nil
	})
	if e != nil {
		t.Fatal(e)
	}
	rid, _ := contract.RuntimeID(p.Runtime)
	ordinary, _ := contract.Bind2(p.TransportKey, nonce, rid)
	if bytes.Equal(rd[:32], ordinary[:]) || hex.EncodeToString(rd[32:]) != p.Request.AppID {
		t.Fatal("wrong report purpose or app")
	}
	if _, e = i.Attest(p.Request.Boot, p.RequestSHA256, nonce, func([]byte) ([]byte, error) { t.Fatal("replayed hardware call"); return nil, nil }); e == nil {
		t.Fatal("replayed report")
	}
	if e = i.Acquire(p.Request.Boot, p.RequestSHA256); e != nil {
		t.Fatal(e)
	}
	if e = i.Wait(); e != nil {
		t.Fatal(e)
	}
	if e = i.Acquire(p.Request.Boot, p.RequestSHA256); e == nil {
		t.Fatal("replayed acquire")
	}
	if dir := os.Getenv("RPC_BOOTSTRAP_VECTOR_DIR"); dir != "" {
		// Public interoperability vector only; no private credential is serialized.
		raw, _ := json.Marshal(map[string]any{"evidence": evidence, "reportData": hex.EncodeToString(rd)})
		f, e := os.OpenFile(filepath.Join(dir, "bootstrap-vector.json"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = f.Write(raw); e != nil {
			t.Fatal(e)
		}
		f.Close()
	}
}
func TestBootstrapFailuresNeverOpenGate(t *testing.T) {
	for _, mode := range []string{"wrong-boot", "wrong-request", "zero-challenge", "short-challenge", "nil-reporter", "hardware-failed", "oversized-report"} {
		t.Run(mode, func(t *testing.T) {
			i := fixture(t, 5*time.Second)
			p, _ := i.Public()
			boot, digest := p.Request.Boot, p.RequestSHA256
			nonce := bytes.Repeat([]byte{7}, 32)
			calls := 0
			fn := func([]byte) ([]byte, error) {
				calls++
				if mode == "hardware-failed" {
					return nil, errors.New("TPM refused")
				}
				if mode == "oversized-report" {
					return make([]byte, 9001), nil
				}
				return []byte("fixture"), nil
			}
			switch mode {
			case "wrong-boot":
				boot = "old"
			case "wrong-request":
				digest = strings.Repeat("1", 64)
			case "zero-challenge":
				nonce = make([]byte, 32)
			case "short-challenge":
				nonce = nonce[:31]
			case "nil-reporter":
				fn = nil
			}
			if _, e := i.Attest(boot, digest, nonce, fn); e == nil {
				t.Fatal("accepted", mode)
			}
			if e := i.Acquire(p.Request.Boot, p.RequestSHA256); e == nil {
				t.Fatal("failed report unlocked")
			}
			if mode == "hardware-failed" || mode == "oversized-report" {
				if calls != 1 {
					t.Fatal("hardware call count")
				}
				if _, e := i.Attest(p.Request.Boot, p.RequestSHA256, bytes.Repeat([]byte{7}, 32), fn); e == nil || calls != 1 {
					t.Fatal("failed hardware retried")
				}
			} else if calls != 0 {
				t.Fatal("invalid request reached hardware")
			}
		})
	}
}
func TestBootstrapOriginalDeadlineAndClose(t *testing.T) {
	i := fixture(t, 80*time.Millisecond)
	p, _ := i.Public()
	start := time.Now()
	if e := i.Wait(); e == nil {
		t.Fatal("unreleased gate")
	}
	if time.Since(start) > time.Second {
		t.Fatal("deadline reset")
	}
	if _, e := i.Public(); e == nil {
		t.Fatal("expired public evidence")
	}
	if e := i.Acquire(p.Request.Boot, p.RequestSHA256); e == nil {
		t.Fatal("expired acquire")
	}
	j := fixture(t, 80*time.Millisecond)
	q, _ := j.Public()
	_, e := j.Attest(q.Request.Boot, q.RequestSHA256, bytes.Repeat([]byte{7}, 32), func([]byte) ([]byte, error) { time.Sleep(120 * time.Millisecond); return []byte("late"), nil })
	if e == nil {
		t.Fatal("late hardware result accepted")
	}
	k := fixture(t, 5*time.Second)
	done := make(chan error, 1)
	go func() { done <- k.Wait() }()
	k.Close()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("close unlocked")
		}
	case <-time.After(time.Second):
		t.Fatal("close did not wake")
	}
}
func TestBootstrapBindingChangesForEveryAuthorityInput(t *testing.T) {
	i := fixture(t, 5*time.Second)
	p, _ := i.Public()
	rid, _ := contract.RuntimeID(p.Runtime)
	nonce := bytes.Repeat([]byte{7}, 32)
	original, _ := contract.RPCBootstrapBinding(p.Request, p.TransportKey, p.Certificate, nonce, rid)
	for _, field := range []string{"app", "base", "l1", "profile", "nonce", "deployment", "boot", "clock", "key", "cert", "challenge", "runtime"} {
		r := p.Request
		key := append([]byte(nil), p.TransportKey...)
		cert := append([]byte(nil), p.Certificate...)
		ch := append([]byte(nil), nonce...)
		rt := rid
		changed := strings.Repeat("9", 64)
		switch field {
		case "app":
			r.AppID = changed
		case "base":
			r.BaseVolume = changed
		case "l1":
			r.L1Volume = changed
		case "profile":
			r.Profile = changed
		case "nonce":
			r.Nonce = changed
		case "deployment":
			r.Deployment = "0x" + changed
		case "boot":
			r.Boot = "99999999-2222-3333-4444-555555555555"
		case "clock":
			r.Origin++
			r.Deadline++
		case "key":
			key[0] ^= 1
		case "cert":
			cert[0] ^= 1
		case "challenge":
			ch[0] ^= 1
		case "runtime":
			rt = sha256.Sum256([]byte("another"))
		}
		value, e := contract.RPCBootstrapBinding(r, key, cert, ch, rt)
		if e != nil || value == original {
			t.Fatal(field, e)
		}
	}
}
