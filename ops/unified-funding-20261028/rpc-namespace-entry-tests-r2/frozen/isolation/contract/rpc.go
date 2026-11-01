package contract

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"slices"
	"strings"
)

const MaxRPCControllerBytes = 8 << 20

const RPCProfile = "ethereum-base-rpc-v1"

// RPC pins a native companion INSIDE the measured app domain. It is not a host
// process, a proxy to an external provider, or permission to execute a command.
// ProfileSha256 must name the complete native runtime descriptor; independent
// release admission must bind that descriptor to the actual measured image.
// Volume IDs are owner-selected persistent logical identities, not host paths,
// filesystem UUIDs, or claims that a state snapshot is canonical or current.
type RPC struct {
	Profile       string `json:"profile"`
	ProfileSha256 string `json:"profileSha256"`
	L1VolumeID    string `json:"l1VolumeId"`
	BaseVolumeID  string `json:"baseVolumeId"`
}

// Only peer traffic is tunneled. Engine, beacon, diagnostic and raw execution
// APIs stay domain-local. The measured controller owns HTTP 8000.
func RPCPorts() []string {
	return []string{"tcp:30303", "tcp:30313", "tcp:9222", "tcp:9310", "udp:30303", "udp:30313", "udp:30314", "udp:9200", "udp:9223", "udp:9310", "udp:9311"}
}

func (m Manifest) ValidateRPC() error {
	r := m.RPC
	if r == nil {
		return nil
	}
	if r.Profile != RPCProfile || !NonzeroHash(r.ProfileSha256) || !NonzeroHash(r.L1VolumeID) || !NonzeroHash(r.BaseVolumeID) || r.L1VolumeID == r.BaseVolumeID {
		return errors.New("RPC requires its measured profile and distinct nonzero state volume identities")
	}
	if m.Desktop != nil || m.Inference != nil || m.Label != "" || m.World != WorldCLI || m.HTTP != 8000 || !slices.Equal(m.Ports, RPCPorts()) {
		return errors.New("RPC requires only its CPU profile, controller HTTP and fixed peer ports")
	}
	if !strings.HasPrefix(m.SecretDeployment, "0x") || !NonzeroHash(strings.TrimPrefix(m.SecretDeployment, "0x")) || m.ConfigBase64 == "" {
		return errors.New("RPC requires deployment-bound configuration and sealed provisioning")
	}
	// This is the existing proposed budget, not evidence of measured client fit.
	// The owner must additionally reserve 1 GiB support (20 GiB total) and retain
	// the original 900-second startup window. Neither is proven by a bundle.
	if m.Policy != (Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}) {
		return errors.New("RPC requires its 19 GiB, four-vCPU, CPU-only domain budget")
	}
	// The profile supplies fixed native commands and chain configuration. An app
	// request cannot smuggle host commands, external RPC providers or storage
	// paths into this CPU service. Private attachment credentials arrive through
	// deployment-bound provisioning, never the public bundle.
	if len(m.ConfigBase64) > base64.StdEncoding.EncodedLen(MaxConfigBytes) {
		return errors.New("RPC configuration too large")
	}
	b, err := base64.StdEncoding.Strict().DecodeString(m.ConfigBase64)
	if err != nil {
		return errors.New("RPC configuration encoding")
	}
	var cfg map[string]any
	if json.Unmarshal(b, &cfg) != nil {
		return errors.New("RPC configuration JSON")
	}
	canonical, err := Canonical(cfg)
	if err != nil || !bytes.Equal(canonical, []byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)) {
		return errors.New("RPC requires fixed chains and original 900-second startup policy")
	}
	return nil
}

// ParseRPC is for offline tooling and the future explicitly qualified RPC
// runtime. Ordinary Parse and ParseDesktop continue refusing this profile.
func ParseRPC(b []byte) (Manifest, []byte, error) {
	m, artifact, err := parseBundle(b, false, true)
	if err == nil && m.RPC == nil {
		return m, nil, errors.New("not an RPC bundle")
	}
	if err == nil && (len(artifact) > MaxRPCControllerBytes || !bytes.HasPrefix(artifact, []byte{0, 97, 115, 109, 13, 0, 1, 0})) {
		return m, nil, errors.New("RPC requires a bounded portable controller")
	}
	return m, artifact, err
}
