package catalog

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"

	"enclave.host/isolation/contract"
)

// V9 is experimental and is intentionally absent from the ordinary backend
// derivation allowlists. Its offline mapping is not a claim of runtime support.
const V9 = "enclave-catalog-bundle/9"

type RPCDerivation struct {
	Derivation       string          `json:"derivation"`
	Catalog          Ref             `json:"catalog"`
	CID              string          `json:"cid"`
	RuntimeID        string          `json:"runtimeId"`
	Policy           contract.Policy `json:"policy"`
	HTTP             int             `json:"http"`
	Ports            []string        `json:"ports"`
	ConfigBase64     string          `json:"configBase64"`
	SecretDeployment string          `json:"secretDeployment"`
	RPC              contract.RPC    `json:"rpc"`
}

// ParseRPCRecord rejects unknown fields rather than silently dropping a
// caller's requested device, command, inference path or security mode.
func ParseRPCRecord(raw []byte) (RPCDerivation, error) {
	var d RPCDerivation
	if len(raw) == 0 || len(raw) > contract.MaxManifestBytes {
		return d, errors.New("RPC record size")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&d); err != nil {
		return d, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return d, errors.New("RPC record must contain exactly one JSON value")
	}
	// Typed decoding can default an omitted catalog.version to zero. Require the
	// exact key set (including nested keys) independently of that decoding.
	var input any
	if err := json.Unmarshal(raw, &input); err != nil {
		return d, err
	}
	got, _ := contract.Canonical(input)
	want, _ := contract.Canonical(d)
	if !bytes.Equal(got, want) {
		return d, errors.New("RPC record has missing or null fields")
	}
	return d, d.Validate()
}

func (d RPCDerivation) manifest() contract.Manifest {
	return contract.Manifest{ABI: contract.ABI, World: contract.WorldCLI,
		HTTP: d.HTTP, Ports: d.Ports, Policy: d.Policy, RPC: &d.RPC,
		ConfigBase64: d.ConfigBase64, SecretDeployment: d.SecretDeployment}
}

func (d RPCDerivation) Validate() error {
	if d.Derivation != V9 || (!catalogAppRE.MatchString(d.Catalog.App) || !contract.NonzeroHash(d.Catalog.App[2:])) || !cidRE.MatchString(d.CID) || !contract.NonzeroHash(d.RuntimeID) {
		return errors.New("invalid RPC derivation identity")
	}
	_, err := d.manifest().AppConfig()
	return err
}

type RPCMapping struct {
	Record          RPCDerivation `json:"record"`
	RecordSha256    string        `json:"recordSha256"`
	ComponentSha256 string        `json:"componentSha256"`
	ComponentBytes  int           `json:"componentBytes"`
	AppID           string        `json:"appId"`
	BundleBytes     int           `json:"bundleBytes"`
}

func MapRPC(d RPCDerivation, component []byte) (RPCMapping, []byte, error) {
	if err := d.Validate(); err != nil {
		return RPCMapping{}, nil, err
	}
	if len(component) > contract.MaxRPCControllerBytes || !IsComponent(component) {
		return RPCMapping{}, nil, errors.New("RPC controller must be a portable Wasm component")
	}
	d.Ports = append([]string(nil), d.Ports...)
	b, err := contract.Build(d.manifest(), component)
	if err != nil {
		return RPCMapping{}, nil, err
	}
	raw, err := contract.Canonical(d)
	if err != nil {
		return RPCMapping{}, nil, err
	}
	rd, cs, id := sha256.Sum256(raw), sha256.Sum256(component), contract.AppID(b)
	return RPCMapping{Record: d, RecordSha256: hex.EncodeToString(rd[:]),
		ComponentSha256: hex.EncodeToString(cs[:]), ComponentBytes: len(component),
		AppID: hex.EncodeToString(id[:]), BundleBytes: len(b)}, b, nil
}
