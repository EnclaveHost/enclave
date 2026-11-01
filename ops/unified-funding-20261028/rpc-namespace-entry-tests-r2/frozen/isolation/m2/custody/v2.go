package custody

// Custody v2 (docs/security/secret-custody-v2.md): ONE committee key Y = x·G held by host custodians in their TEEs; a
// bundle is threshold ElGamal (R = r·G, S = r·Y) with a label proof; each custodian answers a release with partial
// decryptions D_k = x_k·R and a DLEQ proof per share index it holds; the guest verifies every proof against Y_k from the
// on-chain commitments, combines exactly t of them in the exponent, and opens the bundle under HKDF(S, label).
//
// custody/v2/protocol.mjs is the reference for every byte; testdata/v2-vectors.json (scripts/custody-v2-vectors.mjs) pins
// this file to it. Point arithmetic is github.com/decred/dcrd/dcrec/secp256k1/v4 (its variable-time operations: every
// input here is public or, for D_k and S, already sealed to this guest; the guest holds no long-term secret scalar).
//
// WHAT THIS IS: textbook constructions (threshold ElGamal with a TDH2-style label proof, Chaum-Pedersen DLEQ, Shamir in the
// exponent). It has NOT had an external review.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hkdf"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"enclave.host/isolation/m2/custody/seats"
)

const (
	domainV2Label      = "enclave-custody-v2 label\n"
	domainV2POK        = "enclave-custody-v2 pok\n"
	domainV2DLEQ       = "enclave-custody-v2 dleq\n"
	domainV2Partial    = "enclave-custody-v2 partial\n"
	domainV2Challenges = "enclave-custody-v2 challenges\n"
	domainV2Release    = "enclave-custody-release-v2\n"
	infoV2KDF          = "enclave-custody-v2 key"
	infoV2Partial      = "enclave-custody-v2 partial-release"

	// PartialRecordBytes is one partial: u32 k ‖ D_k (33) ‖ c (32) ‖ z (32).
	PartialRecordBytes = 101
	// MaxBundleBytes is the vault's bound on a v2 bundle (EnclaveSecretVaultV2, 24 KiB).
	MaxBundleBytes = 24 * 1024
	// MaxMachinesV2 and MaxSeatsV2 bound a v2 committee (custody/v2/protocol.mjs).
	MaxMachinesV2 = seats.MaxMachines
	MaxSeatsV2    = seats.MaxSeats
	// minBundleBytes: R (33) ‖ c (32) ‖ z (32) ‖ nonce (12) ‖ GCM tag (16).
	minBundleBytes = 33 + 64 + 12 + 16
)

// ---- scalars and points ----

// HashToScalar is int(SHA-512(parts...)) mod q.
func HashToScalar(parts ...[]byte) *secp256k1.ModNScalar {
	h := sha512.Sum512(cat(parts...))
	n := new(big.Int).Mod(new(big.Int).SetBytes(h[:]), order)
	return modN(n)
}

func modN(n *big.Int) *secp256k1.ModNScalar {
	var b [32]byte
	new(big.Int).Mod(n, order).FillBytes(b[:])
	var s secp256k1.ModNScalar
	s.SetBytes(&b)
	return &s
}

// scalarV2 is a 32-byte big-endian scalar in [1, q): a value >= q is refused, never reduced, and so is zero (the
// reference's base multiplication refuses 0, and no honest proof carries it).
func scalarV2(b []byte, what string) (*secp256k1.ModNScalar, error) {
	if len(b) != 32 {
		return nil, fmt.Errorf("%s: 32 bytes", what)
	}
	var a [32]byte
	copy(a[:], b)
	var s secp256k1.ModNScalar
	if s.SetBytes(&a) != 0 {
		return nil, fmt.Errorf("%s: out of range", what)
	}
	if s.IsZero() {
		return nil, fmt.Errorf("%s: zero", what)
	}
	return &s, nil
}

// Point is a secp256k1 point (Jacobian). PointOf never returns the identity.
type Point = secp256k1.JacobianPoint

type point = Point

func isIdentity(p *point) bool {
	x, y, z := p.X, p.Y, p.Z
	x.Normalize()
	y.Normalize()
	z.Normalize()
	return (x.IsZero() && y.IsZero()) || z.IsZero()
}

// PointOf parses a 33-byte compressed point (0x02/0x03 prefix, on the curve). The identity has no such encoding.
func PointOf(b []byte, what string) (*point, error) {
	if len(b) != PointBytes || (b[0] != 0x02 && b[0] != 0x03) {
		return nil, fmt.Errorf("%s: not a 33-byte compressed point", what)
	}
	pk, err := secp256k1.ParsePubKey(b)
	if err != nil {
		return nil, fmt.Errorf("%s: not a curve point", what)
	}
	var p point
	pk.AsJacobian(&p)
	return &p, nil
}

