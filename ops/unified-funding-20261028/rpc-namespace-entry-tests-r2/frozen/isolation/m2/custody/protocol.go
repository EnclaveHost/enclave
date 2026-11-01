package custody

// The custody formats (custody/protocol.mjs is the reference; testdata/vectors.json pins both). Every hash is SHA-256 over a
// domain line and fixed-width fields.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	domainDEK        = "enclave-custody-v1 dek\n"
	domainBundle     = "enclave-custody-v1 bundle\n"
	domainChallenges = "enclave-custody-v1 challenges\n"
	domainRelease    = "enclave-custody-release-v1\n"
	domainResponse   = "enclave-custody-v1 response\n"
	infoRelease      = "enclave-custody-v1 share-release"

	// SealedShareBytes is one HPKE-sealed 32-byte scalar: enc(32) + 32 + tag(16).
	SealedShareBytes = 80
	// PointBytes is one compressed secp256k1 commitment.
	PointBytes = 33
	// MaxMembers bounds a committee (EnclaveSecretVault.MAX_MEMBERS).
	MaxMembers = 32
)

// Context names one vault on one chain.
type Context struct {
	ChainID uint64
	Vault   [20]byte
}

func (c Context) bytes() []byte {
	b := make([]byte, 28)
	binary.BigEndian.PutUint64(b, c.ChainID)
	copy(b[8:], c.Vault[:])
	return b
}

func u64(n uint64) []byte          { var b [8]byte; binary.BigEndian.PutUint64(b[:], n); return b[:] }
func u32(n uint32) []byte          { var b [4]byte; binary.BigEndian.PutUint32(b[:], n); return b[:] }
func sum(parts ...[]byte) [32]byte { return sha256.Sum256(cat(parts...)) }

// Challenge is one custodian's fresh nonce, named by the custodian's share key.
type Challenge struct {
	EncKey [32]byte
	Nonce  [32]byte
}

// ChallengeRoot commits to every challenge a release request carries, sorted by custodian key; duplicates are refused.
func ChallengeRoot(ch []Challenge) ([32]byte, error) {
	if len(ch) == 0 || len(ch) > MaxMembers {
		return [32]byte{}, errors.New("challenges: 1..32 entries")
	}
	rows := append([]Challenge(nil), ch...)
	sort.Slice(rows, func(i, j int) bool {
		return hex.EncodeToString(rows[i].EncKey[:]) < hex.EncodeToString(rows[j].EncKey[:])
	})
	parts := [][]byte{[]byte(domainChallenges), {byte(len(rows))}}
	for i, r := range rows {
		if i > 0 && r.EncKey == rows[i-1].EncKey {
			return [32]byte{}, errors.New("challenges: duplicate custodian")
		}
		parts = append(parts, r.EncKey[:], r.Nonce[:])
	}
	return sum(parts...), nil
}

// BindingInput is everything report_data[0:32] commits to for one release.
type BindingInput struct {
	Ctx           Context
	ID            [32]byte
	PolicyRev     uint64
	SecretRev     uint64
	Epoch         uint32
	Challenges    []Challenge
	RuntimeID     [32]byte
	TransportSPKI []byte
	RecipientKey  [32]byte
}

// Binding is report_data[0:32] of a custody release report.
func Binding(in BindingInput) ([32]byte, error) {
	if len(in.TransportSPKI) < 32 {
		return [32]byte{}, errors.New("the transport key must be a DER SPKI")
	}
	root, err := ChallengeRoot(in.Challenges)
	if err != nil {
		return [32]byte{}, err
	}
	spki := sha256.Sum256(in.TransportSPKI)
	return sum([]byte(domainRelease), in.Ctx.bytes(), in.ID[:], u64(in.PolicyRev), u64(in.SecretRev), u32(in.Epoch),
		root[:], in.RuntimeID[:], spki[:], in.RecipientKey[:]), nil
}

// OperatorMessage is what the lease holder's registered operator signs (personal_sign) to authorize one release.
func OperatorMessage(c Context, id [32]byte, endpoint string, binding [32]byte, expiry int64) string {
	return fmt.Sprintf("enclave-custody-release-v1:%d:0x%s:0x%s:%s:%s:%d", c.ChainID, hex.EncodeToString(c.Vault[:]), hex.EncodeToString(id[:]),
		endpoint, hex.EncodeToString(binding[:]), expiry)
}

