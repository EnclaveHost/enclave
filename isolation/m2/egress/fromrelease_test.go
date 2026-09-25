package egress

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"strings"
	"testing"

	"enclave.host/isolation/m2/release"
)

// sealTo seals a release plaintext to a guest's seal key exactly as the relay does (contract v1.1 seal, unchanged in
// v1.2), so this test exercises the real SealKey.Verify and SealKey.Open through exported APIs only.
func sealTo(t *testing.T, sealPub []byte, id, ticket [32]byte, pt []byte) []byte {
	t.Helper()
	eph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	peer, _ := ecdh.X25519().NewPublicKey(sealPub)
	shared, err := eph.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	info := append(append(append([]byte("enclave-secrets-release-v1 seal\n"), id[:]...), eph.PublicKey().Bytes()...), sealPub...)
	key, _ := hkdf.Key(sha256.New, shared, ticket[:], string(info), 32)
	iv := make([]byte, 12)
	rand.Read(iv)
	block, _ := aes.NewCipher(key)
	gcm, _ := cipher.NewGCM(block)
	return append(append(append([]byte{}, eph.PublicKey().Bytes()...), iv...), gcm.Seal(nil, iv, pt, nil)...)
}

func TestFromReleaseTakesOnlyAnAttestedRelease(t *testing.T) {
	cfg := `{"api_key":"$KEY","http":[{"url":"${IMAGE_ENDPOINT}/v1/images"}]}`
	// the host-delivered case: a Release assembled by hand is refused, whatever it says
	forged := &release.Release{ID: "0x" + strings.Repeat("11", 32), Config: json.RawMessage(cfg),
		Secrets: map[string]string{"IMAGE_ENDPOINT": "https://images.example"}}
	if _, err := FromRelease(forged, relay); err == nil {
		t.Fatal("a Release that did not come through the attested channel built an allowlist")
	}
	if _, err := FromRelease(nil, relay); err == nil {
		t.Fatal("a nil release built an allowlist")
	}

	// the attested case: sealed to a fresh seal key and opened by the real client
	id, _ := release.ID("0x" + strings.Repeat("11", 32))
	var ticket [32]byte
	rand.Read(ticket[:])
	sk, err := release.NewSealKey()
	if err != nil {
		t.Fatal(err)
	}
	pt, _ := json.Marshal(map[string]any{"id": "0x" + strings.Repeat("11", 32), "envelopeSha256": strings.Repeat("00", 32),
		"config": json.RawMessage(cfg), "secrets": map[string]string{"KEY": "k", "IMAGE_ENDPOINT": "https://images.example"},
		"issuedAt": "2026-09-25T00:00:00.000Z"})
	// v1.2: the relay signs the reply, and only a verified reply can be opened
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	sealed := sealTo(t, sk.Public(), id, ticket, pt)
	d, _ := release.ResponseDigest(id, ticket, sk.Public(), sealed)
	resp, err := sk.Verify([]ed25519.PublicKey{pub}, id, ticket, sealed, ed25519.Sign(priv, d[:]), "")
	if err != nil {
		t.Fatal(err)
	}
	rel, err := sk.Open(resp)
	if err != nil {
		t.Fatal(err)
	}
	p, err := FromRelease(rel, relay)
	if err != nil {
		t.Fatal(err)
	}
	// the endpoint came from a SECRET and was resolved in-guest before the allowlist was derived
	if !p.Allows("images.example") || !p.Allows("api.enclave.host") || len(p.Origins) != 2 {
		t.Fatalf("origins %+v", p.Origins)
	}
}