// PointBytesOf is the 33-byte compressed encoding; the identity has none and is refused.
func PointBytesOf(p *point) ([]byte, error) {
	if isIdentity(p) {
		return nil, errors.New("the identity point")
	}
	a := *p
	a.ToAffine()
	return secp256k1.NewPublicKey(&a.X, &a.Y).SerializeCompressed(), nil
}

func mulG(s *secp256k1.ModNScalar) *point {
	var r point
	secp256k1.ScalarBaseMultNonConst(s, &r)
	return &r
}

func mul(p *point, s *secp256k1.ModNScalar) *point {
	var r point
	secp256k1.ScalarMultNonConst(s, p, &r)
	return &r
}

func add(a, b *point) *point {
	var r point
	secp256k1.AddNonConst(a, b, &r)
	return &r
}

// sub is a - s·b
func subMul(a, b *point, s *secp256k1.ModNScalar) *point {
	var neg secp256k1.ModNScalar
	neg.NegateVal(s)
	return add(a, mul(b, &neg))
}

func pointsEqual(a, b *point) bool {
	ab, err1 := PointBytesOf(a)
	bb, err2 := PointBytesOf(b)
	return err1 == nil && err2 == nil && string(ab) == string(bb)
}

// PublicShare is Y_k = Σ_j C_j·k^j from the commitments alone; an identity result is refused.
func PublicShare(k uint32, commitments [][]byte) (*point, error) {
	if k < 1 || k > 2*MaxSeatsV2 {
		return nil, errors.New("bad share index")
	}
	if len(commitments) == 0 {
		return nil, errors.New("no commitments")
	}
	var acc point // the identity
	var kp secp256k1.ModNScalar
	kp.SetInt(1)
	var ks secp256k1.ModNScalar
	ks.SetInt(k)
	for j, c := range commitments {
		C, err := PointOf(c, fmt.Sprintf("commitment %d", j))
		if err != nil {
			return nil, err
		}
		acc = *add(&acc, mul(C, &kp))
		kp.Mul(&ks)
	}
	if isIdentity(&acc) {
		return nil, fmt.Errorf("public share %d is the identity", k)
	}
	return &acc, nil
}

// lagrangeAt0 is λ_k(T) at 0 over the index set T.
func lagrangeAt0(k uint32, set []uint32) (*secp256k1.ModNScalar, error) {
	num, den := big.NewInt(1), big.NewInt(1)
	for _, m := range set {
		if m == k {
			continue
		}
		num.Mod(num.Mul(num, big.NewInt(int64(m))), order)
		den.Mod(den.Mul(den, big.NewInt(int64(m)-int64(k))), order)
	}
	inv := new(big.Int).ModInverse(den, order)
	if inv == nil {
		return nil, errors.New("no inverse")
	}
	return modN(num.Mul(num, inv)), nil
}

// ---- seats ----

// SeatLayout is custody/v2/protocol.mjs seatLayout over the machines' Enclave flags, in machine order.
func SeatLayout(enclave []bool) (*seats.Layout, error) { return seats.Of(enclave) }

// ---- label, challenges, binding ----

// LabelInput names one bundle.
type LabelInput struct {
	Ctx         Context
	ID          [32]byte
	SecretRev   uint64
	CommitteeID [32]byte
}

// LabelOf is SHA-256(LABEL ‖ u64 chainId ‖ vault ‖ id ‖ u64 secretRev ‖ committeeId).
func LabelOf(in LabelInput) [32]byte {
	return sum([]byte(domainV2Label), in.Ctx.bytes(), in.ID[:], u64(in.SecretRev), in.CommitteeID[:])
}

// ChallengeRootV2 commits to every challenge a v2 release carries, sorted by custodian key; duplicates are refused.
func ChallengeRootV2(ch []Challenge) ([32]byte, error) {
	if len(ch) == 0 || len(ch) > MaxMachinesV2 {
		return [32]byte{}, fmt.Errorf("challenges: 1..%d entries", MaxMachinesV2)
	}
	rows := append([]Challenge(nil), ch...)
	sort.Slice(rows, func(i, j int) bool { return string(rows[i].EncKey[:]) < string(rows[j].EncKey[:]) })
	parts := [][]byte{[]byte(domainV2Challenges), u32(uint32(len(rows)))}
	for i, r := range rows {
		if i > 0 && r.EncKey == rows[i-1].EncKey {
			return [32]byte{}, errors.New("challenges: duplicate custodian")
		}
		parts = append(parts, r.EncKey[:], r.Nonce[:])
	}
	return sum(parts...), nil
}

