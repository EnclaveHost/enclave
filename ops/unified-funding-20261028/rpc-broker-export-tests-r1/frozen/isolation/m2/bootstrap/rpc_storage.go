package bootstrap

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"regexp"
	"strings"
	"time"

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
	Export *RPCExportBinding   `json:"export,omitempty"`
}

// RPCExportBinding is selected by BOTH storage authorities for this one request
// and writer epoch pair. It is not a caller-selected dial target or a readiness
// receipt. IP dialing avoids a mandatory DNS/resolver authority; ServerName is
// checked against the exact pinned certificate using ordinary X.509 validation.
type RPCExportBinding struct {
	Host                    string `json:"host"`
	Port                    uint16 `json:"port"`
	ServerName              string `json:"serverName"`
	ServerCertificateSHA256 string `json:"serverCertificateSha256"`
	ClientCertificateSHA256 string `json:"clientCertificateSha256"`
	ContractSHA256          string `json:"contractSha256"`
}

func (b RPCExportBinding) Validate() error {
	ip := net.ParseIP(b.Host)
	if ip == nil || ip.String() != b.Host || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() || b.Port < 1024 {
		return errors.New("explicit canonical unicast exporter endpoint required")
	}
	if len(b.ServerName) == 0 || len(b.ServerName) > 253 {
		return errors.New("explicit exporter certificate name required")
	}
	for _, label := range strings.Split(b.ServerName, ".") {
		if len(label) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).MatchString(label) {
			return errors.New("canonical exporter certificate name required")
		}
	}
	for _, value := range []string{b.ServerCertificateSHA256, b.ClientCertificateSHA256, b.ContractSHA256} {
		if !contract.NonzeroHash(value) {
			return errors.New("exact exporter certificate/contract pins required")
		}
	}
	return nil
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
	export             *RPCExportBinding
	notAfter           time.Time
}

// NotAfter is the immutable original authorization limit. Revalidating a legacy
// Authorization cannot silently extend a consumed transport attempt. Its watcher
// can read this bound without racing mutable Authorization.Revalidate state.
func (c *RPCStorageConsent) NotAfter() time.Time {
	if c == nil {
		return time.Time{}
	}
	return c.notAfter
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

// ExportBinding returns a copy, or nil for historical consent that cannot open
// an export connection. It never returns usable state after revocation/expiry.
func (c *RPCStorageConsent) ExportBinding(r contract.RPCStorageRequest) (*RPCExportBinding, error) {
	if !c.Matches(r) {
		return nil, errors.New("storage consent expired, revoked or substituted")
	}
	if c.export == nil {
		return nil, nil
	}
	b := *c.export
	return &b, nil
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
	payloads, err := a.RPCStorageSigningPayloads(bundle, r, proof.L1.WriterEpoch, proof.Base.WriterEpoch)
	if err != nil {
		return nil, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	_, hasExport := fields["export"]
	switch proof.Schema {
	case "enclave-rpc-storage-consent/1":
		if hasExport {
			return nil, errors.New("historical consent cannot add an exporter")
		}
	case "enclave-rpc-storage-consent/2":
		if proof.Export == nil {
			return nil, errors.New("explicit signed exporter binding required")
		}
		payloads, err = a.RPCExportSigningPayloads(bundle, r, proof.L1.WriterEpoch, proof.Base.WriterEpoch, *proof.Export)
		if err != nil {
			return nil, err
		}
	default:
		return nil, errors.New("storage signature schema")
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
	expires := int64(a.snapshot.row.leaseUntil)
	// current() accepts the entire final second of the snapshot freshness bound.
	if fresh := int64(a.snapshot.timestamp) + int64(a.reader.maxAge.Seconds()) + 1; fresh < expires {
		expires = fresh
	}
	return &RPCStorageConsent{authorization: a, request: r, l1Epoch: proof.L1.WriterEpoch, baseEpoch: proof.Base.WriterEpoch, export: proof.Export, notAfter: time.Unix(expires, 0)}, nil
}

// RPCExportSigningPayloads extends, rather than weakens, all original consent
// bindings. Each authority signs its role/epoch payload plus the canonical exact
// transport binding under a distinct domain. Signing remains owner-operated.
func (a *Authorization) RPCExportSigningPayloads(bundle []byte, r contract.RPCStorageRequest, l1Epoch, baseEpoch string, binding RPCExportBinding) ([2][]byte, error) {
	var out [2][]byte
	if err := binding.Validate(); err != nil {
		return out, err
	}
	base, err := a.RPCStorageSigningPayloads(bundle, r, l1Epoch, baseEpoch)
	if err != nil {
		return out, err
	}
	raw, err := json.Marshal(binding)
	if err != nil {
		return out, err
	}
	hash := sha256.Sum256(raw)
	for i := range out {
		out[i] = append([]byte("ENCLAVE-RPC-STORAGE-EXPORT/1\x00"), base[i]...)
		out[i] = append(out[i], hash[:]...)
	}
	return out, nil
}
