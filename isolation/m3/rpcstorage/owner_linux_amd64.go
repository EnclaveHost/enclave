//go:build linux && amd64

package rpcstorage

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync/atomic"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
)

// OwnerIssuer runs at the storage owner, not in the requesting guest. Accepted
// owner provisioning supplies the ONE authoritative journal, both volume keys
// and the already-started local deadline. Neither a remote boot's monotonic
// values nor a guest-selected directory establishes that local authority.
// The independent process envelope must cover construction, chain reads, disk
// stalls and output. Context cancellation alone cannot interrupt a stuck fsync.
type OwnerIssuer struct {
	used             atomic.Bool
	continuationUsed atomic.Bool
	issued           atomic.Pointer[ownerIssued]
	journal          *os.File
	keys             [2]ed25519.PrivateKey
	volumes          [2]string
	binding          bootstrap.RPCExportBinding
	deadline         time.Time
	intent           *BrokerIntent
	proof            *os.File
}

// NewOwnerIssuer copies the keys and immutable binding. This constructor does
// not provision namespace authority or prove remote attestation. Only the
// owner's bootstrap may supply these local capabilities. No export is started.
func NewOwnerIssuer(journal *os.File, seeds [2][]byte, volumes [2]string, binding bootstrap.RPCExportBinding, deadline time.Time) (*OwnerIssuer, error) {
	if err := binding.Validate(); err != nil {
		return nil, err
	}
	if !contract.NonzeroHash(volumes[0]) || !contract.NonzeroHash(volumes[1]) || volumes[0] == volumes[1] {
		return nil, errors.New("distinct owner-provisioned volumes required")
	}
	left := time.Until(deadline)
	if left <= 0 || left > 900*time.Second {
		return nil, errors.New("original storage-owner deadline required")
	}
	for _, seed := range seeds {
		if len(seed) != ed25519.SeedSize {
			return nil, errors.New("exact owner Ed25519 seed required")
		}
	}
	o := &OwnerIssuer{journal: journal, volumes: volumes, binding: binding, deadline: deadline}
	for i, seed := range seeds {
		if len(seed) != ed25519.SeedSize {
			return nil, errors.New("exact owner Ed25519 seed required")
		}
		o.keys[i] = ed25519.NewKeyFromSeed(seed)
	}
	return o, nil
}

// Issue consumes this actor even on refusal. Both persistent writer names are
// fsynced/read back BEFORE signatures are produced, and the complete signed
// response is fsynced/read back BEFORE any bytes are returned to a transport.
// Interrupted/ambiguous calls retain every record; a second actor using the same
// owner namespace cannot reissue even the same request. No release API exists.
func (o *OwnerIssuer) Issue(ctx context.Context, a *bootstrap.Authorization, bundle []byte, r Request) ([]byte, error) {
	if o == nil || !o.used.CompareAndSwap(false, true) {
		return nil, errors.New("storage-owner actor consumed")
	}
	defer func() {
		for i := range o.keys {
			clear(o.keys[i])
			o.keys[i] = nil
		}
	}()
	check := func() error {
		if ctx == nil {
			return errors.New("owner context required")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if !time.Now().Before(o.deadline) {
			return errors.New("original storage-owner deadline expired; records held")
		}
		return nil
	}
	if err := check(); err != nil {
		return nil, err
	}
	authorities, err := a.RPCStorageAuthorities(bundle, r)
	if err != nil {
		return nil, err
	}
	for i, authority := range authorities {
		if authority.VolumeID != o.volumes[i] || authority.PublicKey != hex.EncodeToString(o.keys[i].Public().(ed25519.PublicKey)) {
			return nil, errors.New("owner-selected storage authority differs from local volume key")
		}
	}
	var epochs [2]string
	for i := range epochs {
		var raw [32]byte
		if _, err = rand.Read(raw[:]); err != nil {
			return nil, err
		}
		epochs[i] = hex.EncodeToString(raw[:])
	}
	payloads, err := a.RPCExportSigningPayloads(bundle, r, epochs[0], epochs[1], o.binding)
	if err != nil {
		return nil, err
	}
	var hashes [2]string
	for i, payload := range payloads {
		sum := sha256.Sum256(payload)
		hashes[i] = hex.EncodeToString(sum[:])
	}
	record := struct {
		Schema        string                     `json:"schema"`
		Request       Request                    `json:"request"`
		Epochs        [2]string                  `json:"epochs"`
		Export        bootstrap.RPCExportBinding `json:"export"`
		PayloadSHA256 [2]string                  `json:"payloadSha256"`
	}{"enclave-rpc-owner-consumed/1", r, epochs, o.binding, hashes}
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		return nil, err
	}
	o.intent, err = reserveRecords(o.journal, o.volumes, raw)
	if err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		return nil, err
	}
	proof := bootstrap.RPCStorageSignatures{Schema: "enclave-rpc-storage-consent/2", Export: &o.binding,
		L1:   bootstrap.RPCStorageSignature{WriterEpoch: epochs[0], Signature: hex.EncodeToString(ed25519.Sign(o.keys[0], payloads[0]))},
		Base: bootstrap.RPCStorageSignature{WriterEpoch: epochs[1], Signature: hex.EncodeToString(ed25519.Sign(o.keys[1], payloads[1]))}}
	raw, err = json.Marshal(proof)
	if err != nil {
		return nil, err
	}
	// Recheck fresh authorization and both signatures after persistence/signing.
	consent, err := a.VerifyRPCStorage(bundle, r, raw)
	if err != nil {
		return nil, err
	}
	requestBytes, _ := json.Marshal(r)
	requestHash := sha256.Sum256(requestBytes)
	o.proof, err = consumeRecord(o.journal, "proof-"+hex.EncodeToString(requestHash[:]), raw)
	if err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		return nil, err
	}
	if !consent.Matches(r) {
		return nil, errors.New("authorization lost before owner response; records held")
	}
	o.issued.Store(&ownerIssued{authorization: a, bundle: append([]byte(nil), bundle...), request: r, consent: consent, proof: append([]byte(nil), raw...)})
	return append([]byte(nil), raw...), nil
}