// BindingInputV2 is everything report_data[0:32] commits to for one v2 release.
type BindingInputV2 struct {
	Ctx           Context
	ID            [32]byte
	PolicyRev     uint64
	SecretRev     uint64
	CommitteeID   [32]byte
	Epoch         uint32
	Challenges    []Challenge
	RuntimeID     [32]byte
	TransportSPKI []byte
	RecipientKey  [32]byte
}

// BindingV2 is report_data[0:32] of a v2 custody release report.
func BindingV2(in BindingInputV2) ([32]byte, error) {
	if len(in.TransportSPKI) < 32 {
		return [32]byte{}, errors.New("the transport key must be a DER SPKI")
	}
	root, err := ChallengeRootV2(in.Challenges)
	if err != nil {
		return [32]byte{}, err
	}
	spki := sha256.Sum256(in.TransportSPKI)
	return sum([]byte(domainV2Release), in.Ctx.bytes(), in.ID[:], u64(in.PolicyRev), u64(in.SecretRev), in.CommitteeID[:],
		u32(in.Epoch), root[:], in.RuntimeID[:], spki[:], in.RecipientKey[:]), nil
}

// OperatorMessageV2 is what the lease holder's operator signs (personal_sign) for one v2 release (the supervisor signs it;
// the guest never does). Kept here so the two halves can be tested against one definition.
func OperatorMessageV2(c Context, id [32]byte, endpoint string, binding [32]byte, expiry int64) string {
	return fmt.Sprintf("enclave-custody-release-v2:%d:0x%s:0x%s:%s:%s:%d", c.ChainID, hex.EncodeToString(c.Vault[:]), hex.EncodeToString(id[:]),
		endpoint, hex.EncodeToString(binding[:]), expiry)
}

// ---- the bundle ----

// BundleV2 is a parsed v2 bundle: R ‖ proof (c ‖ z) ‖ nonce ‖ ciphertext. Shape only.
type BundleV2 struct {
	R      *point
	c, z   *secp256k1.ModNScalar
	Sealed []byte // nonce (12) ‖ AES-256-GCM ciphertext
}

// ParseBundleV2 parses a bundle's shape: R a curve point, c and z in range.
func ParseBundleV2(b []byte) (*BundleV2, error) {
	if len(b) < minBundleBytes {
		return nil, errors.New("bundle too short")
	}
	if len(b) > MaxBundleBytes {
		return nil, errors.New("bundle too long")
	}
	R, err := PointOf(b[:33], "bundle R")
	if err != nil {
		return nil, err
	}
	c, err := scalarV2(b[33:65], "proof c")
	if err != nil {
		return nil, err
	}
	z, err := scalarV2(b[65:97], "proof z")
	if err != nil {
		return nil, err
	}
	return &BundleV2{R: R, c: c, z: z, Sealed: b[97:]}, nil
}

// VerifyLabelProof checks the bundle's Schnorr proof of knowledge of r against label: the custodians answer only a bundle
// whose proof names this deployment, and the guest checks the same before it asks.
func VerifyLabelProof(bundle []byte, label [32]byte) bool {
	p, err := ParseBundleV2(bundle)
	if err != nil {
		return false
	}
	A := subMul(mulG(p.z), p.R, p.c)
	ab, err := PointBytesOf(A)
	if err != nil {
		return false
	}
	rb, _ := PointBytesOf(p.R)
	return HashToScalar([]byte(domainV2POK), label[:], rb, ab).Equals(p.c)
}

// DecryptBundleV2 derives K = HKDF-SHA256(ikm = S (33), salt = label, info "enclave-custody-v2 key") and opens the
// AES-256-GCM ciphertext under aad = label; the plaintext is {"v":2,"env":{...},"configSha256":"<hex>"}.
func DecryptBundleV2(S *point, label [32]byte, bundle []byte) (*Bundle, error) {
	p, err := ParseBundleV2(bundle)
	if err != nil {
		return nil, err
	}
	sb, err := PointBytesOf(S)
	if err != nil {
		return nil, err
	}
	k, err := hkdf.Key(sha256.New, sb, label[:], infoV2KDF, 32)
	if err != nil {
		return nil, err
	}
	defer clear(k)
	blk, err := aes.NewCipher(k)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(blk)
	if err != nil {
		return nil, err
	}
	pt, err := g.Open(nil, p.Sealed[:12], p.Sealed[12:], label[:])
	if err != nil {
		return nil, errors.New("the bundle does not open under the combined key")
	}
	defer clear(pt)
	var o struct {
		V            *int              `json:"v"`
		Env          map[string]string `json:"env"`
		ConfigSha256 string            `json:"configSha256"`
	}
	if err := json.Unmarshal(pt, &o); err != nil {
		return nil, fmt.Errorf("bundle plaintext: %w", err)
	}
	if o.V == nil || *o.V != 2 {
		return nil, errors.New("unknown bundle version")
	}
	if !hex64.MatchString(o.ConfigSha256) {
		return nil, errors.New("the bundle commits no config")
	}
	if o.Env == nil {
		return nil, errors.New("env must be an object of NAME: value")
	}
	if err := CheckEnv(o.Env); err != nil {
		return nil, err
	}
	return &Bundle{Env: o.Env, ConfigSha256: o.ConfigSha256}, nil
}

