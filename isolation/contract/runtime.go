package contract

import (
	"crypto/sha256"
	"errors"
	"fmt"
)

// The runtime that compiles and runs the artifact INSIDE the domain (decided 2026-09-23): the app is
// distributed as a portable WebAssembly component and JIT-compiled to the domain's own ISA after the
// bundle is verified. What that runtime is, and how it is configured, is part of what a report vouches
// for: two domains running the same bundle on different runtimes, ISAs or CPU-feature policies are
// different things to a verifier.
//
// Requirements this type encodes (fail closed: an identity that cannot state them is refused):
//   - the JIT and runtime execute inside the protected, measured boundary;
//   - W^X: no page is ever both writable and executable (WX must say "enforced");
//   - no host-supplied native code and no unverified compiled cache: Cache is "none" (compile every
//     time) or "authenticated" (a cache keyed by CacheKey and authenticated under a domain-held key);
//   - the runtime name, version, target ISA and CPU-feature policy are bound into the report via Bind2.
type RuntimeIdentity struct {
	Name        string `json:"name"`        // e.g. "wasmtime"
	Version     string `json:"version"`     // e.g. "48.0.1"
	TargetISA   string `json:"targetIsa"`   // "x86_64" | "aarch64": the ISA the JIT emits inside the domain
	CPUFeatures string `json:"cpuFeatures"` // the JIT's enabled feature policy, a canonical string ("baseline", or "+sse4.2,+avx2", ...)
	WX          string `json:"wx"`          // "enforced"
	Cache       string `json:"cache"`       // "none" | "authenticated"
}

const (
	ABI2 = "enclave-domain-abi/2" // ABI with the runtime identity bound into the report

	ISAx86_64  = "x86_64"
	ISAaarch64 = "aarch64"

	WXEnforced         = "enforced"
	CacheNone          = "none"
	CacheAuthenticated = "authenticated"
)

var bind2Domain = []byte("enclave-bind-v2\n")
var cacheKeyDomain = []byte("enclave-compiled-cache-v1\n")

// Validate refuses an identity that does not meet the requirements above.
func (r RuntimeIdentity) Validate() error {
	if r.Name == "" || r.Version == "" {
		return errors.New("runtime name and version are required")
	}
	if r.TargetISA != ISAx86_64 && r.TargetISA != ISAaarch64 {
		return fmt.Errorf("target ISA %q is not one of %s, %s", r.TargetISA, ISAx86_64, ISAaarch64)
	}
	if r.CPUFeatures == "" {
		return errors.New("the CPU-feature policy must be stated (\"baseline\" if none)")
	}
	if r.WX != WXEnforced {
		return errors.New("a runtime that cannot state W^X as enforced is not admissible")
	}
	if r.Cache != CacheNone && r.Cache != CacheAuthenticated {
		return fmt.Errorf("cache mode %q is not one of %s, %s", r.Cache, CacheNone, CacheAuthenticated)
	}
	return nil
}

// RuntimeID is the identity's digest: sha256 of its canonical JSON. Same fields, same ID, whatever
// encoder wrote them.
func RuntimeID(r RuntimeIdentity) ([32]byte, error) {
	if err := r.Validate(); err != nil {
		return [32]byte{}, err
	}
	b, err := Canonical(r)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(b), nil
}

// Bind2 is the ABI/2 binding: the domain's key, the verifier's nonce AND the runtime identity, in one
// 32-byte value for report_data[0:32]. report_data[32:64] stays the app ID. A verifier recomputes it
// from the SPKI its own handshake saw, its own nonce, and the runtime identity the domain states in its
// attestation document; a document naming a different runtime, version, ISA or feature policy than the
// one that asked for the report does not verify.
func Bind2(spki, nonce []byte, runtimeID [32]byte) ([32]byte, error) {
	if len(nonce) != NonceLen {
		return [32]byte{}, ErrNonceLen
	}
	h := sha256.New()
	h.Write(bind2Domain)
	h.Write(spki)
	h.Write(nonce)
	h.Write(runtimeID[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}

// CacheKey names a compiled artifact a domain may keep: the bundle's identity and the runtime identity
// (which includes the target ISA and the CPU-feature policy) together. A cache entry under any other key,
// or one that fails its authentication, is rebuilt inside the domain rather than used.
func CacheKey(appID, runtimeID [32]byte) [32]byte {
	h := sha256.New()
	h.Write(cacheKeyDomain)
	h.Write(appID[:])
	h.Write(runtimeID[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}
