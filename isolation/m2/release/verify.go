package release

// Contract v1.2: the relay SIGNS every release response, and the guest verifies before it opens.
//
// The seal gives confidentiality but no origin: its key is the guest's public sealKey and its salt is a ticket the
// host carries, so anyone able to answer as the relay (a mis-issued certificate for RelayHost) could seal a config of
// their choosing to this guest, egress allowlist included. The signature is what makes the reply the relay's:
//
//	digest = sha256("enclave-secrets-release-v1 response\n" ‖ id(32) ‖ ticket(32) ‖ sealKey(32) ‖ sha256(sealed))
//	sig    = Ed25519(the relay's release key, digest)
//
// The guest's rules (enclave-d1's review of v1.2, docs/security/attested-release.md):
//  1. the digest is recomputed from the guest's OWN id, ticket and seal key, never from fields of the response;
//  2. VERIFY, THEN OPEN: SealKey.Open takes only a *Response, and only SealKey.Verify makes one, so a reply with a
//     bad or missing signature cannot reach the decryption at all;
//  3. only PINNED keys are trusted: keyId may select a key only when it names exactly one pinned key, otherwise every
//     pinned key is tried; a key offered by the response is never used (the response has no field that could carry
//     one to here);
//  4. rotation is by image: the pinned set is compiled into the measured front, so it is a list from the start
//     ({old, new} front → the relay switches → {new} front).

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

const responseDomain = "enclave-secrets-release-v1 response\n"

// PinnedRelayKeys is the pinned set, parsed. A malformed entry is an error, never skipped.
func PinnedRelayKeys() ([]ed25519.PublicKey, error) {
	var out []ed25519.PublicKey
	for _, h := range relayReleaseKeys {
		b, err := hex.DecodeString(h)
		if err != nil || len(b) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("a pinned relay release key is not 32 bytes of hex: %q", h)
		}
		out = append(out, ed25519.PublicKey(b))
	}
	return out, nil
}

// KeyID is a key's selector: sha256 of the raw 32-byte public key, hex, first 16 characters.
func KeyID(pub ed25519.PublicKey) string {
	s := sha256.Sum256(pub)
	return hex.EncodeToString(s[:])[:16]
}

// ResponseDigest is what the relay signs. The guest computes it from its OWN values (rule 1).
func ResponseDigest(id, ticket [32]byte, sealKey, sealed []byte) ([32]byte, error) {
	if len(sealKey) != 32 {
		return [32]byte{}, errors.New("the seal key is not 32 bytes")
	}
	hs := sha256.Sum256(sealed)
	h := sha256.New()
	h.Write([]byte(responseDomain))
	h.Write(id[:])
	h.Write(ticket[:])
	h.Write(sealKey)
	h.Write(hs[:])
	var d [32]byte
	copy(d[:], h.Sum(nil))
	return d, nil
}

// Response is a sealed reply whose signature verified under a pinned key, for THIS seal key's request. Only
// SealKey.Verify makes one, and only the SealKey that verified it can open it.
type Response struct {
	sealed     []byte
	id, ticket [32]byte
	by         *SealKey
}

// Verify checks the relay's signature over the digest of this guest's own request and the sealed bytes it got back.
func (s *SealKey) Verify(pinned []ed25519.PublicKey, id, ticket [32]byte, sealed, sig []byte, keyID string) (*Response, error) {
	if len(pinned) == 0 {
		return nil, errors.New("no relay release key is pinned in this image, so no release is trusted")
	}
	if len(sig) != ed25519.SignatureSize {
		return nil, errors.New("the relay's response carries no valid signature")
	}
	d, err := ResponseDigest(id, ticket, s.Public(), sealed)
	if err != nil {
		return nil, err
	}
	candidates := pinned
	var named []ed25519.PublicKey
	for _, k := range pinned {
		if len(k) == ed25519.PublicKeySize && KeyID(k) == keyID {
			named = append(named, k)
		}
	}
	if len(named) == 1 {
		candidates = named // keyId selects only when it names exactly one pinned key
	}
	for _, k := range candidates {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, d[:], sig) {
			return &Response{sealed: append([]byte(nil), sealed...), id: id, ticket: ticket, by: s}, nil
		}
	}
	return nil, errors.New("the relay's response signature does not verify under any pinned key")
}
