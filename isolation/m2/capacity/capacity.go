// Package capacity is a host's proof key and its answer to a capacity check, INSIDE a domain.
//
// On a confidential server the host's supervisor runs in the confidential VM and makes its proof key there. On an
// Enclave Shield host the supervisor is a process of the host OS, so a proof key it holds is a file of the host, and an
// answer to a capacity check (network/proof-of-capacity-host.mjs) is the host's own word about the host's own work.
// This package moves both into a partition: a secp256k1 key made in the front's memory and never written anywhere, the
// measured work run here, and the answer signed here. The key signs:
//
//   - a CapacityAnswer, only over a digest this code computed itself from the challenge, so no signature exists for
//     work that was not done in this partition;
//   - the other messages a host's proof key signs (its reports on other hosts, its own proof, its proofs of time, the
//     challenges it sends), as fixed types assembled here from their fields. This code does not judge them: it cannot
//     know whether the host served an app or checked a peer. What it adds is that only a running partition of this
//     image, on this boot of this machine, can have signed them. It never signs a caller's digest, and never a
//     CapacityAnswer by this path.
//
// The work and the messages are the ones network/proof-of-capacity-host.mjs and network/proof-of-capacity.mjs define,
// bit for bit (testdata/vectors.json is produced by that code and checked here).
package capacity

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"sync"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
)

// The bounds of one challenge (CHECK_LIMITS in proof-of-capacity-host.mjs).
const (
	MaxRounds    = 2000000
	MaxMemoryMiB = 256
	MaxLanes     = 64
	MaxTotalMiB  = 4096
	mib          = 1 << 20
)

// Work is one lane: memoryMiB filled from the seed, then mixed for `rounds` rounds.
func Work(seed [32]byte, rounds, memoryMiB int) ([32]byte, error) {
	if rounds < 1 || rounds > MaxRounds || memoryMiB < 1 || memoryMiB > MaxMemoryMiB {
		return [32]byte{}, errors.New("rounds or memory out of bounds")
	}
	size := uint64(memoryMiB) * mib
	buf := make([]byte, size)
	var index [4]byte
	for i := 0; i < memoryMiB; i++ { // every MiB filled from the seed and its own number
		binary.BigEndian.PutUint32(index[:], uint32(i))
		h := sha256.New()
		h.Write(seed[:])
		h.Write(index[:])
		block := h.Sum(nil)
		for o, end := i*mib, (i+1)*mib; o < end; o += 32 {
			copy(buf[o:], block)
		}
	}
	state := sha256.Sum256(seed[:])
	for r := 0; r < rounds; r++ { // each round reads 4 KiB where the state points and writes the new state back
		at := (uint64(binary.BigEndian.Uint32(state[0:4])) * 4096) % (size - 4096)
		h := sha256.New()
		h.Write(state[:])
		h.Write(buf[at : at+4096])
		h.Sum(state[:0])
		copy(buf[(uint64(binary.BigEndian.Uint32(state[4:8]))*32)%(size-32):], state[:])
	}
	return state, nil
}

// Lanes is the same work in `lanes` lanes at once, each on its own seed and its own memory: the digest over the lanes'
// digests, in order. The lanes run side by side on as many processors as this domain has.
func Lanes(seed [32]byte, rounds, memoryMiB, lanes int) ([32]byte, error) {
	if lanes < 1 || lanes > MaxLanes || lanes*memoryMiB > MaxTotalMiB {
		return [32]byte{}, errors.New("lanes out of bounds")
	}
	digests := make([][32]byte, lanes)
	errs := make([]error, lanes)
	var wg sync.WaitGroup
	for i := 0; i < lanes; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			h := sha256.New()
			h.Write(seed[:])
			h.Write([]byte{byte(i >> 8), byte(i)})
			var laneSeed [32]byte
			h.Sum(laneSeed[:0])
			digests[i], errs[i] = Work(laneSeed, rounds, memoryMiB)
		}(i)
	}
	wg.Wait()
	h := sha256.New()
	for i := range digests {
		if errs[i] != nil {
			return [32]byte{}, errs[i]
		}
		h.Write(digests[i][:])
	}
	var out [32]byte
	h.Sum(out[:0])
	return out, nil
}

