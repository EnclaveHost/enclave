package release

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
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
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestTheRelayRootsArePinned(t *testing.T) {
	var got []string
	for _, p := range embeddedRoots {
		b, rest := pem.Decode(p)
		if b == nil || len(bytes.TrimSpace(rest)) != 0 {
			t.Fatal("an embedded root is not exactly one PEM certificate")
		}
		sum := sha256.Sum256(b.Bytes)
		got = append(got, hex.EncodeToString(sum[:]))
	}
	if strings.Join(got, ",") != strings.Join(RootFingerprints, ",") {
		t.Fatalf("embedded roots %v, pinned %v", got, RootFingerprints)
	}
	if _, err := RelayRoots(); err != nil {
		t.Fatal(err)
	}
	if RelayHost != "api.enclave.host" {
		t.Fatalf("the relay origin moved: %s", RelayHost)
	}
}

// The pinned set covers both issuers AS SERVED: the Let's Encrypt chain api.enclave.host presented and the ZeroSSL
// chain a *.app.enclave.host presented on 2026-09-25 (public certificates, captured with openssl s_client) each build
// to a pinned root. Chain building is checked at a time inside the certificates' validity, and names are not.
func TestThePinnedRootsCoverBothIssuersAsServed(t *testing.T) {
	roots, err := RelayRoots()
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"chain-letsencrypt-api.enclave.host-20260925.pem", "chain-zerossl-4e62e60d.app.enclave.host-20260925.pem"} {
		raw, err := os.ReadFile(filepath.Join("testdata", f))
		if err != nil {
			t.Fatal(err)
		}
		var certs []*x509.Certificate
		for b, rest := pem.Decode(raw); b != nil; b, rest = pem.Decode(rest) {
			c, err := x509.ParseCertificate(b.Bytes)
			if err != nil {
				t.Fatal(err)
			}
			certs = append(certs, c)
		}
		if len(certs) < 2 {
			t.Fatalf("%s: %d certificates", f, len(certs))
		}
		inter := x509.NewCertPool()
		for _, c := range certs[1:] {
			inter.AddCert(c)
		}
		at := certs[0].NotBefore.Add(24 * time.Hour)
		if _, err := certs[0].Verify(x509.VerifyOptions{Roots: roots, Intermediates: inter, CurrentTime: at}); err != nil {
			t.Fatalf("%s does not build to a pinned root: %v", f, err)
		}
		// and it does NOT build without the pinned set (the system pool is not what is being tested)
		if _, err := certs[0].Verify(x509.VerifyOptions{Roots: x509.NewCertPool(), Intermediates: inter, CurrentTime: at}); err == nil {
			t.Fatalf("%s built to an empty root pool", f)
		}
	}
}

func TestTheTicketLine(t *testing.T) {
	var tk Ticket
	for i := range tk.ID {
		tk.ID[i], tk.Ticket[i] = byte(i), byte(0xff-i)
	}
	var b bytes.Buffer
	if err := WriteTicket(&b, tk); err != nil {
		t.Fatal(err)
	}
	if got, err := ReadTicket(&b); err != nil || got != tk {
		t.Fatalf("round trip: %v %v", got, err)
	}
	b64 := base64.StdEncoding.EncodeToString(tk.Ticket[:])
	id := "0x" + hex.EncodeToString(tk.ID[:])
	for _, bad := range []string{
		"",                                                        // nothing
		"ticket-v1 " + id + " " + b64,                             // no newline: the host never finished
		"ticket-v2 " + id + " " + b64 + "\n",                      // another protocol
		"ticket-v1 " + id[2:] + " " + b64 + "\n",                  // an id without 0x
		"ticket-v1 0x1234 " + b64 + "\n",                          // a short id
		"ticket-v1 " + id + " AAAA\n",                             // a short ticket
		"ticket-v1 " + id + " " + b64 + " x\n",                    // a fourth field
		"ticket-v1 " + id + " " + strings.Repeat("A", 200) + "\n", // longer than any ticket line
	} {
		if _, err := ReadTicket(strings.NewReader(bad)); err == nil {
			t.Fatalf("%q accepted", bad)
		}
	}
}

type ca struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pool *x509.CertPool
}

func newTestCA(t *testing.T) *ca {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test root"}, IsCA: true,
		BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	p := x509.NewCertPool()
	p.AddCert(c)
	return &ca{c, k, p}
}

func (c *ca) leaf(t *testing.T, name string) tls.Certificate {
	k, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: name}, DNSNames: []string{name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, tpl, c.cert, &k.PublicKey, c.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: k}
}

