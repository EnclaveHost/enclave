package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/custody"
	"enclave.host/isolation/m2/release"
)

// ---- loadedAppID: the AppID comes from the bytes init runs ----

func TestLoadedAppIDIsTakenFromTheLoadedCode(t *testing.T) {
	dir := t.TempDir()
	wasm := []byte("\x00asm\x01\x00\x00\x00 the component")
	b, err := contract.Build(contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}, wasm)
	if err != nil {
		t.Fatal(err)
	}
	want := contract.AppID(b)
	put := func(name string, data []byte) string {
		p := filepath.Join(dir, name)
		os.WriteFile(p, data, 0o644)
		return p
	}
	bundle, wasmP := put("app.bundle", b), put("app.wasm", wasm)
	stated := put("app.sha256", []byte(hex.EncodeToString(want[:])+"\n"))
	id, how, err := loadedAppID(bundle, wasmP, stated)
	if err != nil || !bytes.Equal(id, want[:]) || !strings.Contains(how, "bundle") {
		t.Fatalf("bundle path: %x %q %v", id, how, err)
	}
	// /app.wasm differs from the bundle's artifact: the identity would not cover what runs
	other := put("other.wasm", []byte("\x00asm\x01\x00\x00\x00 another component"))
	if _, _, err := loadedAppID(bundle, other, stated); err == nil || !strings.Contains(err.Error(), "not the artifact") {
		t.Fatalf("a mismatched component was accepted: %v", err)
	}
	// the build's statement disagrees with the loaded code
	lie := put("lie.sha256", []byte(strings.Repeat("ab", 32)))
	if _, _, err := loadedAppID(bundle, wasmP, lie); err == nil || !strings.Contains(err.Error(), "broken image") {
		t.Fatalf("a lying app.sha256 was accepted: %v", err)
	}
	// a tampered bundle (artifact hash no longer matches) is refused by contract.Parse
	bad := append([]byte(nil), b...)
	bad[len(bad)-1] ^= 1
	if _, _, err := loadedAppID(put("bad.bundle", bad), wasmP, filepath.Join(dir, "none")); err == nil {
		t.Fatal("a tampered bundle was accepted")
	}
	// no bundle: the bare-artifact identity, from the same bytes
	id, _, err = loadedAppID(filepath.Join(dir, "absent.bundle"), wasmP, filepath.Join(dir, "none"))
	if sum := sha256.Sum256(wasm); err != nil || !bytes.Equal(id, sum[:]) {
		t.Fatalf("bare path: %v", err)
	}
}

// ---- the custody step in provisioning ----

type custodyWorld struct {
	*provWorld
	members []*ecdh.PrivateKey
	ys      []*big.Int
	down    map[int]bool
	seen    atomic.Int32 // custodian release requests whose evidence matched what a custodian checks
	authN   atomic.Int32
	st      custody.State
}

var secpOrder, _ = new(big.Int).SetString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

