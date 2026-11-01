package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"

	"enclave.host/isolation/contract"
)

// RPCStorage is optional for historical startup packages. Each key is selected
// by the deployment owner in the on-chain-committed package. No Enclave key,
// endpoint, filesystem path or permission boolean is substituted by the host.
type RPCStorage struct {
	Schema string              `json:"schema"`
	L1     RPCStorageAuthority `json:"l1"`
	Base   RPCStorageAuthority `json:"base"`
}
type RPCStorageAuthority struct {
	VolumeID  string `json:"volumeId"`
	PublicKey string `json:"publicKey"` // raw Ed25519, lowercase hex
}

func rpcStorageField(raw []byte, p *RPCStorage) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return err
	}
	value, present := fields["rpcStorage"]
	if !present {
		return nil
	}
	if p == nil || bytes.Equal(bytes.TrimSpace(value), []byte("null")) || p.Schema != "enclave-rpc-storage-authorities/1" || p.L1.VolumeID == p.Base.VolumeID {
		return errors.New("explicit distinct RPC storage authorities required")
	}
	for _, a := range []RPCStorageAuthority{p.L1, p.Base} {
		if !contract.NonzeroHash(a.VolumeID) || !contract.NonzeroHash(a.PublicKey) {
			return errors.New("invalid owner-selected storage authority")
		}
	}
	return nil
}

// RPCStorageSignatures are consent from both owner-selected storage authorities.
// An epoch identifies the provider's durable exclusive-writer record. Verifying
// its signature does NOT prove that record exists, excludes another writer, or
// that a deadline/export watchdog is armed. Those must be established separately
// at the storage owner before the broker may send descriptors to the monitor.
type RPCStorageSignatures struct {
	Schema string              `json:"schema"`
	L1     RPCStorageSignature `json:"l1"`
	Base   RPCStorageSignature `json:"base"`
}
type RPCStorageSignature struct {
	WriterEpoch string `json:"writerEpoch"`
	Signature   string `json:"signature"` // 64 bytes, lowercase hex
}

// RPCStorageConsent cannot be constructed from public booleans or a host file.
// It is only authorization to continue acquisition, never permission to start
// clients or a certificate of local/remote writer settlement.
type RPCStorageConsent struct {
	authorization      *Authorization
	request            contract.RPCStorageRequest
	l1Epoch, baseEpoch string
}

func (c *RPCStorageConsent) Matches(r contract.RPCStorageRequest) bool {
	return c != nil && c.authorization.current() && c.request == r
}
func (c *RPCStorageConsent) WriterEpochs(r contract.RPCStorageRequest) (string, string, error) {
	if !c.Matches(r) {
		return "", "", errors.New("storage consent expired, revoked or substituted")
	}
	return c.l1Epoch, c.baseEpoch, nil
}

func (a *Authorization) rpcStorageScope(bundle []byte, r contract.RPCStorageRequest) error {
	if !a.current() || a.manifest.RPCStorage == nil {
		return errors.New("no current owner-committed RPC storage authority")
	}
	if err := r.Validate(); err != nil {
		return err
	}
	m, _, err := contract.ParseRPC(bundle)
	if err != nil {
		return err
	}
	id := contract.AppID(bundle)
	if hex.EncodeToString(id[:]) != a.manifest.AppID || r.AppID != a.manifest.AppID || r.Deployment != a.manifest.Deployment || r.Deployment != m.SecretDeployment || r.Profile != m.RPC.ProfileSha256 || r.L1Volume != m.RPC.L1VolumeID || r.BaseVolume != m.RPC.BaseVolumeID || r.L1Volume != a.manifest.RPCStorage.L1.VolumeID || r.BaseVolume != a.manifest.RPCStorage.Base.VolumeID {
		return errors.New("storage request differs from authenticated app, deployment or volumes")
	}
	return nil
}