// WorkSeed is the seed the work runs on: the challenge's nonce under the epoch's seed.
func WorkSeed(epochSeed, nonce [32]byte) [32]byte {
	return sha256.Sum256(append(append([]byte{}, epochSeed[:]...), nonce[:]...))
}

// ---- EIP-712, for the fixed messages of EnclaveProofOfCapacity ------------------------------------------------------------

func keccak(parts ...[]byte) [32]byte {
	var all []byte
	for _, p := range parts {
		all = append(all, p...)
	}
	return keccak256(all)
}

// Domain is the contract a message is for. Its name and version are the contract's, fixed.
type Domain struct {
	ChainID  uint64
	Contract [20]byte
}

func (d Domain) separator() [32]byte {
	typeHash := keccak([]byte("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"))
	name, version := keccak([]byte("EnclaveProofOfCapacity")), keccak([]byte("1"))
	var chain, addr [32]byte
	binary.BigEndian.PutUint64(chain[24:], d.ChainID)
	copy(addr[12:], d.Contract[:])
	return keccak(typeHash[:], name[:], version[:], chain[:], addr[:])
}

type field struct{ name, typ string }

// The messages, exactly as proof-of-capacity.mjs and proof-of-capacity-host.mjs type them.
var messages = map[string][]field{
	"CapacityAnswer":    {{"epoch", "uint64"}, {"checker", "bytes32"}, {"target", "bytes32"}, {"nonce", "bytes32"}, {"digest", "bytes32"}},
	"CapacityChallenge": {{"epoch", "uint64"}, {"checker", "bytes32"}, {"target", "bytes32"}, {"seed", "bytes32"}, {"nonce", "bytes32"}, {"rounds", "uint32"}, {"memoryMiB", "uint32"}, {"lanes", "uint32"}},
	"CapacityReport":    {{"epoch", "uint64"}, {"checker", "bytes32"}, {"target", "bytes32"}, {"verdict", "uint8"}, {"seed", "bytes32"}, {"evidence", "bytes32"}},
	"CapacitySelf":      {{"epoch", "uint64"}, {"host", "bytes32"}, {"anchorBlock", "uint64"}, {"anchorHash", "bytes32"}, {"evidence", "bytes32"}},
	"ProofOfTime":       {{"id", "bytes32"}, {"enclaveId", "bytes32"}, {"operator", "address"}, {"upto", "uint64"}, {"anchorBlock", "uint64"}, {"anchorHash", "bytes32"}},
	"CardChallenge":     {{"epoch", "uint64"}, {"checker", "bytes32"}, {"target", "bytes32"}, {"seed", "bytes32"}, {"nonce", "bytes32"}, {"card", "uint32"}, {"k", "uint32"}, {"batch", "uint32"}, {"rounds", "uint32"}, {"stride", "uint32"}},
	// The answer for a card (proof-of-capacity-card.mjs). The card is the host's, outside this partition: the
	// signature says the holder of this host's proof key passed that root on, and the checker's opening says the rest.
	"CardAnswer": {{"epoch", "uint64"}, {"checker", "bytes32"}, {"target", "bytes32"}, {"nonce", "bytes32"}, {"run", "bytes32"}, {"root", "bytes32"}},
}

// Signable are the messages SignMessage takes: every one but the answer, which only Answer signs.
func Signable(primaryType string) bool {
	_, ok := messages[primaryType]
	return ok && primaryType != "CapacityAnswer"
}

func word(typ, value string) ([32]byte, error) {
	var w [32]byte
	switch typ {
	case "bytes32", "address":
		n := map[string]int{"bytes32": 32, "address": 20}[typ]
		b, err := hex.DecodeString(strings.TrimPrefix(value, "0x"))
		if err != nil || len(b) != n || !strings.HasPrefix(value, "0x") {
			return w, fmt.Errorf("not %s", typ)
		}
		copy(w[32-n:], b)
	case "uint8", "uint32", "uint64":
		v, ok := new(big.Int).SetString(value, 10)
		bits := map[string]uint{"uint8": 8, "uint32": 32, "uint64": 64}[typ]
		if !ok || v.Sign() < 0 || v.BitLen() > int(bits) || (len(value) > 1 && value[0] == '0') {
			return w, fmt.Errorf("not %s", typ)
		}
		v.FillBytes(w[:])
	default:
		return w, errors.New("unsupported type")
	}
	return w, nil
}