func newCustodyWorld(t *testing.T, env map[string]string) *custodyWorld {
	w := &custodyWorld{provWorld: newProvWorld(t), down: map[int]bool{}}
	w.secrets = map[string]string{} // a custody deployment's relay release carries no values
	w.p.appFromCode = true
	// the owner's bundle: s split 3-of-5 over the secp256k1 order, the env sealed under the data key
	rnd := func() *big.Int {
		b := make([]byte, 32)
		rand.Read(b)
		return new(big.Int).Mod(new(big.Int).SetBytes(b), secpOrder)
	}
	s, a1, a2 := rnd(), rnd(), rnd()
	ctx := custody.Context{ChainID: 8453}
	copy(ctx.Vault[:], bytes.Repeat([]byte{0x5e}, 20))
	c0 := append([]byte{0x02}, bytes.Repeat([]byte{0xc0}, 32)...) // opaque here: only the AAD uses it
	dek, _ := custody.DeriveDEK(s, ctx, w.id, 4)
	aad, _ := custody.BundleAAD(ctx, w.id, 4, c0)
	blk, _ := aes.NewCipher(dek)
	g, _ := cipher.NewGCM(blk)
	nonce := make([]byte, 12)
	rand.Read(nonce)
	// the owner commits the config its values may go into: exactly the text the relay delivers (its JSON value)
	cfgText, _ := json.Marshal(w.config)
	cfgSum := sha256.Sum256(cfgText)
	pt, _ := json.Marshal(map[string]any{"v": 1, "env": env, "configSha256": hex.EncodeToString(cfgSum[:])})
	ct := append(nonce, g.Seal(nil, nonce, pt, aad)...)
	w.st = custody.State{Ctx: ctx, ID: w.id, PolicyRev: 9, SecretRev: 4, Epoch: 1, Threshold: 3, C0: c0, Ciphertext: ct}
	var members []release.CustodyMember
	for i := 0; i < 5; i++ {
		k, _ := custody.NewRecipientKey()
		w.members = append(w.members, k)
		x := big.NewInt(int64(i + 1))
		y := new(big.Int).Add(s, new(big.Int).Mul(a1, x))
		y.Add(y, new(big.Int).Mul(a2, new(big.Int).Mul(x, x)))
		w.ys = append(w.ys, y.Mod(y, secpOrder))
		name := fmt.Sprintf("custodian-%d.example", i)
		l := w.ca.tlsListener(t, name)
		srv := &http.Server{Handler: w.custodian(i)}
		go srv.Serve(l)
		t.Cleanup(func() { srv.Close() })
		w.routes[name] = l.Addr().String()
		members = append(members, release.CustodyMember{EncKey: hex.EncodeToString(k.PublicKey().Bytes()), Endpoint: "https://" + name})
	}
	w.custody = release.Custody{ChainID: 8453, Vault: "0x" + strings.Repeat("5e", 20), PolicyRev: "9", SecretRev: "4", Epoch: 1, Threshold: 3,
		Members: members, C0: hex.EncodeToString(c0), Ciphertext: base64.StdEncoding.EncodeToString(ct)}
	// guestd's custody-auth service (TCP stands in for vsock): the lease holder's operator signs
	al, _ := net.Listen("tcp", "127.0.0.1:0")
	t.Cleanup(func() { al.Close() })
	go func() {
		for {
			c, err := al.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				id, _, err := release.ReadAuthRequest(c)
				if err != nil || id != w.id {
					return
				}
				w.authN.Add(1)
				release.WriteAuth(c, release.CustodyAuth{Endpoint: "https://api.enclave.host/t/host-a", Sig: "0x" + strings.Repeat("5a", 65), Expiry: 1800000000})
			}()
		}
	}()
	w.p.custodyAuth = func() (net.Conn, error) { return net.Dial("tcp", al.Addr().String()) }
	return w
}

// a custodian that checks what custody/custodian.mjs checks about the guest's composition: the binding over the request's
// own fields, report_data = binding ‖ the loaded code's AppID, HOST_DATA = the deployment, the operator's authorization
func (w *custodyWorld) custodian(i int) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if w.down[i] {
			rw.WriteHeader(503)
			return
		}
		enc := hex.EncodeToString(w.members[i].PublicKey().Bytes())
		if r.URL.Path == "/v1/custody/challenge" {
			n := sha256.Sum256([]byte(fmt.Sprint("nonce-", i)))
			json.NewEncoder(rw).Encode(map[string]string{"encKey": enc, "nonce": hex.EncodeToString(n[:])})
			return
		}
		var req struct {
			ID, Endpoint, PolicyRev, SecretRev, RecipientKey string
			Epoch                                            uint32
			Challenges                                       []struct{ EncKey, Nonce string }
			Evidence                                         struct {
				Format, Abi, TransportKey, Report string
				Runtime                           json.RawMessage
			}
			Operator struct {
				Sig    string
				Expiry int64
			}
		}
		b, _ := io.ReadAll(r.Body)
		if json.Unmarshal(b, &req) != nil {
			rw.WriteHeader(422)
			return
		}
		var chs []custody.Challenge
		for _, c := range req.Challenges {
			var ch custody.Challenge
			k, _ := hex.DecodeString(c.EncKey)
			n, _ := hex.DecodeString(c.Nonce)
			copy(ch.EncKey[:], k)
			copy(ch.Nonce[:], n)
			chs = append(chs, ch)
		}
		var rid contract.RuntimeIdentity
		json.Unmarshal(req.Evidence.Runtime, &rid)
		runtimeID, _ := contract.RuntimeID(rid)
		spki, _ := base64.StdEncoding.DecodeString(req.Evidence.TransportKey)
		rk, _ := hex.DecodeString(req.RecipientKey)
		var rk32 [32]byte
		copy(rk32[:], rk)
		bind, err := custody.Binding(custody.BindingInput{Ctx: w.st.Ctx, ID: w.id, PolicyRev: 9, SecretRev: 4, Epoch: 1, Challenges: chs,
			RuntimeID: runtimeID, TransportSPKI: spki, RecipientKey: rk32})
		rep, _ := base64.StdEncoding.DecodeString(req.Evidence.Report)
		if err != nil || len(rep) < 0xe0 || !bytes.Equal(rep[0x50:0x70], bind[:]) || !bytes.Equal(rep[0x70:0x90], w.appSha) ||
			!bytes.Equal(rep[0xc0:0xe0], w.id[:]) || req.Evidence.Format != contract.FormatSNP || req.Evidence.Abi != contract.ABI2 ||
			req.Endpoint != "https://api.enclave.host/t/host-a" || req.Operator.Sig != "0x"+strings.Repeat("5a", 65) {
			rw.WriteHeader(403)
			io.WriteString(rw, `{"error":"evidence_refused","message":"composition"}`)
			return
		}
		w.seen.Add(1)
		pk, _ := ecdh.X25519().NewPublicKey(rk)
		var ek [32]byte
		copy(ek[:], w.members[i].PublicKey().Bytes())
		aad := sha256.Sum256(append(append(append([]byte("enclave-custody-v1 response\n"), bind[:]...), ek[:]...), byte(i)))
		yb := make([]byte, 32)
		w.ys[i].FillBytes(yb)
		sealed, err := custody.Seal(pk, []byte("enclave-custody-v1 share-release"), aad[:], yb, nil)
		if err != nil {
			rw.WriteHeader(500)
			return
		}
		json.NewEncoder(rw).Encode(map[string]any{"v": 1, "encKey": enc, "index": i, "sealed": base64.StdEncoding.EncodeToString(sealed)})
	})
}

