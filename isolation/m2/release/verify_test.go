package release

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"strings"
	"testing"
)

// a relay's reply for (id, ticket, sealKey): sealed with the vector's plaintext shape, signed by `priv`
func signedReply(t *testing.T, priv ed25519.PrivateKey, sk *SealKey, id, ticket [32]byte) (sealed, sig []byte) {
	t.Helper()
	pt := `{"id":"0x` + hex.EncodeToString(id[:]) + `","envelopeSha256":"` + strings.Repeat("00", 32) +
		`","config":{"a":1},"secrets":{},"issuedAt":"2026-09-25T00:00:00.000Z"}`
	eph := make([]byte, 32)
	iv := make([]byte, 12)
	rand.Read(eph)
	rand.Read(iv)
	sealed = seal(t, eph, iv, sk.Public(), id, ticket, []byte(pt))
	d, err := ResponseDigest(id, ticket, sk.Public(), sealed)
	if err != nil {
		t.Fatal(err)
	}
	return sealed, ed25519.Sign(priv, d[:])
}

func keyPair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

// Rule 2 (enclave-d1): VERIFY, THEN OPEN. The v1.2 vector's valid seal under a bad signature is refused by Verify, no
// Response exists to open, and no decryption is ever attempted.
func TestABadSignatureNeverReachesOpen(t *testing.T) {
	v := load(t, "relay-vectors-8042ce68.json")
	id, _ := ID(v.Inputs.ID)
	sk, _ := sealKeyFrom(unhex(t, v.Inputs.SealPrivateHex))
	ticket := b32(t, v.Inputs.TicketHex)
	sealed := unhex(t, v.Outputs.SealedHex)
	pub := ed25519.PublicKey(unhex(t, v.Outputs.ResponseSigningPublicHex))
	good := unhex(t, v.Outputs.ResponseSigHex)
	bad := append([]byte{}, good...)
	bad[10] ^= 1
	before := decrypts.Load()
	for what, sig := range map[string][]byte{"a flipped bit": bad, "no signature": nil, "a short one": good[:63],
		"sixty-four zeros": make([]byte, 64)} {
		resp, err := sk.Verify([]ed25519.PublicKey{pub}, id, ticket, sealed, sig, v.Outputs.ResponseKeyID)
		if err == nil || resp != nil {
			t.Fatalf("%s: verified", what)
		}
		if _, err := sk.Open(resp); err == nil {
			t.Fatalf("%s: opened", what)
		}
	}
	if n := decrypts.Load() - before; n != 0 {
		t.Fatalf("%d decryption(s) were attempted for replies that failed their signature", n)
	}
	// and the same seal under its GOOD signature does open
	resp, err := sk.Verify([]ed25519.PublicKey{pub}, id, ticket, sealed, good, v.Outputs.ResponseKeyID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := sk.Open(resp); err != nil {
		t.Fatal(err)
	}
}

// Rule 1: the digest is the guest's OWN id, ticket and seal key. A reply signed for another request - another
// ticket, another seal key, another deployment - does not verify for this one, and a tampered sealed byte breaks it.
func TestTheDigestIsTheGuestsOwnRequest(t *testing.T) {
	pub, priv := keyPair(t)
	sk, _ := NewSealKey()
	id, ticket := [32]byte{1}, [32]byte{2}
	sealed, sig := signedReply(t, priv, sk, id, ticket)
	pinned := []ed25519.PublicKey{pub}
	if _, err := sk.Verify(pinned, id, ticket, sealed, sig, ""); err != nil {
		t.Fatal(err)
	}
	otherTicket, otherID := ticket, id
	otherTicket[0] ^= 1
	otherID[31] ^= 1
	otherKey, _ := NewSealKey()
	tampered := append([]byte{}, sealed...)
	tampered[len(tampered)-1] ^= 1
	for what, try := range map[string]func() error{
		"another ticket":     func() error { _, err := sk.Verify(pinned, id, otherTicket, sealed, sig, ""); return err },
		"another deployment": func() error { _, err := sk.Verify(pinned, otherID, ticket, sealed, sig, ""); return err },
		"another seal key":   func() error { _, err := otherKey.Verify(pinned, id, ticket, sealed, sig, ""); return err },
		"a tampered seal":    func() error { _, err := sk.Verify(pinned, id, ticket, tampered, sig, ""); return err },
	} {
		if try() == nil {
			t.Fatalf("%s: verified", what)
		}
	}
	// a Response is bound to the seal key that verified it
	resp, _ := sk.Verify(pinned, id, ticket, sealed, sig, "")
	if _, err := otherKey.Open(resp); err == nil {
		t.Fatal("another seal key opened a response it did not verify")
	}
}

// Rule 3: only PINNED keys, and keyId selects only when it names exactly one of them.
func TestOnlyPinnedKeysAndTheKeyIDRule(t *testing.T) {
	a, aPriv := keyPair(t)
	b, _ := keyPair(t)
	c, cPriv := keyPair(t)
	sk, _ := NewSealKey()
	id, ticket := [32]byte{3}, [32]byte{4}
	sealed, sigA := signedReply(t, aPriv, sk, id, ticket)
	_, sigC := signedReply(t, cPriv, sk, id, ticket)
	for _, tc := range []struct {
		what   string
		pinned []ed25519.PublicKey
		sig    []byte
		keyID  string
		ok     bool
	}{
		{"keyId names the signing key", []ed25519.PublicKey{a, b}, sigA, KeyID(a), true},
		{"no keyId: every pinned key is tried", []ed25519.PublicKey{b, a}, sigA, "", true},
		{"an unknown keyId: every pinned key is tried", []ed25519.PublicKey{b, a}, sigA, "0123456789abcdef", true},
		{"keyId names ANOTHER pinned key: only that one is tried", []ed25519.PublicKey{a, b}, sigA, KeyID(b), false},
		{"keyId names a key pinned twice: not exactly one, every key is tried", []ed25519.PublicKey{a, a}, sigA, KeyID(a), true},
		{"an unpinned signer, naming itself", []ed25519.PublicKey{a, b}, sigC, KeyID(c), false},
		{"an unpinned signer, naming nothing", []ed25519.PublicKey{a, b}, sigC, "", false},
		{"nothing pinned", nil, sigA, KeyID(a), false},
		{"a malformed pinned key", []ed25519.PublicKey{a[:31]}, sigA, "", false},
	} {
		_, err := sk.Verify(tc.pinned, id, ticket, sealed, tc.sig, tc.keyID)
		if (err == nil) != tc.ok {
			t.Fatalf("%s: err %v", tc.what, err)
		}
	}
}

// Rule 4: the pinned set is a LIST compiled into the image, and a malformed entry is an error, never skipped. (The
// production set itself is pinned by pins_test.go.)
func TestThePinnedSetIsAList(t *testing.T) {
	saved := relayReleaseKeys
	defer func() { relayReleaseKeys = saved }()
	a, _ := keyPair(t)
	b, _ := keyPair(t)
	relayReleaseKeys = []string{hex.EncodeToString(a), hex.EncodeToString(b)} // {old, new}, as a rotation ships
	if keys, err := PinnedRelayKeys(); err != nil || len(keys) != 2 {
		t.Fatalf("a two-key set: %d %v", len(keys), err)
	}
	for _, bad := range []string{"zz", hex.EncodeToString(a[:31]), hex.EncodeToString(a) + "00"} {
		relayReleaseKeys = []string{hex.EncodeToString(a), bad}
		if _, err := PinnedRelayKeys(); err == nil {
			t.Fatalf("%q was pinned", bad)
		}
	}
}