// RPCStorageSigningPayloads supplies exact, domain-separated bytes to an
// independent storage owner. It does not sign, consume or grant. The caller must
// transport the challenge over an authenticated channel and check actual kernel
// boot/original time; an owner must verify its writer state before signing.
// Authority keys are already pinned by Reader.Authorize, not by this request.
func (a *Authorization) RPCStorageSigningPayloads(bundle []byte, r contract.RPCStorageRequest, l1Epoch, baseEpoch string) ([2][]byte, error) {
	var out [2][]byte
	if err := a.rpcStorageScope(bundle, r); err != nil {
		return out, err
	}
	if !contract.NonzeroHash(l1Epoch) || !contract.NonzeroHash(baseEpoch) || l1Epoch == baseEpoch {
		return out, errors.New("distinct durable writer epochs required")
	}
	raw, err := json.Marshal(r)
	if err != nil {
		return out, err
	}
	requestHash := sha256.Sum256(raw)
	envelope := sha256.Sum256([]byte(a.snapshot.row.envelope))
	// All components are fixed width after a fixed domain separator. Runtime,
	// chain and ledger are explicitly bound below; the envelope digest binds the
	// on-chain commitment to the exact authenticated startup package.
	manifest, err := hex.DecodeString(a.manifest.RuntimeID)
	if err != nil || len(manifest) != 32 {
		return out, errors.New("runtime identity unavailable")
	}
	owner, err := hex.DecodeString(strings.TrimPrefix(strings.ToLower(a.snapshot.row.owner), "0x"))
	if err != nil || len(owner) != 20 {
		return out, errors.New("owner identity unavailable")
	}
	for i, epoch := range []string{l1Epoch, baseEpoch} {
		payload := append([]byte("ENCLAVE-RPC-STORAGE-CONSENT/1\x00"), requestHash[:]...)
		payload = append(payload, envelope[:]...)
		payload = append(payload, manifest...)
		payload = append(payload, owner...)
		// Bind the measured reader's chain and ledger as well, preventing identical
		// owner commitments on a different chain/ledger from reusing a signature.
		chain := a.manifest.ChainID
		for shift := 56; shift >= 0; shift -= 8 {
			payload = append(payload, byte(chain>>uint(shift)))
		}
		ledger, _ := hex.DecodeString(strings.TrimPrefix(strings.ToLower(a.manifest.Ledger), "0x"))
		payload = append(payload, ledger...)
		payload = append(payload, byte(i))
		eb, _ := hex.DecodeString(epoch)
		payload = append(payload, eb...)
		out[i] = payload
	}
	return out, nil
}
func (a *Authorization) VerifyRPCStorage(bundle []byte, r contract.RPCStorageRequest, raw []byte) (*RPCStorageConsent, error) {
	if len(raw) == 0 || len(raw) > 2048 {
		return nil, errors.New("bounded storage signatures required")
	}
	var proof RPCStorageSignatures
	if err := strictJSON(raw, &proof); err != nil {
		return nil, err
	}
	if proof.Schema != "enclave-rpc-storage-consent/1" {
		return nil, errors.New("storage signature schema")
	}
	payloads, err := a.RPCStorageSigningPayloads(bundle, r, proof.L1.WriterEpoch, proof.Base.WriterEpoch)
	if err != nil {
		return nil, err
	}
	for i, p := range []RPCStorageSignature{proof.L1, proof.Base} {
		authority := a.manifest.RPCStorage.L1
		if i == 1 {
			authority = a.manifest.RPCStorage.Base
		}
		sig, err := hex.DecodeString(p.Signature)
		if err != nil || len(sig) != ed25519.SignatureSize || strings.ToLower(p.Signature) != p.Signature {
			return nil, errors.New("storage signature encoding")
		}
		key, _ := hex.DecodeString(authority.PublicKey)
		if !ed25519.Verify(ed25519.PublicKey(key), payloads[i], sig) {
			return nil, errors.New("storage authority signature mismatch")
		}
	}
	if !a.current() {
		return nil, errors.New("storage authorization expired during verification")
	}
	return &RPCStorageConsent{authorization: a, request: r, l1Epoch: proof.L1.WriterEpoch, baseEpoch: proof.Base.WriterEpoch}, nil
}
