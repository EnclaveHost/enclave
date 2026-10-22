// Package pvmcustody is the Android protected VM's custody v2 release (custody/v2/avf-evidence.mjs is the custodian's half).
// It composes code that already exists, unchanged: the owner startup package (bootstrap: the guest's own ledger quorum
// verifies the owner's guestBootstrap commitment, the config text and the custody pointer) and the v2 release
// (custody.Client.ObtainV2: every machine's challenge, the binding, the recipient key made here, every partial's DLEQ check,
// the Enclave seat rule, the combine and the bundle's label). What is new is only what the platform differs in: the AVF
// evidence over the binding, the host's operator authorization over the egress channel, and TLS made in this VM over
// streams the host opened.
package pvmcustody

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"enclave.host/isolation/contract"
)

// The AVF custody evidence (custody/v2/avf-evidence.mjs AVF_EVIDENCE_FORMAT, AVF_CUSTODY_DOMAIN).
const (
	EvidenceFormat  = "enclave-pvm-custody-evidence/v1"
	CustodyDomain   = "enclave-custody-avf-v1\n"
	InstanceSigDom  = "enclave-pvm-instance-sig-v1\n"
	ed25519SPKIHead = "302a300506032b6570032100"
)

// ReleaseInput is challenge[0:32]: SHA-256(domain || v2 binding || InstanceID).
func ReleaseInput(binding, instanceID [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte(CustodyDomain))
	h.Write(binding[:])
	h.Write(instanceID[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// Challenge is the whole 64-byte AVF attestation challenge: ReleaseInput || AppID.
func Challenge(binding, instanceID, appID [32]byte) [64]byte {
	var c [64]byte
	in := ReleaseInput(binding, instanceID)
	copy(c[:32], in[:])
	copy(c[32:], appID[:])
	return c
}

// InstanceSigMessage is what the VM instance key signs: the domain and the whole challenge.
func InstanceSigMessage(challenge [64]byte) []byte {
	return append([]byte(InstanceSigDom), challenge[:]...)
}

// VM is what the payload states about this VM and its app, all public: the attested transport key and the instance key
// (44-byte Ed25519 SPKIs), the runtime identity line exactly as the VM prints it (canonical JSON), the runtime's W^X
// self-test tuple, and the AppID of the component it loaded.
type VM struct {
	AppID       [32]byte
	Identity    string
	Selftest    string
	SPKI        []byte
	InstanceKey []byte
}

// Attested is the payload's answer to one attestation request: the AVF chain (DER, leaf first, as
// AVmPayload_requestAttestation returned it) and the instance key's signature over the challenge.
type Attested struct {
	Chain       [][]byte
	InstanceSig []byte
}

type evidenceDoc struct {
	Abi          string          `json:"abi"`
	AppSha256    string          `json:"appSha256"`
	Chain        []string        `json:"chain"`
	Format       string          `json:"format"`
	Identity     string          `json:"identity"`
	InstanceKey  string          `json:"instanceKey"`
	InstanceSig  string          `json:"instanceSig"`
	Runtime      json.RawMessage `json:"runtime"`
	Selftest     string          `json:"selftest"`
	SPKI         string          `json:"spki"`
	TransportKey string          `json:"transportKey"`
}

func ed25519SPKI(b []byte) bool {
	return len(b) == 44 && hex.EncodeToString(b[:12]) == ed25519SPKIHead
}

// check validates what the payload stated and returns the runtime ID and the InstanceID.
func (v *VM) check() (rid, iid [32]byte, err error) {
	if !ed25519SPKI(v.SPKI) || !ed25519SPKI(v.InstanceKey) {
		return rid, iid, errors.New("the transport and instance keys must be 44-byte Ed25519 SPKIs")
	}
	if string(v.SPKI) == string(v.InstanceKey) {
		return rid, iid, errors.New("the instance key is the transport key")
	}
	var r contract.RuntimeIdentity
	if err = json.Unmarshal([]byte(v.Identity), &r); err != nil {
		return rid, iid, fmt.Errorf("the runtime identity is not JSON: %w", err)
	}
	canon, err := contract.Canonical(r)
	if err != nil || string(canon) != v.Identity {
		return rid, iid, errors.New("the runtime identity line is not canonical")
	}
	if rid, err = contract.RuntimeID(r); err != nil {
		return rid, iid, err
	}
	if v.Selftest == "" || len(v.Selftest) > 300 {
		return rid, iid, errors.New("no runtime self-test tuple")
	}
	return rid, sha256.Sum256(v.InstanceKey), nil
}

// evidence builds the release document for one binding from the payload's attestation over its challenge.
func (v *VM) evidence(binding, iid [32]byte, attest func([64]byte) (*Attested, error)) (json.RawMessage, error) {
	ch := Challenge(binding, iid, v.AppID)
	a, err := attest(ch)
	if err != nil {
		return nil, err
	}
	if a == nil || len(a.Chain) < 2 || len(a.Chain) > 8 {
		return nil, errors.New("the attestation returned no 2..8 certificate chain")
	}
	// the instance key's own signature, checked here: a payload that signed something else fails before any custodian
	if len(a.InstanceSig) != 64 || !ed25519.Verify(ed25519.PublicKey(v.InstanceKey[12:]), InstanceSigMessage(ch), a.InstanceSig) {
		return nil, errors.New("the instance key's signature does not verify over this release's challenge")
	}
	d := evidenceDoc{Abi: contract.ABI2, AppSha256: hex.EncodeToString(v.AppID[:]), Format: EvidenceFormat, Identity: v.Identity,
		InstanceKey: hex.EncodeToString(v.InstanceKey), InstanceSig: hex.EncodeToString(a.InstanceSig), Runtime: json.RawMessage(v.Identity),
		Selftest: v.Selftest, SPKI: hex.EncodeToString(v.SPKI), TransportKey: base64.StdEncoding.EncodeToString(v.SPKI)}
	for _, c := range a.Chain {
		d.Chain = append(d.Chain, base64.StdEncoding.EncodeToString(c))
	}
	return json.Marshal(d)
}