// Digest is the EIP-712 digest of one of the fixed messages. values: every field of the type and no other; integers in
// decimal, bytes32 and address as 0x hex.
func Digest(d Domain, primaryType string, values map[string]string) ([32]byte, error) {
	fields, ok := messages[primaryType]
	if !ok {
		return [32]byte{}, errors.New("not a message of the capacity contract")
	}
	if len(values) != len(fields) {
		return [32]byte{}, errors.New("a message has exactly its fields")
	}
	sig := make([]string, len(fields))
	for i, f := range fields {
		sig[i] = f.typ + " " + f.name
	}
	typeHash := keccak([]byte(primaryType + "(" + strings.Join(sig, ",") + ")"))
	enc := append([]byte{}, typeHash[:]...)
	for _, f := range fields {
		v, ok := values[f.name]
		if !ok {
			return [32]byte{}, fmt.Errorf("%s: missing", f.name)
		}
		w, err := word(f.typ, v)
		if err != nil {
			return [32]byte{}, fmt.Errorf("%s: %v", f.name, err)
		}
		enc = append(enc, w[:]...)
	}
	structHash, sep := keccak(enc), d.separator()
	return keccak([]byte{0x19, 0x01}, sep[:], structHash[:]), nil
}

// ---- the key ------------------------------------------------------------------------------------------------------------

// Key is a proof key that exists only in this process.
type Key struct{ priv *secp256k1.PrivateKey }

func NewKey() (*Key, error) {
	p, err := secp256k1.GeneratePrivateKey()
	if err != nil {
		return nil, err
	}
	return &Key{p}, nil
}

// KeyFromBytes is for tests: a fixed key gives fixed signatures (RFC 6979).
func KeyFromBytes(b []byte) *Key { return &Key{secp256k1.PrivKeyFromBytes(b)} }

// Address is the key's Ethereum address: what the registry publishes as the host's proof key.
func (k *Key) Address() [20]byte {
	h := keccak(k.priv.PubKey().SerializeUncompressed()[1:])
	var a [20]byte
	copy(a[:], h[12:])
	return a
}

// sign: r || s || v (27 or 28), the form the contract's ecrecover and viem take.
func (k *Key) sign(digest [32]byte) [65]byte {
	c := ecdsa.SignCompact(k.priv, digest[:], false) // v || r || s
	var out [65]byte
	copy(out[:64], c[1:])
	out[64] = c[0]
	return out
}

// SignMessage signs one of the Signable messages, assembled here from its fields.
func (k *Key) SignMessage(d Domain, primaryType string, values map[string]string) ([65]byte, error) {
	if !Signable(primaryType) {
		return [65]byte{}, errors.New("this key does not sign that message here")
	}
	digest, err := Digest(d, primaryType, values)
	if err != nil {
		return [65]byte{}, err
	}
	return k.sign(digest), nil
}

// Challenge is a capacity challenge as the host forwards it. Whether the checker may ask is the host's to decide
// (it reads the contract); this code only bounds the work.
type Challenge struct {
	Epoch                    uint64
	Checker, Target          [32]byte
	Seed, Nonce              [32]byte
	Rounds, MemoryMiB, Lanes int
}

// Answer does the work and signs the answer over the digest it computed.
func (k *Key) Answer(d Domain, c Challenge) (digest [32]byte, sig [65]byte, err error) {
	if digest, err = Lanes(WorkSeed(c.Seed, c.Nonce), c.Rounds, c.MemoryMiB, c.Lanes); err != nil {
		return
	}
	hx := func(b [32]byte) string { return "0x" + hex.EncodeToString(b[:]) }
	msg, err := Digest(d, "CapacityAnswer", map[string]string{"epoch": fmt.Sprint(c.Epoch), "checker": hx(c.Checker), "target": hx(c.Target),
		"nonce": hx(c.Nonce), "digest": hx(digest)})
	if err != nil {
		return
	}
	return digest, k.sign(msg), nil
}

// KeyStatement is what the domain's TLS key signs to say "this proof key is mine": the verifier holds a report that
// binds that TLS key to this domain, and with this the proof key to the TLS key. The prefix keeps it apart from
// everything else that key signs (a TLS 1.3 handshake signs under its own 64-space context, a CSR is DER).
func KeyStatement(address [20]byte) []byte {
	return append([]byte("enclave-host-capacity-key/1\n"), address[:]...)
}
