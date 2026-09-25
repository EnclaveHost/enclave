package release

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

type vectors struct {
	Contract string `json:"contract"`
	Inputs   struct {
		ID               string `json:"id"`
		TransportSpkiHex string `json:"transportSpkiHex"`
		TicketHex        string `json:"ticketHex"`
		RuntimeIDHex     string `json:"runtimeIdHex"`
		SealPrivateHex   string `json:"sealPrivateHex"`
		EphPrivateHex    string `json:"ephPrivateHex"`
		IVHex            string `json:"ivHex"`
		Plaintext        string `json:"plaintext"`
	} `json:"inputs"`
	Outputs struct {
		SealKeyHex   string `json:"sealKeyHex"`
		EphPublicHex string `json:"ephPublicHex"`
		BindingHex   string `json:"bindingHex"`
		SealedHex    string `json:"sealedHex"`
	} `json:"outputs"`
}

func unhex(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func b32(t *testing.T, s string) (o [32]byte) {
	t.Helper()
	copy(o[:], unhex(t, s))
	return
}

// seal is the relay's side, for tests only: the contract written out a second time, so the vectors also check this
// package's reading of it.
func seal(t *testing.T, ephPriv, iv []byte, sealPub []byte, id, ticket [32]byte, pt []byte) []byte {
	t.Helper()
	eph, err := ecdh.X25519().NewPrivateKey(ephPriv)
	if err != nil {
		t.Fatal(err)
	}
	peer, err := ecdh.X25519().NewPublicKey(sealPub)
	if err != nil {
		t.Fatal(err)
	}
	shared, err := eph.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	info := append(append(append([]byte(sealInfo), id[:]...), eph.PublicKey().Bytes()...), sealPub...)
	key, err := hkdf.Key(sha256.New, shared, ticket[:], string(info), 32)
	if err != nil {
		t.Fatal(err)
	}
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	return append(append(append([]byte{}, eph.PublicKey().Bytes()...), iv...), gcm.Seal(nil, iv, pt, nil)...)
}

func load(t *testing.T, name string) vectors {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The relay's own vectors (security/attested-release 6396ed1f, test/fixtures/secrets-release-vectors.json): the key,
// the binding and the sealed blob must all agree byte for byte.
func TestRelayVectors(t *testing.T) {
	v := load(t, "relay-vectors-6396ed1f.json")
	if !strings.HasPrefix(v.Contract, "enclave-secrets-release-v1") {
		t.Fatalf("contract %q", v.Contract)
	}
	id, err := ID(v.Inputs.ID)
	if err != nil {
		t.Fatal(err)
	}
	sk, err := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(sk.Public()) != v.Outputs.SealKeyHex {
		t.Fatalf("sealKey: %x want %s", sk.Public(), v.Outputs.SealKeyHex)
	}
	ticket, rt := b32(t, v.Inputs.TicketHex), b32(t, v.Inputs.RuntimeIDHex)
	bind, err := Binding(id, unhex(t, v.Inputs.TransportSpkiHex), ticket, rt, sk.Public())
	if err != nil {
		t.Fatal(err)
	}
	if hex.EncodeToString(bind[:]) != v.Outputs.BindingHex {
		t.Fatalf("binding: %x want %s", bind, v.Outputs.BindingHex)
	}
	sealed := unhex(t, v.Outputs.SealedHex)
	if hex.EncodeToString(sealed[:32]) != v.Outputs.EphPublicHex {
		t.Fatal("the sealed blob does not start with the ephemeral public key")
	}
	pt, err := sk.open(sealed, id, ticket)
	if err != nil {
		t.Fatal(err)
	}
	if string(pt) != v.Inputs.Plaintext {
		t.Fatalf("plaintext differs")
	}
	if again := seal(t, unhex(t, v.Inputs.EphPrivateHex), unhex(t, v.Inputs.IVHex), sk.Public(), id, ticket, []byte(v.Inputs.Plaintext)); !bytes.Equal(again, sealed) {
		t.Fatal("this package's reading of the seal does not reproduce the relay's bytes")
	}
	r, err := sk.Open(sealed, id, ticket)
	if err != nil {
		t.Fatal(err)
	}
	if r.ID == "" || r.EnvelopeSha256 == "" {
		t.Fatalf("parsed release lacks fields: %+v", r)
	}
}

// This package's own vectors, handed to the relay as a second fixture; regenerated deterministically here, so a
// change on either side fails one of the two.
func TestGuestVectorsAreCurrent(t *testing.T) {
	v := load(t, "guest-vectors.json")
	id, _ := ID(v.Inputs.ID)
	sk, _ := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	ticket, rt := b32(t, v.Inputs.TicketHex), b32(t, v.Inputs.RuntimeIDHex)
	bind, _ := Binding(id, unhex(t, v.Inputs.TransportSpkiHex), ticket, rt, sk.Public())
	sealed := seal(t, unhex(t, v.Inputs.EphPrivateHex), unhex(t, v.Inputs.IVHex), sk.Public(), id, ticket, []byte(v.Inputs.Plaintext))
	if hex.EncodeToString(sk.Public()) != v.Outputs.SealKeyHex || hex.EncodeToString(bind[:]) != v.Outputs.BindingHex ||
		hex.EncodeToString(sealed) != v.Outputs.SealedHex || hex.EncodeToString(sealed[:32]) != v.Outputs.EphPublicHex {
		t.Fatal("testdata/guest-vectors.json is stale: regenerate it with GUEST_VECTORS_WRITE=1")
	}
	if _, err := sk.Open(sealed, id, ticket); err != nil {
		t.Fatal(err)
	}
}

func TestOpenRefusals(t *testing.T) {
	v := load(t, "relay-vectors-6396ed1f.json")
	id, _ := ID(v.Inputs.ID)
	sk, _ := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	ticket := b32(t, v.Inputs.TicketHex)
	sealed := unhex(t, v.Outputs.SealedHex)
	other := id
	other[31] ^= 1
	otherTicket := ticket
	otherTicket[0] ^= 1
	tampered := append([]byte{}, sealed...)
	tampered[len(tampered)-1] ^= 1
	for name, try := range map[string]func() error{
		"another ticket":             func() error { _, err := sk.Open(sealed, id, otherTicket); return err },
		"another deployment's info":  func() error { _, err := sk.Open(sealed, other, ticket); return err },
		"a tampered byte":            func() error { _, err := sk.Open(tampered, id, ticket); return err },
		"truncated":                  func() error { _, err := sk.Open(sealed[:40], id, ticket); return err },
		"another seal key": func() error {
			k, _ := NewSealKey()
			_, err := k.Open(sealed, id, ticket)
			return err
		},
		// a low-order ephemeral key forces an all-zero shared secret; the open must refuse, not derive from zeros
		"a low-order ephemeral key": func() error {
			lowOrder := make([]byte, 32) // the all-zero point
			_, err := sk.Open(append(lowOrder, sealed[32:]...), id, ticket)
			return err
		},
		// a plaintext that is well-sealed for THIS key and ticket but names another deployment
		"a release naming another deployment": func() error {
			pt := strings.Replace(v.Inputs.Plaintext, strings.TrimPrefix(v.Inputs.ID, "0x"), strings.Repeat("ab", 32), 1)
			if pt == v.Inputs.Plaintext {
				t.Fatal("the vector's plaintext does not carry its id")
			}
			s := seal(t, unhex(t, v.Inputs.EphPrivateHex), unhex(t, v.Inputs.IVHex), sk.Public(), id, ticket, []byte(pt))
			_, err := sk.Open(s, id, ticket)
			return err
		},
	} {
		if err := try(); err == nil {
			t.Fatalf("%s: opened", name)
		} else if strings.Contains(err.Error(), "secret") && strings.Contains(err.Error(), "value") {
			t.Fatalf("%s: the error looks like it carries plaintext: %v", name, err)
		}
	}
}

// The release binding can never be a Bind2 (or Bind) over the same transport key, whatever nonce a host relays: the
// preimages start differently (ASCII domain vs DER 0x30), so equal digests would be a SHA-256 collision.
func TestTheReleaseDomainIsNotBind2(t *testing.T) {
	v := load(t, "relay-vectors-6396ed1f.json")
	id, _ := ID(v.Inputs.ID)
	spki := unhex(t, v.Inputs.TransportSpkiHex)
	ticket, rt := b32(t, v.Inputs.TicketHex), b32(t, v.Inputs.RuntimeIDHex)
	sk, _ := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	rel, _ := Binding(id, spki, ticket, rt, sk.Public())
	for _, nonce := range [][]byte{ticket[:], rel[:], append(append([]byte{}, ticket[:]...), sk.Public()...)} {
		b2, err := contract.Bind2(spki, nonce, rt)
		if err == nil && b2 == rel {
			t.Fatal("a Bind2 over a relayable nonce equals the release binding")
		}
		b1, err := contract.Bind(spki, nonce)
		if err == nil && b1 == rel {
			t.Fatal("a Bind over a relayable nonce equals the release binding")
		}
	}
	if _, err := Binding(id, []byte{0x04, 1, 2}, ticket, rt, sk.Public()); err == nil {
		t.Fatal("a non-SPKI transport key was bound")
	}
	if _, err := Binding(id, spki, ticket, rt, sk.Public()[:31]); err == nil {
		t.Fatal("a short seal key was bound")
	}
}

func TestIDIsRawBytes(t *testing.T) {
	id, err := ID("0x" + strings.Repeat("0a", 32))
	if err != nil || id[0] != 0x0a || id[31] != 0x0a {
		t.Fatalf("id %x %v", id, err)
	}
	for _, bad := range []string{"", "0x12", "0x" + strings.Repeat("zz", 32), strings.Repeat("0a", 33)} {
		if _, err := ID(bad); err == nil {
			t.Fatalf("%q parsed", bad)
		}
	}
}

// GUEST_VECTORS_WRITE=1 go test -run TestWriteGuestVectors ./release/ regenerates testdata/guest-vectors.json.
func TestWriteGuestVectors(t *testing.T) {
	if os.Getenv("GUEST_VECTORS_WRITE") != "1" {
		t.Skip("set GUEST_VECTORS_WRITE=1 to regenerate the guest's vector file")
	}
	var v vectors
	v.Contract = "enclave-secrets-release-v1 (v1.1)"
	v.Inputs.ID = "0x" + strings.Repeat("fe", 16) + strings.Repeat("01", 16)
	// the transport key shape a per-app guest really has: an ECDSA P-256 SPKI (isolation/m2/domtls)
	v.Inputs.TransportSpkiHex = "3059301306072a8648ce3d020106082a8648ce3d03010703420004" + strings.Repeat("a5", 64)
	v.Inputs.TicketHex = strings.Repeat("6d", 32)
	v.Inputs.RuntimeIDHex = strings.Repeat("7e", 32)
	v.Inputs.SealPrivateHex = strings.Repeat("8f", 32)
	v.Inputs.EphPrivateHex = strings.Repeat("90", 32)
	v.Inputs.IVHex = strings.Repeat("a1", 12)
	v.Inputs.Plaintext = `{"id":"` + v.Inputs.ID + `","envelopeSha256":"` + strings.Repeat("0c", 32) +
		`","config":{"api_key":"$MCP_ADAPTER_API_KEY","url":"${IMAGE_ENDPOINT}/v1"},"secrets":{"MCP_ADAPTER_API_KEY":"synthetic-key","IMAGE_ENDPOINT":"https://images.example"},"issuedAt":"2026-09-25T00:00:00.000Z"}`
	id, _ := ID(v.Inputs.ID)
	sk, _ := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	ticket, rt := b32(t, v.Inputs.TicketHex), b32(t, v.Inputs.RuntimeIDHex)
	bind, _ := Binding(id, unhex(t, v.Inputs.TransportSpkiHex), ticket, rt, sk.Public())
	sealed := seal(t, unhex(t, v.Inputs.EphPrivateHex), unhex(t, v.Inputs.IVHex), sk.Public(), id, ticket, []byte(v.Inputs.Plaintext))
	v.Outputs.SealKeyHex = hex.EncodeToString(sk.Public())
	v.Outputs.EphPublicHex = hex.EncodeToString(sealed[:32])
	v.Outputs.BindingHex = hex.EncodeToString(bind[:])
	v.Outputs.SealedHex = hex.EncodeToString(sealed)
	out, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(filepath.Join("testdata", "guest-vectors.json"), append(out, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}