// a relay on loopback holding `cert`, answering with `h`; returns a client pinned to `roots` and a count of the
// requests the handler actually saw
func testRelay(t *testing.T, cert tls.Certificate, roots *x509.CertPool, h http.HandlerFunc) (*Client, *atomic.Int32) {
	var seen atomic.Int32
	l, err := tls.Listen("tcp", "127.0.0.1:0", &tls.Config{Certificates: []tls.Certificate{cert}})
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { seen.Add(1); h(w, r) }),
		ErrorLog: nil}
	go srv.Serve(l)
	t.Cleanup(func() { srv.Close() })
	addr := l.Addr().String()
	return &Client{Host: RelayHost, Roots: roots, Keys: []ed25519.PublicKey{relayPub}, Timeout: 5 * time.Second,
		Dial: func(ctx context.Context) (net.Conn, error) { return (&net.Dialer{}).DialContext(ctx, "tcp", addr) }}, &seen
}

// the test relay's release key, which the test clients pin
var relayPub, relayPriv, _ = ed25519.GenerateKey(rand.Reader)

// writeSigned answers a release as v1.2 does: {id, sealed, sig, keyId}, signed by `priv` over the digest of
// (id, ticket, the test seal key, sealed)
func writeSigned(w io.Writer, priv ed25519.PrivateKey, id, ticket [32]byte, sealed []byte) {
	d, _ := ResponseDigest(id, ticket, tsk.Public(), sealed)
	json.NewEncoder(w).Encode(map[string]string{"id": "0x" + hex.EncodeToString(id[:]),
		"sealed": base64.StdEncoding.EncodeToString(sealed), "sig": base64.StdEncoding.EncodeToString(ed25519.Sign(priv, d[:])),
		"keyId": KeyID(priv.Public().(ed25519.PublicKey))})
}

var (
	tid     = [32]byte{0xa6, 0x9d, 0xbb, 0xa1}
	tticket = [32]byte{7, 7, 7}
	tsk, _  = NewSealKey()
	tev     = Evidence{Format: "sev-snp-guest-domain-v1", Abi: "enclave-domain-abi/2", Runtime: json.RawMessage(`{"name":"wasmtime"}`),
		TransportKey: "MFkw", Report: "AAAA"}
)

func TestTheClientPresentsTheReleaseAndReturnsTheSealedBlob(t *testing.T) {
	root := newTestCA(t)
	var body map[string]any
	c, _ := testRelay(t, root.leaf(t, RelayHost), root.pool, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/secrets/release" || r.Host != RelayHost {
			http.Error(w, `{"error":"bad_path"}`, 404)
			return
		}
		json.NewDecoder(r.Body).Decode(&body)
		writeSigned(w, relayPriv, tid, tticket, []byte("SEALED"))
	})
	resp, err := c.Release(context.Background(), tid, tticket, tsk, tev)
	if err != nil || string(resp.sealed) != "SEALED" || resp.by != tsk {
		t.Fatalf("%v %v", resp, err)
	}
	if body["id"] != "0x"+hex.EncodeToString(tid[:]) || body["ticket"] != base64.StdEncoding.EncodeToString(tticket[:]) ||
		body["sealKey"] != base64.StdEncoding.EncodeToString(tsk.Public()) {
		t.Fatalf("the request: %v", body)
	}
	ev := body["evidence"].(map[string]any)
	if _, has := ev["nonce"]; has {
		t.Fatal("a release document stated a nonce (the relay 422s it; the ticket is bound in report_data)")
	}
	if ev["format"] != "sev-snp-guest-domain-v1" || ev["abi"] != "enclave-domain-abi/2" || ev["runtime"] == nil {
		t.Fatalf("the evidence: %v", ev)
	}
}