func responseAAD(binding, encKey [32]byte, index int) []byte {
	a := sum([]byte(domainResponse), binding[:], encKey[:], []byte{byte(index)})
	return a[:]
}

// secp256k1's group order: the Shamir field (custody/threshold.mjs)
var order, _ = new(big.Int).SetString("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141", 16)

func scalar(b []byte) (*big.Int, error) {
	if len(b) != 32 {
		return nil, errors.New("a scalar is 32 bytes")
	}
	s := new(big.Int).SetBytes(b)
	if s.Sign() == 0 || s.Cmp(order) >= 0 {
		return nil, errors.New("scalar out of range")
	}
	return s, nil
}

func scalarBytes(s *big.Int) []byte { out := make([]byte, 32); s.FillBytes(out); return out }

// DeriveDEK: HKDF-SHA256(ikm = s, salt = sha256(DEK ‖ context ‖ id ‖ u64 secretRev), info "dek").
func DeriveDEK(s *big.Int, c Context, id [32]byte, secretRev uint64) ([]byte, error) {
	salt := sum([]byte(domainDEK), c.bytes(), id[:], u64(secretRev))
	return hkdf.Key(sha256.New, scalarBytes(s), salt[:], "dek", 32)
}

// BundleAAD binds the ciphertext to its vault, deployment, revision and C0 (invariant across reshares).
func BundleAAD(c Context, id [32]byte, secretRev uint64, c0 []byte) ([]byte, error) {
	if len(c0) != PointBytes {
		return nil, errors.New("C0 must be a 33-byte point")
	}
	a := sum([]byte(domainBundle), c.bytes(), id[:], u64(secretRev), c0)
	return a[:], nil
}

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// Bundle is what an opened bundle holds: the env map, and the sha256 (hex) of the ONLY config text its values may be
// substituted into, committed by the owner (custody/protocol.mjs configSha256; review H2).
type Bundle struct {
	Env          map[string]string
	ConfigSha256 string
}

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// DecryptBundle opens nonce(12) ‖ AES-256-GCM and checks the env map against the same limits as the relay and the owner.
func DecryptBundle(dek, aad, blob []byte) (*Bundle, error) {
	if len(blob) < 12+16 {
		return nil, errors.New("bundle too short")
	}
	b, err := aes.NewCipher(dek)
	if err != nil {
		return nil, err
	}
	g, err := cipher.NewGCM(b)
	if err != nil {
		return nil, err
	}
	pt, err := g.Open(nil, blob[:12], blob[12:], aad)
	if err != nil {
		return nil, err
	}
	var o struct {
		V            int               `json:"v"`
		Env          map[string]string `json:"env"`
		ConfigSha256 string            `json:"configSha256"`
	}
	if err := json.Unmarshal(pt, &o); err != nil {
		return nil, fmt.Errorf("bundle plaintext: %w", err)
	}
	if o.V != 1 {
		return nil, errors.New("unknown bundle version")
	}
	if !hex64.MatchString(o.ConfigSha256) {
		return nil, errors.New("the bundle commits no config")
	}
	if err := CheckEnv(o.Env); err != nil {
		return nil, err
	}
	return &Bundle{Env: o.Env, ConfigSha256: o.ConfigSha256}, nil
}

// CheckEnv is custody/protocol.mjs checkEnv.
func CheckEnv(env map[string]string) error {
	if len(env) > 64 {
		return errors.New("too many secrets (max 64)")
	}
	total := 0
	for k, v := range env {
		if !envName.MatchString(k) {
			return fmt.Errorf("%q is not an env-var name", k)
		}
		if strings.HasPrefix(strings.ToUpper(k), "ENCLAVE_") {
			return fmt.Errorf("%q: the ENCLAVE_ prefix is reserved", k)
		}
		if !utf8.ValidString(v) || strings.ContainsAny(v, "\x00\r\n") || len(v) > 4096 {
			return fmt.Errorf("%q is not a single-line value of at most 4096 bytes", k)
		}
		total += len(k) + len(v)
	}
	if total > 16384 {
		return fmt.Errorf("secrets total %d bytes (max 16384)", total)
	}
	return nil
}