// ---- partials ----

// Partial is one verified partial decryption D_k = x_k·R.
type Partial struct {
	K uint32
	D *point
}

// VerifyPartial checks one 101-byte record's DLEQ proof (log_G Y_k = log_R D_k) against Y_k from the commitments, under
// this release's binding. Identity points and out-of-range scalars are refused.
func VerifyPartial(record []byte, R *point, binding [32]byte, commitments [][]byte) (Partial, error) {
	if len(record) != PartialRecordBytes {
		return Partial{}, errors.New("partial: 101 bytes")
	}
	k := binary.BigEndian.Uint32(record[:4])
	D, err := PointOf(record[4:37], "partial D")
	if err != nil {
		return Partial{}, err
	}
	c, err := scalarV2(record[37:69], "partial c")
	if err != nil {
		return Partial{}, err
	}
	z, err := scalarV2(record[69:101], "partial z")
	if err != nil {
		return Partial{}, err
	}
	Yk, err := PublicShare(k, commitments)
	if err != nil {
		return Partial{}, err
	}
	A1 := subMul(mulG(z), Yk, c)
	A2 := subMul(mul(R, z), D, c)
	var enc [5][]byte
	for i, p := range []*point{Yk, R, D, A1, A2} {
		if enc[i], err = PointBytesOf(p); err != nil {
			return Partial{}, fmt.Errorf("partial for index %d: the proof does not verify", k)
		}
	}
	c2 := HashToScalar([]byte(domainV2DLEQ), binding[:], u32(k), enc[0], enc[1], enc[2], enc[3], enc[4])
	if !c2.Equals(c) {
		return Partial{}, fmt.Errorf("partial for index %d: the proof does not verify", k)
	}
	return Partial{K: k, D: D}, nil
}

// PartialAAD is SHA-256(PARTIAL ‖ binding ‖ memberEncKey ‖ u32 count).
func PartialAAD(binding, encKey [32]byte, count int) []byte {
	a := sum([]byte(domainV2Partial), binding[:], encKey[:], u32(uint32(count)))
	return a[:]
}

// OpenPartials opens one member's answer (HPKE to the recipient key under PARTIAL_INFO) into exactly count records.
func OpenPartials(sk *ecdh.PrivateKey, binding, encKey [32]byte, count int, sealed []byte) ([][]byte, error) {
	if count < 1 || count > 2*MaxSeatsV2 {
		return nil, errors.New("partials: bad count")
	}
	pt, err := Open(sk, []byte(infoV2Partial), PartialAAD(binding, encKey, count), sealed)
	if err != nil {
		return nil, err
	}
	if len(pt) != count*PartialRecordBytes {
		return nil, errors.New("partials: wrong length")
	}
	out := make([][]byte, count)
	for i := range out {
		out[i] = pt[i*PartialRecordBytes : (i+1)*PartialRecordBytes]
	}
	return out, nil
}

// Combine is S = Σ λ_k(T)·D_k over EXACTLY t verified partials with distinct indices.
func Combine(ps []Partial, t int) (*point, error) {
	if t < 1 || len(ps) != t {
		return nil, fmt.Errorf("combine: exactly %d distinct share indices", t)
	}
	ks := make([]uint32, len(ps))
	seen := map[uint32]bool{}
	for i, p := range ps {
		if seen[p.K] || p.D == nil {
			return nil, fmt.Errorf("combine: exactly %d distinct share indices", t)
		}
		seen[p.K] = true
		ks[i] = p.K
	}
	var S point
	for _, p := range ps {
		l, err := lagrangeAt0(p.K, ks)
		if err != nil {
			return nil, err
		}
		S = *add(&S, mul(p.D, l))
	}
	if isIdentity(&S) {
		return nil, errors.New("combine: identity")
	}
	return &S, nil
}

// SplitCommitmentsV2 splits a v2 pointer's commitments (t x 33 bytes), each checked to be a curve point.
func SplitCommitmentsV2(b []byte, t int) ([][]byte, error) {
	if t < 1 || len(b) != t*PointBytes {
		return nil, fmt.Errorf("commitments: %d x 33 bytes", t)
	}
	out := make([][]byte, t)
	for j := range out {
		out[j] = b[j*PointBytes : (j+1)*PointBytes]
		if _, err := PointOf(out[j], fmt.Sprintf("commitment %d", j)); err != nil {
			return nil, err
		}
	}
	return out, nil
}
