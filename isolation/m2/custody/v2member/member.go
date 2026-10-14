// Package v2member is the OWNER and CUSTODIAN half of custody v2's math (custody/v2/protocol.mjs encryptBundle, partial,
// sealPartials), in Go, for tests only: it lets the guest's tests run a fake committee. The guest never links it (only
// _test files import it), and production custodians run the JS reference.
package v2member

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"enclave.host/isolation/m2/custody"
)

// Scalar is a big-endian value reduced mod q (the JS vectors' sc()).
func Scalar(b []byte) *secp256k1.ModNScalar {
	var s secp256k1.ModNScalar
	s.SetByteSlice(b)
	return &s
}

// Random draws a scalar in [1, q).
func Random() *secp256k1.ModNScalar {
	for {
		var b [32]byte
		rand.Read(b[:])
		var s secp256k1.ModNScalar
		if s.SetBytes(&b) == 0 && !s.IsZero() {
			return &s
		}
	}
}

func bytesOf(p *secp256k1.JacobianPoint) []byte {
	b, err := custody.PointBytesOf(p)
	if err != nil {
		panic(err)
	}
	return b
}

func mulG(s *secp256k1.ModNScalar) *secp256k1.JacobianPoint {
	var r secp256k1.JacobianPoint
	secp256k1.ScalarBaseMultNonConst(s, &r)
	return &r
}

func mul(p *secp256k1.JacobianPoint, s *secp256k1.ModNScalar) *secp256k1.JacobianPoint {
	var r secp256k1.JacobianPoint
	secp256k1.ScalarMultNonConst(s, p, &r)
	return &r
}

// Committee is a dealt polynomial: x = Coeffs[0], share x_k = Σ Coeffs[j]·k^j, commitments C_j = Coeffs[j]·G.
type Committee struct {
	Coeffs      []*secp256k1.ModNScalar
	Commitments [][]byte
}

// NewCommittee deals a degree t-1 polynomial (coeffs given, or random).
func NewCommittee(t int, coeffs ...*secp256k1.ModNScalar) *Committee {
	c := &Committee{}
	for j := 0; j < t; j++ {
		s := Random()
		if j < len(coeffs) {
			s = coeffs[j]
		}
		c.Coeffs = append(c.Coeffs, s)
		c.Commitments = append(c.Commitments, bytesOf(mulG(s)))
	}
	return c
}

// Y is the committee key.
func (c *Committee) Y() []byte { return c.Commitments[0] }

// CommitmentBytes is the pointer's commitments field (t x 33).
func (c *Committee) CommitmentBytes() []byte {
	var out []byte
	for _, b := range c.Commitments {
		out = append(out, b...)
	}
	return out
}

// Share is x_k.
func (c *Committee) Share(k uint32) *secp256k1.ModNScalar {
	var acc, kk, kp secp256k1.ModNScalar
	kk.SetInt(k)
	kp.SetInt(1)
	for _, a := range c.Coeffs {
		var term secp256k1.ModNScalar
		term.Mul2(a, &kp)
		acc.Add(&term)
		kp.Mul(&kk)
	}
	return &acc
}

// EncryptBundle is protocol.mjs encryptBundle; r, k and nonce are drawn when nil.
func EncryptBundle(Y []byte, label [32]byte, env map[string]string, configSha256 string, r, k *secp256k1.ModNScalar, nonce []byte) ([]byte, error) {
	if r == nil {
		r = Random()
	}
	if k == nil {
		k = Random()
	}
	if nonce == nil {
		nonce = make([]byte, 12)
		rand.Read(nonce)
	}
	Yp, err := custody.PointOf(Y, "committee key")
	if err != nil {
		return nil, err
	}
	R, A := bytesOf(mulG(r)), bytesOf(mulG(k))
	c := custody.HashToScalar([]byte("enclave-custody-v2 pok\n"), label[:], R, A)
	var z secp256k1.ModNScalar
	z.Mul2(c, r).Add(k)
	key, err := hkdf.Key(sha256.New, bytesOf(mul(Yp, r)), label[:], "enclave-custody-v2 key", 32)
	if err != nil {
		return nil, err
	}
	pt, err := json.Marshal(struct {
		V            int               `json:"v"`
		Env          map[string]string `json:"env"`
		ConfigSha256 string            `json:"configSha256"`
	}{2, env, configSha256})
	if err != nil {
		return nil, err
	}
	blk, _ := aes.NewCipher(key)
	g, _ := cipher.NewGCM(blk)
	cb, zb := c.Bytes(), z.Bytes()
	out := append(append(append(append([]byte{}, R...), cb[:]...), zb[:]...), nonce...)
	return g.Seal(out, nonce, pt, label[:]), nil
}

// Partial is protocol.mjs partial: D = x·R with a DLEQ proof under binding; u is drawn when nil.
func Partial(k uint32, x *secp256k1.ModNScalar, R []byte, binding [32]byte, commitments [][]byte, u *secp256k1.ModNScalar) ([]byte, error) {
	Rp, err := custody.PointOf(R, "bundle R")
	if err != nil {
		return nil, err
	}
	Yk, err := custody.PublicShare(k, commitments)
	if err != nil {
		return nil, err
	}
	if u == nil {
		u = Random()
	}
	D := bytesOf(mul(Rp, x))
	var kb [4]byte
	binary.BigEndian.PutUint32(kb[:], k)
	c := custody.HashToScalar([]byte("enclave-custody-v2 dleq\n"), binding[:], kb[:], bytesOf(Yk), R, D, bytesOf(mulG(u)), bytesOf(mul(Rp, u)))
	var z secp256k1.ModNScalar
	z.Mul2(c, x).Add(u)
	cb, zb := c.Bytes(), z.Bytes()
	return append(append(append(kb[:], D...), cb[:]...), zb[:]...), nil
}

// Seal is protocol.mjs sealPartials (ikmE nil = fresh).
func Seal(recipient *ecdh.PublicKey, binding, encKey [32]byte, records [][]byte, ikmE []byte) ([]byte, error) {
	if len(records) == 0 {
		return nil, errors.New("no records")
	}
	var pt []byte
	for _, r := range records {
		pt = append(pt, r...)
	}
	return custody.Seal(recipient, []byte("enclave-custody-v2 partial-release"), custody.PartialAAD(binding, encKey, len(records)), pt, ikmE)
}
