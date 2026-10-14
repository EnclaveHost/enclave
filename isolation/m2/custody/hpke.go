// Package custody is the guest half of attestation-gated secret custody (docs/security/secret-custody.md): the measured
// front asks a threshold of independent custodians for shares of a deployment's data key, each sealed to a recipient key
// this package generates and binds into the hardware report, combines them and opens the bundle. It mirrors custody/*.mjs
// byte for byte; testdata/vectors.json (written by test/custody-vectors.test.mjs) pins the two together.
//
// v1 is standard library only: HPKE here is RFC 9180 base mode over crypto/ecdh (X25519), crypto/hkdf (HKDF-SHA256) and
// crypto/cipher (AES-128-GCM), checked against the RFC's Appendix A.1 vectors. Custody v2 (v2.go, v2client.go) adds ONE
// dependency for secp256k1 point arithmetic, github.com/decred/dcrd/dcrec/secp256k1/v4, pinned by go.sum.
package custody

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

const (
	kemID  = 0x0020
	kdfID  = 0x0001
	aeadID = 0x0001
	nk     = 16
	nn     = 12
	nh     = 32
)

var (
	suiteKEM  = []byte{'K', 'E', 'M', 0x00, 0x20}
	suiteHPKE = []byte{'H', 'P', 'K', 'E', 0x00, 0x20, 0x00, 0x01, 0x00, 0x01}
)

func i2osp2(n int) []byte { return []byte{byte(n >> 8), byte(n)} }

func cat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func labeledExtract(suite, salt []byte, label string, ikm []byte) []byte {
	prk, err := hkdf.Extract(sha256.New, cat([]byte("HPKE-v1"), suite, []byte(label), ikm), salt)
	if err != nil {
		panic(err) // HKDF-SHA256 Extract cannot fail
	}
	return prk
}

func labeledExpand(suite, prk []byte, label string, info []byte, l int) []byte {
	out, err := hkdf.Expand(sha256.New, prk, string(cat(i2osp2(l), []byte("HPKE-v1"), suite, []byte(label), info)), l)
	if err != nil {
		panic(err) // lengths here are fixed and far below the limit
	}
	return out
}

// DeriveKeyPair is RFC 9180 §7.1.3 for X25519.
func DeriveKeyPair(ikm []byte) (*ecdh.PrivateKey, error) {
	prk := labeledExtract(suiteKEM, nil, "dkp_prk", ikm)
	return ecdh.X25519().NewPrivateKey(labeledExpand(suiteKEM, prk, "sk", nil, 32))
}

// NewRecipientKey draws a fresh X25519 key from the guest's CSPRNG.
func NewRecipientKey() (*ecdh.PrivateKey, error) {
	ikm := make([]byte, 32)
	if _, err := rand.Read(ikm); err != nil {
		return nil, err
	}
	return DeriveKeyPair(ikm)
}

type hpkeCtx struct {
	key, baseNonce []byte
}

func keySchedule(shared, info []byte) hpkeCtx {
	pskIDHash := labeledExtract(suiteHPKE, nil, "psk_id_hash", nil)
	infoHash := labeledExtract(suiteHPKE, nil, "info_hash", info)
	ksc := cat([]byte{0x00}, pskIDHash, infoHash)
	secret := labeledExtract(suiteHPKE, shared, "secret", nil)
	return hpkeCtx{key: labeledExpand(suiteHPKE, secret, "key", ksc, nk), baseNonce: labeledExpand(suiteHPKE, secret, "base_nonce", ksc, nn)}
}

func encapShared(dh, enc, pkR []byte) []byte {
	prk := labeledExtract(suiteKEM, nil, "eae_prk", dh)
	return labeledExpand(suiteKEM, prk, "shared_secret", cat(enc, pkR), 32)
}

func (c hpkeCtx) aead() (cipher.AEAD, error) {
	b, err := aes.NewCipher(c.key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(b)
}

func (c hpkeCtx) nonce(seq uint64) []byte {
	n := append([]byte(nil), c.baseNonce...)
	var s [8]byte
	binary.BigEndian.PutUint64(s[:], seq)
	for i := 0; i < 8; i++ {
		n[nn-8+i] ^= s[i]
	}
	return n
}

// Seal is single-shot base-mode HPKE: enc(32) ‖ ciphertext. ikmE is for the RFC vectors only (nil = fresh).
func Seal(pkR *ecdh.PublicKey, info, aad, pt, ikmE []byte) ([]byte, error) {
	var skE *ecdh.PrivateKey
	var err error
	if ikmE != nil {
		skE, err = DeriveKeyPair(ikmE)
	} else {
		skE, err = NewRecipientKey()
	}
	if err != nil {
		return nil, err
	}
	dh, err := skE.ECDH(pkR) // crypto/ecdh refuses an all-zero (low-order) result
	if err != nil {
		return nil, err
	}
	enc := skE.PublicKey().Bytes()
	ctx := keySchedule(encapShared(dh, enc, pkR.Bytes()), info)
	a, err := ctx.aead()
	if err != nil {
		return nil, err
	}
	return cat(enc, a.Seal(nil, ctx.nonce(0), pt, aad)), nil
}

// Open reverses Seal under the recipient's private key.
func Open(skR *ecdh.PrivateKey, info, aad, blob []byte) ([]byte, error) {
	if len(blob) < 32+16 {
		return nil, errors.New("hpke: sealed blob too short")
	}
	pkE, err := ecdh.X25519().NewPublicKey(blob[:32])
	if err != nil {
		return nil, err
	}
	dh, err := skR.ECDH(pkE)
	if err != nil {
		return nil, err
	}
	ctx := keySchedule(encapShared(dh, blob[:32], skR.PublicKey().Bytes()), info)
	a, err := ctx.aead()
	if err != nil {
		return nil, err
	}
	return a.Open(nil, ctx.nonce(0), blob[32:], aad)
}
