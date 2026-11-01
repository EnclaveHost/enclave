package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"enclave.host/isolation/contract"
)

const RPCContinuationSchema = "enclave-rpc-continuation/1"
const RPCContinuationMaxSeconds int64 = 30

// RPCContinuation describes an off-chain consent, never a new start request.
// Sequence1 links to the EXACT original signed storage proof. Later sequences
// link to the preceding complete signed continuation. Startup cannot transition
// back from serving. Readiness is an observation digest, NOT health evidence:
// the adoption coordinator must verify the actual private/attested observation.
type RPCContinuation struct {
	Schema          string `json:"schema"`
	Phase           string `json:"phase"`
	Sequence        uint64 `json:"sequence"`
	PreviousSHA256  string `json:"previousSha256"`
	ReadinessSHA256 string `json:"readinessSha256"`
	IssuedAt        int64  `json:"issuedAt"`
	NotAfter        int64  `json:"notAfter"`
}

type RPCContinuationSignatures struct {
	Permit RPCContinuation `json:"permit"`
	L1     string          `json:"l1"`
	Base   string          `json:"base"`
}

func (p RPCContinuation) validate() error {
	if p.Schema != RPCContinuationSchema || p.Sequence == 0 || p.Sequence > (1<<53)-1 || !contract.NonzeroHash(p.PreviousSHA256) || p.IssuedAt <= 0 || p.NotAfter <= p.IssuedAt || p.NotAfter-p.IssuedAt > RPCContinuationMaxSeconds {
		return errors.New("invalid bounded RPC continuation")
	}
	switch p.Phase {
	case "startup":
		if p.ReadinessSHA256 != "" {
			return errors.New("startup consent cannot assert readiness")
		}
	case "serving":
		if !contract.NonzeroHash(p.ReadinessSHA256) {
			return errors.New("serving observation binding required")
		}
	default:
		return errors.New("unknown RPC continuation phase")
	}
	return nil
}

// RPCContinuationSigningPayloads returns bytes for the existing owner-selected
// volume keys. It performs no signing, network calls, chain writes, journal
// updates or deadline changes. The owner must durably consume its sequence and
// verify original writer/export authority before signing or returning a proof.
// Existing legacy authorization still bounds consent; this is not a migration
// to the replacement event-driven ledger and never renews a legacy lease.
func (a *Authorization) RPCContinuationSigningPayloads(bundle []byte, c *RPCStorageConsent, p RPCContinuation) ([2][]byte, error) {
	var out [2][]byte
	if c == nil || c.authorization != a || c.export == nil || !contract.NonzeroHash(c.proofSHA256) {
		return out, errors.New("exact original export consent required")
	}
	if err := p.validate(); err != nil {
		return out, err
	}
	base, err := a.RPCExportSigningPayloads(bundle, c.request, c.l1Epoch, c.baseEpoch, *c.export)
	if err != nil {
		return out, err
	}
	now := a.reader.now().Unix()
	if now < p.IssuedAt || now >= p.NotAfter || p.NotAfter > rpcAuthorizationExpiry(a).Unix() {
		return out, errors.New("RPC continuation exceeds current owner authorization")
	}
	initial, _ := hex.DecodeString(c.proofSHA256)
	raw, err := json.Marshal(p)
	if err != nil {
		return out, err
	}
	hash := sha256.Sum256(raw)
	for i := range out {
		out[i] = append([]byte("ENCLAVE-RPC-CONTINUATION/1\x00"), base[i]...)
		out[i] = append(out[i], initial...)
		out[i] = append(out[i], hash[:]...)
	}
	return out, nil
}

func rpcAuthorizationExpiry(a *Authorization) time.Time {
	expires := int64(a.snapshot.row.leaseUntil)
	if fresh := int64(a.snapshot.timestamp) + int64(a.reader.maxAge.Seconds()) + 1; fresh < expires {
		expires = fresh
	}
	return time.Unix(expires, 0)
}

// RPCContinuationConsent has an immutable monotonic deadline. Snapshot refresh
// or a wall-clock rollback cannot extend an accepted permit. It conveys only
// both storage authorities' consent, not adoption/readiness/writer settlement.
type RPCContinuationConsent struct {
	permit RPCContinuation
	digest string
	until  time.Time
}

func (c *RPCContinuationConsent) Permit() RPCContinuation {
	if c == nil {
		return RPCContinuation{}
	}
	return c.permit
}
func (c *RPCContinuationConsent) Digest() string {
	if c == nil {
		return ""
	}
	return c.digest
}
func (c *RPCContinuationConsent) NotAfter() time.Time {
	if c == nil {
		return time.Time{}
	}
	return c.until
}

