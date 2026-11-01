// Package rpcplatform binds the distinct CPU RPC image components to a V9
// bundle. Parsing hashes does not authenticate an accepted platform or launch.
package rpcplatform

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"enclave.host/isolation/contract"
)

const Schema = "enclave-native-rpc-profile/1"
const KernelRelease = "6.6.87.2-enclave-kvm-box" // existing kernel build; no GPU/model profile
const MaxEntryBytes = 32 << 20

// Canonical lexical field order, exactly one trailing LF. No device, command,
// path, endpoint, GPU/model resource, timing override or admission flag exists.
type Profile struct {
	ControllerSha256 string     `json:"controllerSha256"`
	EntrySha256      string     `json:"entrySha256"`
	Kernel           Kernel     `json:"kernel"`
	Profile          string     `json:"profile"`
	Root             RootVolume `json:"root"`
	Schema           string     `json:"schema"`
}
type Kernel struct {
	BootSha256 string `json:"bootSha256"`
	ElfSha256  string `json:"elfSha256"`
	Release    string `json:"release"`
}

// This geometry is emitted by rpc/native/build_image.py. The entry executable
// lives in the measured bootstrap, separately from the reusable client root.
type RootVolume struct {
	DataBlocks  uint64 `json:"dataBlocks"`
	HashBytes   uint64 `json:"hashBytes"`
	HashSha256  string `json:"hashSha256"`
	ImageBytes  uint64 `json:"imageBytes"`
	ImageSha256 string `json:"imageSha256"`
	RootHash    string `json:"rootHash"`
	Salt        string `json:"salt"`
}

func (p Profile) Validate() error {
	if p.Schema != Schema || p.Profile != contract.RPCProfile || p.Kernel.Release != KernelRelease {
		return errors.New("unsupported RPC platform profile")
	}
	for _, pin := range []string{p.ControllerSha256, p.EntrySha256, p.Kernel.BootSha256, p.Kernel.ElfSha256, p.Root.HashSha256, p.Root.ImageSha256, p.Root.RootHash, p.Root.Salt} {
		if !contract.NonzeroHash(pin) {
			return errors.New("invalid RPC component digest")
		}
	}
	if p.Root.DataBlocks != 262144 || p.Root.ImageBytes != 1073741824 || p.Root.HashBytes != 8458240 {
		return errors.New("RPC root geometry differs from fixed 1 GiB build")
	}
	return nil
}

func (p Profile) Canonical() ([]byte, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	b, err := json.Marshal(p)
	return append(b, '\n'), err
}

func ParseProfile(raw []byte) (Profile, string, error) {
	var p Profile
	if len(raw) == 0 || len(raw) > 16384 {
		return p, "", errors.New("RPC profile size")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return p, "", err
	}
	b, err := p.Canonical()
	if err != nil {
		return p, "", err
	}
	if !bytes.Equal(b, raw) {
		return p, "", errors.New("noncanonical RPC profile")
	}
	h := sha256.Sum256(raw)
	return p, hex.EncodeToString(h[:]), nil
}

// CheckBundle is identity consistency only. The monitor still must derive the
// catalog AppID and independently authenticate this profile as the measured,
// owner-accepted platform before provisioning any secret or writable storage.
func (p Profile) CheckBundle(m contract.Manifest, controller []byte) error {
	b, err := p.Canonical()
	if err != nil {
		return err
	}
	if m.RPC == nil {
		return errors.New("RPC manifest required")
	}
	if err := m.ValidateRPC(); err != nil {
		return err
	}
	h := sha256.Sum256(b)
	if m.RPC.ProfileSha256 != hex.EncodeToString(h[:]) {
		return errors.New("RPC profile identity mismatch")
	}
	if len(controller) > contract.MaxRPCControllerBytes || !bytes.HasPrefix(controller, []byte{0, 97, 115, 109, 13, 0, 1, 0}) {
		return errors.New("bounded component controller required")
	}
	h = sha256.Sum256(controller)
	if p.ControllerSha256 != hex.EncodeToString(h[:]) {
		return errors.New("RPC controller identity mismatch")
	}
	return nil
}

// CheckEntry checks actual held executable bytes, not a caller's success flag.
// ELF shape and hash are not a proof that its code obeys a protocol: accepted
// platform derivation must pin the reviewed entry and its complete build.
func (p Profile) CheckEntry(entry []byte) error {
	if err := p.Validate(); err != nil {
		return err
	}
	if len(entry) < 64 || len(entry) > MaxEntryBytes || !bytes.Equal(entry[:7], []byte{127, 69, 76, 70, 2, 1, 1}) || entry[18] != 62 || entry[19] != 0 || entry[17] != 0 || (entry[16] != 2 && entry[16] != 3) {
		return errors.New("bounded amd64 ELF entry required")
	}
	h := sha256.Sum256(entry)
	if p.EntrySha256 != hex.EncodeToString(h[:]) {
		return errors.New("RPC entry identity mismatch")
	}
	return nil
}
