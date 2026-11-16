package capacity

import (
	stdecdsa "crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// testdata/vectors.json is what network/proof-of-capacity-host.mjs, network/proof-of-capacity.mjs and viem compute
// (vectors.mjs writes it; test/proof-of-capacity-partition.test.mjs refuses a stale file).
type vectorFile struct {
	Domain struct {
		ChainID  uint64 `json:"chainId"`
		Contract string
	}
	Address string
	Work    []struct {
		Seed                     string
		Rounds, MemoryMiB, Lanes int
		Digest                   string
	}
	WorkSeed struct{ Seed, Nonce, Out string }
	Messages []struct {
		PrimaryType string
		Values      map[string]string
		Digest      string
		Signature   *string
	}
	Answer struct {
		Challenge struct {
			Epoch                        uint64
			Checker, Target, Seed, Nonce string
			Rounds, MemoryMiB, Lanes     int
		}
		Digest, Signature string
	}
}

func load(t *testing.T) (vectorFile, Domain, *Key) {
	t.Helper()
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	d := Domain{ChainID: v.Domain.ChainID}
	copy(d.Contract[:], unhex(t, v.Domain.Contract))
	seed := sha256.Sum256([]byte("enclave host capacity test key")) // the key no file states (vectors.mjs TEST_KEY)
	return v, d, KeyFromBytes(seed[:])
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(strings.TrimPrefix(s, "0x"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func b32(t *testing.T, s string) (out [32]byte) { copy(out[:], unhex(t, s)); return }
func hx(b []byte) string                        { return "0x" + hex.EncodeToString(b) }

func TestWorkIsTheHostsWork(t *testing.T) {
	v, _, _ := load(t)
	for _, w := range v.Work {
		got, err := Lanes(b32(t, w.Seed), w.Rounds, w.MemoryMiB, w.Lanes)
		if err != nil || hx(got[:]) != w.Digest {
			t.Fatalf("rounds %d, %d MiB, %d lanes: %s (%v), the host's code gives %s", w.Rounds, w.MemoryMiB, w.Lanes, hx(got[:]), err, w.Digest)
		}
	}
	if got := WorkSeed(b32(t, v.WorkSeed.Seed), b32(t, v.WorkSeed.Nonce)); hx(got[:]) != v.WorkSeed.Out {
		t.Fatalf("work seed %s, want %s", hx(got[:]), v.WorkSeed.Out)
	}
}

func TestWorkIsBounded(t *testing.T) {
	var s [32]byte
	for _, c := range [][3]int{{0, 1, 1}, {MaxRounds + 1, 1, 1}, {1, 0, 1}, {1, MaxMemoryMiB + 1, 1}, {1, 1, 0}, {1, 1, MaxLanes + 1}, {1, 128, 33}} {
		if _, err := Lanes(s, c[0], c[1], c[2]); err == nil {
			t.Fatalf("rounds %d, %d MiB, %d lanes was not refused", c[0], c[1], c[2])
		}
	}
}

func TestMessagesAreTheContracts(t *testing.T) {
	v, d, k := load(t)
	addr := k.Address()
	if hx(addr[:]) != v.Address {
		t.Fatalf("address %s, viem gives %s", hx(addr[:]), v.Address)
	}
	seen := map[string]bool{}
	for _, m := range v.Messages {
		seen[m.PrimaryType] = true
		got, err := Digest(d, m.PrimaryType, m.Values)
		if err != nil || hx(got[:]) != m.Digest {
			t.Fatalf("%s: digest %s (%v), viem gives %s", m.PrimaryType, hx(got[:]), err, m.Digest)
		}
		sig, err := k.SignMessage(d, m.PrimaryType, m.Values)
		if m.Signature == nil { // the answer: never by this path
			if err == nil {
				t.Fatalf("%s was signed from a caller's fields", m.PrimaryType)
			}
			continue
		}
		if err != nil || hx(sig[:]) != *m.Signature {
			t.Fatalf("%s: signature %s (%v), viem gives %s", m.PrimaryType, hx(sig[:]), err, *m.Signature)
		}
	}
	for name := range messages {
		if !seen[name] {
			t.Fatalf("%s has no vector", name)
		}
	}
}

func TestAnswerSignsOnlyTheWorkItDid(t *testing.T) {
	v, d, k := load(t)
	c := v.Answer.Challenge
	digest, sig, err := k.Answer(d, Challenge{Epoch: c.Epoch, Checker: b32(t, c.Checker), Target: b32(t, c.Target), Seed: b32(t, c.Seed), Nonce: b32(t, c.Nonce),
		Rounds: c.Rounds, MemoryMiB: c.MemoryMiB, Lanes: c.Lanes})
	if err != nil || hx(digest[:]) != v.Answer.Digest || hx(sig[:]) != v.Answer.Signature {
		t.Fatalf("answer %s %s (%v), the host's code and viem give %s %s", hx(digest[:]), hx(sig[:]), err, v.Answer.Digest, v.Answer.Signature)
	}
	// and the signature recovers to this key (what the checker does with the registry's proof key)
	msg, _ := Digest(d, "CapacityAnswer", map[string]string{"epoch": "7", "checker": c.Checker, "target": c.Target, "nonce": c.Nonce, "digest": v.Answer.Digest})
	pub, _, err := ecdsa.RecoverCompact(append([]byte{sig[64]}, sig[:64]...), msg[:])
	if err != nil || !pub.IsEqual(k.priv.PubKey()) {
		t.Fatalf("the answer's signature does not recover to the key: %v", err)
	}
	if _, _, err := k.Answer(d, Challenge{Rounds: MaxRounds + 1, MemoryMiB: 1, Lanes: 1}); err == nil {
		t.Fatal("work out of bounds was answered")
	}
}

func TestOnlyWholeWellFormedMessages(t *testing.T) {
	v, d, k := load(t)
	var report map[string]string
	for _, m := range v.Messages {
		if m.PrimaryType == "CapacityReport" {
			report = m.Values
		}
	}
	change := func(f func(map[string]string)) map[string]string {
		c := map[string]string{}
		for k, v := range report {
			c[k] = v
		}
		f(c)
		return c
	}
	bad := []map[string]string{
		change(func(m map[string]string) { delete(m, "seed") }),
		change(func(m map[string]string) { m["extra"] = "1" }),
		change(func(m map[string]string) { m["verdict"] = "256" }),
		change(func(m map[string]string) { m["verdict"] = "-1" }),
		change(func(m map[string]string) { m["verdict"] = "02" }),
		change(func(m map[string]string) { m["epoch"] = "18446744073709551616" }),
		change(func(m map[string]string) { m["checker"] = m["checker"][:60] }),
		change(func(m map[string]string) { m["checker"] = m["checker"][2:] }),
	}
	for i, m := range bad {
		if _, err := k.SignMessage(d, "CapacityReport", m); err == nil {
			t.Fatalf("malformed report %d was signed", i)
		}
	}
	for _, name := range []string{"CapacityAnswer", "Permit", "EIP712Domain", ""} {
		if _, err := k.SignMessage(d, name, report); err == nil {
			t.Fatalf("%q was signed", name)
		}
	}
}

func TestKeysAreNew(t *testing.T) {
	a, err := NewKey()
	b, err2 := NewKey()
	if err != nil || err2 != nil || a.Address() == b.Address() {
		t.Fatal("two keys are one")
	}
	addr := a.Address()
	if s := KeyStatement(addr); !strings.HasPrefix(string(s), "enclave-host-capacity-key/1\n") || len(s) != 28+20 {
		t.Fatalf("statement %q", s)
	}
}

// testdata/statement.json: one key statement as a domain's TLS key makes it (ECDSA P-256 over the SHA-256 of
// KeyStatement, ASN.1 DER), with that key's public half only. network/proof-of-capacity-partition.mjs verifies the same
// file (test/proof-of-capacity-partition.test.mjs), so the two sides agree on what is signed and how.
// CAPACITY_WRITE_STATEMENT=1 go test ./capacity/ -run TestKeyStatementVector   writes a new one (a new throwaway key).
func TestKeyStatementVector(t *testing.T) {
	type vector struct{ Address, Spki, TLSSignature string }
	if os.Getenv("CAPACITY_WRITE_STATEMENT") == "1" {
		tlsKey, err := stdecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		k, _ := NewKey()
		addr := k.Address()
		digest := sha256.Sum256(KeyStatement(addr))
		sig, err := stdecdsa.SignASN1(rand.Reader, tlsKey, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		spki, _ := x509.MarshalPKIXPublicKey(&tlsKey.PublicKey)
		out, _ := json.MarshalIndent(vector{hx(addr[:]), base64.StdEncoding.EncodeToString(spki), base64.StdEncoding.EncodeToString(sig)}, "", " ")
		if err := os.WriteFile("testdata/statement.json", append(out, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw, err := os.ReadFile("testdata/statement.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	spki, _ := base64.StdEncoding.DecodeString(v.Spki)
	sig, _ := base64.StdEncoding.DecodeString(v.TLSSignature)
	pub, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		t.Fatal(err)
	}
	var addr [20]byte
	copy(addr[:], unhex(t, v.Address))
	digest := sha256.Sum256(KeyStatement(addr))
	if !stdecdsa.VerifyASN1(pub.(*stdecdsa.PublicKey), digest[:], sig) {
		t.Fatal("the stored statement does not verify")
	}
	addr[0] ^= 1
	digest = sha256.Sum256(KeyStatement(addr))
	if stdecdsa.VerifyASN1(pub.(*stdecdsa.PublicKey), digest[:], sig) {
		t.Fatal("the statement verifies for another address")
	}
}