func TestProvisionTakesCustodySecretsFromAThresholdOfCustodians(t *testing.T) {
	w := newCustodyWorld(t, map[string]string{"MCP_ADAPTER_API_KEY": "custody-k", "IMAGE_ENDPOINT": "https://images.example"})
	w.down[1], w.down[3] = true, true // two of five down: three suffice
	p, err := w.run(t)
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"api_key":"custody-k","http":[{"url":"https://images.example/v1/images"}]}`; p.config != want {
		t.Fatalf("config %q, want %q", p.config, want)
	}
	if w.seen.Load() != 3 || w.authN.Load() != 1 {
		t.Fatalf("custodians judged %d requests, the host authorized %d", w.seen.Load(), w.authN.Load())
	}
	// the allowlist is derived from the config resolved WITH the custody values: images.example, named only through
	// ${IMAGE_ENDPOINT}, is allowed
	if _, ok := p.fwd.Addr("images.example"); !ok {
		t.Fatalf("the origin named through a custody placeholder is not allowed: %+v", p.fwd.Policy.Origins)
	}
}

// review H2: the relay delivers a config other than the one the owner committed (sending the key to its own URL): the
// values are refused, never substituted
func TestProvisionCustodyRefusesAConfigTheOwnerDidNotCommit(t *testing.T) {
	w := newCustodyWorld(t, map[string]string{"MCP_ADAPTER_API_KEY": "custody-k", "IMAGE_ENDPOINT": "https://images.example"})
	w.config = map[string]any{"api_key": "$MCP_ADAPTER_API_KEY", "http": []any{map[string]any{"url": "https://evil.example/collect"}}}
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "not the one the owner committed") {
		t.Fatalf("a relay-chosen config was accepted: %v", err)
	}
}

func TestProvisionCustodyFailsClosed(t *testing.T) {
	env := map[string]string{"MCP_ADAPTER_API_KEY": "custody-k", "IMAGE_ENDPOINT": "https://images.example"}
	// three of five down: no quorum, no app
	w := newCustodyWorld(t, env)
	w.down[0], w.down[2], w.down[4] = true, true, true
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "quorum") {
		t.Fatalf("no quorum: %v", err)
	}
	// a release that names custody AND carries relay-held values is refused before any custodian is asked
	w = newCustodyWorld(t, env)
	w.secrets = map[string]string{"MCP_ADAPTER_API_KEY": "relay-held"}
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "relay-held secrets") || w.seen.Load() != 0 {
		t.Fatalf("custody + relay values: %v", err)
	}
	// an image whose AppID was not derived from its loaded code
	w = newCustodyWorld(t, env)
	w.p.appFromCode = false
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "loaded code") {
		t.Fatalf("stated AppID: %v", err)
	}
	// a custodian endpoint that is not an https origin on 443 never parses
	w = newCustodyWorld(t, env)
	c := w.custody.(release.Custody)
	c.Members[0].Endpoint = "http://custodian-0.example:8080"
	w.custody = c
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "endpoint") {
		t.Fatalf("bad endpoint: %v", err)
	}
	// the host's authorization service is gone
	w = newCustodyWorld(t, env)
	w.p.custodyAuth = func() (net.Conn, error) { return nil, io.ErrClosedPipe }
	if _, err := w.run(t); err == nil || !strings.Contains(err.Error(), "authorization") {
		t.Fatalf("no authorization: %v", err)
	}
}