// the reply is authenticated by TLS alone, so a relay the client cannot pin never gets a request
func TestTheClientRefusesARelayItCannotPin(t *testing.T) {
	pinned, other := newTestCA(t), newTestCA(t)
	for what, cert := range map[string]tls.Certificate{
		"a certificate for another name, from the pinned root": pinned.leaf(t, "evil.example"),
		"a certificate for the relay, from another root":       other.leaf(t, RelayHost),
	} {
		c, seen := testRelay(t, cert, pinned.pool, func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"id":"0x00","sealed":""}`)
		})
		_, err := c.Release(context.Background(), tid, tticket, tsk, tev)
		if err == nil || seen.Load() != 0 {
			t.Fatalf("%s: err %v, requests seen %d", what, err, seen.Load())
		}
		if strings.Contains(err.Error(), "evil.example") || strings.Contains(err.Error(), "127.0.0.1") {
			t.Fatalf("%s: the error names the peer: %v", what, err)
		}
	}
	// and the real pool refuses a test root outright
	roots, _ := RelayRoots()
	c, seen := testRelay(t, pinned.leaf(t, RelayHost), roots, func(http.ResponseWriter, *http.Request) {})
	if _, err := c.Release(context.Background(), tid, tticket, tsk, tev); err == nil || seen.Load() != 0 {
		t.Fatalf("the pinned ISRG pool accepted a test root: %v", err)
	}
}

func TestTheClientRefusesEveryReplyButARelease(t *testing.T) {
	root := newTestCA(t)
	idHex := "0x" + hex.EncodeToString(tid[:])
	for what, c := range map[string]struct {
		h    http.HandlerFunc
		want string
	}{
		"a refusal: the code, never the message": {func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(403)
			io.WriteString(w, `{"error":"evidence_refused","message":"chip 5ecret-detail not in the ticket"}`)
		}, "HTTP 403 evidence_refused"},
		"a refusal with an unbounded code": {func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(503)
			io.WriteString(w, `{"error":"Not A Code: 5ecret-detail"}`)
		}, "HTTP 503 unknown"},
		"a redirect is not followed": {func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://5ecret-detail.example/v1/secrets/release", http.StatusTemporaryRedirect)
		}, "HTTP 307"},
		"a release for another deployment": {func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"id":"0x`+strings.Repeat("11", 32)+`","sealed":"U0VBTEVE"}`)
		}, "another deployment"},
		"not JSON": {func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "<html>") }, "not {id, sealed, sig, keyId}"},
		"a sealed blob that is not base64": {func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"id":"`+idHex+`","sealed":"%%%"}`)
		}, "not base64"},
		"a reply larger than any release": {func(w http.ResponseWriter, r *http.Request) {
			w.Write(bytes.Repeat([]byte("A"), MaxSealed+10))
		}, "larger than any release"},
		// v1.2: the reply must be signed by a PINNED key, over THIS request
		"a missing signature": {func(w http.ResponseWriter, r *http.Request) {
			io.WriteString(w, `{"id":"`+idHex+`","sealed":"U0VBTEVE"}`)
		}, "no valid signature"},
		"a signature by an unpinned key": {func(w http.ResponseWriter, r *http.Request) {
			_, other, _ := ed25519.GenerateKey(rand.Reader)
			writeSigned(w, other, tid, tticket, []byte("SEALED"))
		}, "does not verify"},
		"a signature over another ticket": {func(w http.ResponseWriter, r *http.Request) {
			writeSigned(w, relayPriv, tid, [32]byte{0xee}, []byte("SEALED"))
		}, "does not verify"},
	} {
		cl, _ := testRelay(t, root.leaf(t, RelayHost), root.pool, c.h)
		_, err := cl.Release(context.Background(), tid, tticket, tsk, tev)
		if err == nil || !strings.Contains(err.Error(), c.want) || strings.Contains(err.Error(), "5ecret") {
			t.Fatalf("%s: %v (want %q, and nothing of the relay's message)", what, err, c.want)
		}
	}
}

func TestTheClientNeedsItsPins(t *testing.T) {
	roots, _ := RelayRoots()
	var dials atomic.Int32
	dial := func(context.Context) (net.Conn, error) { dials.Add(1); return nil, io.EOF }
	keys := []ed25519.PublicKey{relayPub}
	for _, c := range []*Client{{Host: RelayHost, Roots: roots, Keys: keys}, {Dial: dial, Roots: roots, Keys: keys},
		{Dial: dial, Host: RelayHost, Keys: keys},
		{Dial: dial, Host: RelayHost, Roots: roots}, // no pinned release key: refused BEFORE sending, so no ticket burns
	} {
		if _, err := c.Release(context.Background(), tid, tticket, tsk, tev); err == nil {
			t.Fatalf("%+v released", c)
		}
	}
	if _, err := (&Client{Dial: dial, Host: RelayHost, Roots: roots, Keys: keys}).Release(context.Background(), tid, tticket, nil, tev); err == nil {
		t.Fatal("a release was sent with no seal key")
	}
	if dials.Load() != 0 {
		t.Fatalf("a client missing a pin still dialled the relay %d time(s)", dials.Load())
	}
}
