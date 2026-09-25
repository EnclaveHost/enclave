// Package release is the per-app guest's half of the attested secrets release (docs/security/attested-release.md,
// contract enclave-secrets-release-v1, v1.1, relay side on security/attested-release).
//
// The guest mints a fresh X25519 seal key per release, binds it into its SNP report under a binding domain of its
// own, and opens the relay's sealed reply. Nothing here talks to the network or the report device: the caller wires
// those in, so this package can be checked byte for byte against the relay's vectors.
//
// The binding domain is NOT Bind2. The guest's public attestation endpoint signs Bind2 over any caller's nonce; if
// the release accepted Bind2, whoever relays a nonce (the host) could ask that endpoint for release evidence. So
// report_data[0:32] here is
//
//	sha256("enclave-secrets-release-v1\n" ‖ id(32) ‖ sha256(transportSpki)(32) ‖ ticket(32) ‖ runtimeId(32) ‖ sealKey(32))
//
// every field fixed-length, the preimage starting with the ASCII domain (Bind and Bind2 preimages start with a DER
// SPKI, 0x30), and report_data[32:64] is the AppID, which the guest's measured platform fills, never this caller.
package release

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	bindingDomain = "enclave-secrets-release-v1\n"
	sealInfo      = "enclave-secrets-release-v1 seal\n"
	ephLen, ivLen = 32, 12
	tagLen        = 16
)

// SealKey is one release's key pair. The private half lives only in this process and only for one release.
type SealKey struct{ priv *ecdh.PrivateKey }

// NewSealKey mints a fresh key for ONE release.
func NewSealKey() (*SealKey, error) {
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	return &SealKey{priv: k}, nil
}

// sealKeyFrom is for vectors only: a fixed private key.
func sealKeyFrom(private []byte) (*SealKey, error) {
	k, err := ecdh.X25519().NewPrivateKey(private)
	if err != nil {
		return nil, err
	}
	return &SealKey{priv: k}, nil
}

// Public is the 32-byte sealKey the request carries and the binding covers.
func (s *SealKey) Public() []byte { return s.priv.PublicKey().Bytes() }

// ID parses a deployment id ("0x" + 64 hex) into its RAW 32 bytes: the preimage and the seal info carry the bytes32,
// never its ASCII.
func ID(id string) ([32]byte, error) {
	var out [32]byte
	h := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(id)), "0x")
	if len(h) != 64 {
		return out, errors.New("a deployment id is 0x + 64 hex")
	}
	if _, err := hex.Decode(out[:], []byte(h)); err != nil {
		return out, errors.New("a deployment id is 0x + 64 hex")
	}
	return out, nil
}

// Binding is report_data[0:32] for a release.
func Binding(id [32]byte, transportSpki []byte, ticket, runtimeID [32]byte, sealKey []byte) ([32]byte, error) {
	if len(sealKey) != 32 {
		return [32]byte{}, errors.New("a seal key is 32 bytes")
	}
	if len(transportSpki) == 0 || transportSpki[0] != 0x30 {
		return [32]byte{}, errors.New("the transport key is a DER SubjectPublicKeyInfo")
	}
	spkiHash := sha256.Sum256(transportSpki)
	h := sha256.New()
	h.Write([]byte(bindingDomain))
	h.Write(id[:])
	h.Write(spkiHash[:])
	h.Write(ticket[:])
	h.Write(runtimeID[:])
	h.Write(sealKey)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}

// Release is the plaintext the relay seals: the deployment's config document (null when it has none) and its secrets.
type Release struct {
	ID             string            `json:"id"`
	EnvelopeSha256 string            `json:"envelopeSha256"`
	Config         json.RawMessage   `json:"config"`
	Secrets        map[string]string `json:"secrets"`
	IssuedAt       string            `json:"issuedAt"` // ISO-8601, as the relay writes it

	opened bool // set ONLY by SealKey.Open: this release came through the attested channel
}

// Attested reports whether this Release was produced by SealKey.Open, i.e. decrypted from the relay's sealed reply.
// Another package cannot set it, so a Release assembled from anything else (host-delivered config) is never trusted.
func (r *Release) Attested() bool { return r != nil && r.opened }

// ConfigText is the text ENCLAVE_CONFIG carries before placeholder substitution: the config's JSON VALUE exactly as
// the relay serialized it - for a config inline in the envelope, byte-identical to the supervisor's
// JSON.stringify(o.config) (overrideConfigFields) - or "" when the release carries none. A config is an object or
// an array, as the relay requires (contract v1.2: anything else is its 422 bad_config), so both sides agree on what a
// config IS. A JSON STRING in particular is most likely a configCid's text that was never parsed, which would reach
// the app as one quoted string instead of its config.
func (r *Release) ConfigText() (string, error) {
	c := strings.TrimSpace(string(r.Config))
	if c == "" || c == "null" {
		return "", nil
	}
	if !strings.HasPrefix(c, "{") && !strings.HasPrefix(c, "[") {
		return "", errors.New("the release's config is not an object or an array (a string would be unparsed config text)")
	}
	return c, nil
}

// Open decrypts a sealed release and checks it is for THIS deployment. A failure says why and never carries a
// plaintext byte.
func (s *SealKey) Open(sealed []byte, id, ticket [32]byte) (*Release, error) {
	pt, err := s.open(sealed, id, ticket)
	if err != nil {
		return nil, err
	}
	defer zero(pt)
	var r Release
	if err := json.Unmarshal(pt, &r); err != nil {
		return nil, errors.New("the release plaintext is not the contract's JSON")
	}
	got, err := ID(r.ID)
	if err != nil || got != id {
		return nil, errors.New("the release is for another deployment")
	}
	if r.Secrets == nil {
		r.Secrets = map[string]string{}
	}
	r.opened = true
	return &r, nil
}

func (s *SealKey) open(sealed []byte, id, ticket [32]byte) ([]byte, error) {
	if len(sealed) < ephLen+ivLen+tagLen {
		return nil, errors.New("the sealed release is too short")
	}
	ephPub, iv, ct := sealed[:ephLen], sealed[ephLen:ephLen+ivLen], sealed[ephLen+ivLen:]
	peer, err := ecdh.X25519().NewPublicKey(ephPub)
	if err != nil {
		return nil, fmt.Errorf("the ephemeral key: %w", err)
	}
	shared, err := s.priv.ECDH(peer) // crypto/ecdh refuses an all-zero result (a low-order ephemeral key)
	if err != nil {
		return nil, fmt.Errorf("the key agreement: %w", err)
	}
	defer zero(shared)
	info := make([]byte, 0, len(sealInfo)+32+32+32)
	info = append(append(append(append(info, sealInfo...), id[:]...), ephPub...), s.Public()...)
	key, err := hkdf.Key(sha256.New, shared, ticket[:], string(info), 32)
	if err != nil {
		return nil, err
	}
	defer zero(key)
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	pt, err := gcm.Open(nil, iv, ct, nil)
	if err != nil {
		return nil, errors.New("the sealed release does not open under this seal key and ticket")
	}
	return pt, nil
}

func zero(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
