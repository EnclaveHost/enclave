// Package desktop defines the measured native desktop resource boundary.
// Parsing a profile does not authorize a launch, worker, or secret release.
package desktop

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"enclave.host/isolation/contract"
)

const Schema = "enclave-native-desktop-profile/1"
const KernelRelease = "6.6.87.2-enclave-kvm-box"
const PidsMax = 1024

// Field order is the canonical lexical JSON order; exactly one trailing LF.
// There are no host-selected paths, commands, device names, or bypass flags.
type Profile struct {
	ControllerSha256 string      `json:"controllerSha256"`
	Kernel           Kernel      `json:"kernel"`
	Models           ModelVolume `json:"models"`
	Profile          string      `json:"profile"`
	Root             RootVolume  `json:"root"`
	Schema           string      `json:"schema"`
}
type Kernel struct {
	BootSha256 string `json:"bootSha256"`
	ElfSha256  string `json:"elfSha256"`
	Release    string `json:"release"`
}
type RootVolume struct {
	DataBlocks  uint64 `json:"dataBlocks"`
	HashBytes   uint64 `json:"hashBytes"`
	HashSha256  string `json:"hashSha256"`
	ImageBytes  uint64 `json:"imageBytes"`
	ImageSha256 string `json:"imageSha256"`
	RootHash    string `json:"rootHash"`
	Salt        string `json:"salt"`
}
type ModelVolume struct {
	DataBlocks     uint64 `json:"dataBlocks"`
	HashStartBlock uint64 `json:"hashStartBlock"`
	ImageBytes     uint64 `json:"imageBytes"`
	ImageSha256    string `json:"imageSha256"`
	RootHash       string `json:"rootHash"`
	Salt           string `json:"salt"`
}

func hashTreeBytes(blocks uint64) uint64 {
	var result uint64
	for blocks > 1 {
		blocks = (blocks + 127) / 128
		result += blocks * 4096
	}
	return result
}
func (p Profile) Validate() error {
	if p.Schema != Schema || p.Profile != contract.DesktopProfile || p.Kernel.Release != KernelRelease {
		return errors.New("unsupported desktop profile")
	}
	for _, s := range []string{p.ControllerSha256, p.Kernel.BootSha256, p.Kernel.ElfSha256, p.Root.HashSha256, p.Root.ImageSha256, p.Root.RootHash, p.Root.Salt, p.Models.ImageSha256, p.Models.RootHash, p.Models.Salt} {
		if !contract.NonzeroHash(s) {
			return errors.New("invalid desktop digest")
		}
	}
	// Bound before multiplying. Current profile supports up to 8 GiB root and
	// 128 GiB models; all hash geometry is fixed SHA256/4096/format1.
	r, m := p.Root, p.Models
	if r.DataBlocks < 2 || r.DataBlocks > (8<<30)/4096 || r.ImageBytes != r.DataBlocks*4096 || r.HashBytes != hashTreeBytes(r.DataBlocks) {
		return errors.New("invalid root geometry")
	}
	if m.DataBlocks < 2 || m.DataBlocks > (128<<30)/4096 || m.HashStartBlock != m.DataBlocks+1 || m.ImageBytes != m.HashStartBlock*4096+hashTreeBytes(m.DataBlocks) {
		return errors.New("invalid model geometry")
	}
	return nil
}
func ParseProfile(raw []byte) (Profile, string, error) {
	var p Profile
	if len(raw) == 0 || len(raw) > 16384 {
		return p, "", errors.New("profile size")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&p); err != nil {
		return p, "", err
	}
	canonical, err := json.Marshal(p)
	if err != nil {
		return p, "", err
	}
	canonical = append(canonical, '\n')
	// Reject duplicates, alternate spelling, trailing JSON, and unknown fields.
	if !bytes.Equal(raw, canonical) {
		return p, "", errors.New("noncanonical desktop profile")
	}
	if err := p.Validate(); err != nil {
		return p, "", err
	}
	sum := sha256.Sum256(raw)
	return p, hex.EncodeToString(sum[:]), nil
}

// CheckBundle binds the controller and manifest to the installed measured
// profile. The caller must additionally verify mounted resources, exclusive
// guest ownership, cgroups, sealed-secret delivery and a live worker lease.
func (p Profile) CheckBundle(m contract.Manifest, artifact []byte) error {
	if err := p.Validate(); err != nil {
		return err
	}
	if err := m.ValidateDesktop(); err != nil {
		return err
	}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	identity := sha256.Sum256(append(raw, '\n'))
	if m.Desktop == nil || m.Desktop.ProfileSha256 != hex.EncodeToString(identity[:]) {
		return errors.New("desktop profile identity mismatch")
	}
	sum := sha256.Sum256(artifact)
	if hex.EncodeToString(sum[:]) != p.ControllerSha256 {
		return errors.New("desktop controller identity mismatch")
	}
	return nil
}

// Limits are installed before CLONE_INTO_CGROUP. No swap and group OOM prevent
// selected descendants from surviving an exhausted desktop session.
func Limits(cpuPercent, memMiB, vcpus int) ([][2]string, error) {
	if cpuPercent < 400 || cpuPercent > 1600 || memMiB < 8192 || memMiB > 65536 || vcpus < 4 || vcpus > 16 || cpuPercent > vcpus*100 {
		return nil, errors.New("desktop resource allocation outside profile")
	}
	return [][2]string{{"cpu.max", fmt.Sprintf("%d 100000", cpuPercent*1000)}, {"memory.max", fmt.Sprint(uint64(memMiB) << 20)}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"pids.max", fmt.Sprint(PidsMax)}}, nil
}