// RPCContinuationChain is process-local and single-owner. It must be combined
// with the original consumed attempt's persistent journal. A new object/directory
// is not permission to restart an expired actor or replay old signatures.
// The caller serializes Authorization.Revalidate with these methods, as for all
// other Authorization APIs. Failed acceptance permanently poisons this chain.
type RPCContinuationChain struct {
	mu                         sync.Mutex
	consent                    *RPCStorageConsent
	sequence                   uint64
	previous, phase, readiness string
	until                      time.Time
	lastWall                   time.Time
	anchorWall, anchorMono     time.Time
	closed                     bool
}

func (c *RPCStorageConsent) NewContinuationChain() (*RPCContinuationChain, error) {
	if c == nil || c.export == nil || !c.Matches(c.request) || !contract.NonzeroHash(c.proofSHA256) {
		return nil, errors.New("current original export consent required")
	}
	before := time.Now()
	now := c.authorization.reader.now()
	if !now.Before(c.notAfter) {
		return nil, errors.New("original consent expired before continuation attachment")
	}
	return &RPCContinuationChain{consent: c, previous: c.proofSHA256, phase: "startup", until: before.Add(c.notAfter.Sub(now)), lastWall: now, anchorWall: now, anchorMono: before}, nil
}

// Accept verifies BOTH role-separated signatures and exact sequential linkage.
// It neither runs a watchdog nor changes any startup cutoff. Any caller applying
// a serving permit must separately commit the complete handoff before originalD.
func (c *RPCContinuationChain) Accept(bundle, raw []byte) (accepted *RPCContinuationConsent, err error) {
	if c == nil {
		return nil, errors.New("original continuation chain required")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return nil, errors.New("continuation chain closed")
	}
	defer func() {
		if err != nil {
			c.closed = true
		}
	}()
	if len(raw) == 0 || len(raw) > 2048 || !time.Now().Before(c.until) {
		return nil, errors.New("continuation expired or unbounded; no revival")
	}
	var proof RPCContinuationSignatures
	if err = strictJSON(raw, &proof); err != nil {
		return nil, err
	}
	canonical, e := json.Marshal(proof)
	if e != nil || !bytes.Equal(canonical, raw) {
		return nil, errors.New("exact canonical continuation proof required")
	}
	p := proof.Permit
	if p.Sequence != c.sequence+1 || p.PreviousSHA256 != c.previous || c.phase == "serving" && (p.Phase != "serving" || p.ReadinessSHA256 != c.readiness) {
		return nil, errors.New("continuation replay, gap, phase regression or adoption substitution")
	}
	a := c.consent.authorization
	before := time.Now()
	wall := a.reader.now()
	if wall.Before(c.lastWall) {
		return nil, errors.New("continuation wall clock regressed")
	}
	// Anchor wall expiry to one monotonic clock mapping for the whole actor.
	// A slow/frozen clock cannot turn the same absolute expiry into fresh time.
	anchoredNow := c.anchorWall.Add(before.Sub(c.anchorMono)).Unix()
	if p.IssuedAt > anchoredNow || p.NotAfter <= anchoredNow || p.NotAfter-anchoredNow > RPCContinuationMaxSeconds {
		return nil, errors.New("continuation outside original monotonic clock mapping")
	}
	payloads, e := a.RPCContinuationSigningPayloads(bundle, c.consent, p)
	if e != nil {
		return nil, e
	}
	for i, sigHex := range []string{proof.L1, proof.Base} {
		key := a.manifest.RPCStorage.L1.PublicKey
		if i == 1 {
			key = a.manifest.RPCStorage.Base.PublicKey
		}
		sig, e := hex.DecodeString(sigHex)
		pub, _ := hex.DecodeString(key)
		if e != nil || len(sig) != ed25519.SignatureSize || hex.EncodeToString(sig) != sigHex || !ed25519.Verify(ed25519.PublicKey(pub), payloads[i], sig) {
			return nil, errors.New("continuation requires both exact storage authorities")
		}
	}
	until := c.anchorMono.Add(time.Unix(p.NotAfter, 0).Sub(c.anchorWall))
	// Check both the old and proposed monotonic bounds after signature work.
	// Serialization/signature work cannot renew an expired old permit.
	if !a.current() || !time.Now().Before(c.until) || !time.Now().Before(until) {
		return nil, errors.New("authorization expired during continuation verification")
	}
	hash := sha256.Sum256(raw)
	accepted = &RPCContinuationConsent{permit: p, digest: hex.EncodeToString(hash[:]), until: until}
	c.sequence, c.previous, c.phase, c.readiness, c.until, c.lastWall = p.Sequence, accepted.digest, p.Phase, p.ReadinessSHA256, until, wall
	return accepted, nil
}
