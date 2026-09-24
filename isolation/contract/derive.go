package contract

// Catalog derivation: the ONE rule by which a catalog version's component becomes a contract bundle.
//
// WHY A RULE AND NOT A LOOKUP. The on-chain catalog names an app version's component by an IPFS CID - a hash of a
// UnixFS DAG, which for a chunked file is not even a hash of the bytes. The contract names an app by its AppID,
// sha256 of a BUNDLE (manifest + artifact). Neither is the other, and a backend that simply relabelled one as the
// other would be asserting an identity nobody can recompute. So the bundle for a catalog version is DERIVED, by
// this function, from inputs every one of which is explicit and recorded:
//
//	the component bytes      fetched by CID and verified against it (the host's fetcher, not this code)
//	the policy               cpuPercent, memMiB, vcpus - pinned in the record, never defaulted
//	the derivation version   CatalogDerivationV1; a future rule is a new version, never a silent change
//
// The bundle is exactly what `bundle build -cpu C -mem M -vcpus V <component>` builds (world "wasi:http", no
// label), so a publisher, a verifier and every backend get the same bytes and the same AppID from the same
// inputs. The catalog reference and the pinned RuntimeID are recorded beside it and do NOT enter the bundle: the
// AppID is the app's identity wherever it is listed, and the runtime is bound separately in report_data (Bind2).
//
// What this does NOT change, deliberately: nothing on chain, and nothing about bundles published directly. It
// adds a derivation; it does not remap any existing AppID. See DERIVE.md for the incompatibilities this exposes.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
)

const CatalogDerivationV1 = "enclave-catalog-bundle/1"

// DerivedWorld is the world a derived bundle states. The per-app guest serves the component with `wasmtime
// serve`, so the component must be a wasi:http proxy; the contract's own builder uses the same default.
const DerivedWorld = "wasi:http"

// The component-model preamble: magic, version 0x0d, layer 1. A core module carries 01 00 00 00 instead and is
// not a distributable artifact (bundle.go KindWasmComponent).
var componentPreamble = []byte{0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00}

// IsComponent reports whether bytes begin as a WebAssembly component (not a core module, not anything else).
func IsComponent(b []byte) bool { return bytes.HasPrefix(b, componentPreamble) }

type CatalogRef struct {
	App     string `json:"app"`     // the catalog's bytes32 app id, 0x + 64 hex, as catalog:// refs carry it
	Version uint32 `json:"version"` // the version index
}

// CatalogDerivation is the record of one derivation: everything it takes, and nothing it does not.
type CatalogDerivation struct {
	Derivation string     `json:"derivation"`
	Catalog    CatalogRef `json:"catalog"`
	CID        string     `json:"cid"`
	Policy     Policy     `json:"policy"`
	RuntimeID  string     `json:"runtimeId"` // hex RuntimeID the mapping is pinned to; recorded, not in the bundle
}

var (
	catalogAppRE = regexp.MustCompile(`^0x[0-9a-f]{64}$`)
	cidRE        = regexp.MustCompile(`^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,120}|z[1-9A-HJ-NP-Za-km-z]{40,120})$`)
	hex64RE      = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// Validate refuses a record that is not a complete, well-formed v1 derivation. Every field is required: a
// missing policy field defaulted here would be an identity nobody asked for.
func (d CatalogDerivation) Validate() error {
	switch {
	case d.Derivation != CatalogDerivationV1:
		return fmt.Errorf("derivation %q is not %q", d.Derivation, CatalogDerivationV1)
	case !catalogAppRE.MatchString(d.Catalog.App):
		return errors.New("catalog.app must be 0x + 64 lowercase hex, as the catalog's bytes32 app id")
	case !cidRE.MatchString(d.CID):
		return errors.New("cid is not a CIDv0 (Qm...) or a base32/base58 CIDv1")
	case d.Policy.CPUPercent < 1 || d.Policy.CPUPercent > 1600:
		return errors.New("policy.cpuPercent must be pinned in 1..1600")
	case d.Policy.MemMiB < 64 || d.Policy.MemMiB > 65536:
		return errors.New("policy.memMiB must be pinned in 64..65536")
	case d.Policy.Vcpus < 1 || d.Policy.Vcpus > 16:
		return errors.New("policy.vcpus must be pinned in 1..16")
	case !hex64RE.MatchString(d.RuntimeID):
		return errors.New("runtimeId must be the 64-hex RuntimeID the mapping is pinned to")
	}
	return nil
}

// Digest is sha256 of the record's canonical JSON: the key a mapping is stored and looked up under.
func (d CatalogDerivation) Digest() ([32]byte, error) {
	b, err := Canonical(d)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(b), nil
}

// DeriveCatalogBundle builds the bundle for a verified component under a record. It refuses anything that is not
// a component, and it never looks at the network: the caller has already verified the bytes against the CID.
func DeriveCatalogBundle(d CatalogDerivation, component []byte) ([]byte, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	if !IsComponent(component) {
		return nil, errors.New("the catalog bytes are not a WebAssembly component (a core module or something else)")
	}
	return Build(Manifest{ABI: ABI, World: DerivedWorld, Policy: d.Policy}, component)
}

// CatalogMapping is what a backend stores for one record: immutable, and recomputable by anyone holding the
// component bytes.
type CatalogMapping struct {
	Record          CatalogDerivation `json:"record"`
	RecordSha256    string            `json:"recordSha256"`
	ComponentSha256 string            `json:"componentSha256"`
	ComponentBytes  int               `json:"componentBytes"`
	AppID           string            `json:"appId"`
	BundleBytes     int               `json:"bundleBytes"`
}

// MapCatalog derives the bundle and the mapping together, so the two can never disagree.
func MapCatalog(d CatalogDerivation, component []byte) (CatalogMapping, []byte, error) {
	b, err := DeriveCatalogBundle(d, component)
	if err != nil {
		return CatalogMapping{}, nil, err
	}
	rd, err := d.Digest()
	if err != nil {
		return CatalogMapping{}, nil, err
	}
	cs := sha256.Sum256(component)
	id := AppID(b)
	return CatalogMapping{Record: d, RecordSha256: hex.EncodeToString(rd[:]),
		ComponentSha256: hex.EncodeToString(cs[:]), ComponentBytes: len(component),
		AppID: hex.EncodeToString(id[:]), BundleBytes: len(b)}, b, nil
}
