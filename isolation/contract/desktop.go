package contract

import (
	"errors"
	"regexp"
	"slices"
	"strings"
)

const DesktopProfile = "kvm-box-masked-v1"

// Desktop commits a fixed measured companion profile, not an arbitrary native
// artifact or host command. ProfileSha256 names its pre-image input descriptor;
// an independent release pin must pair it with the final image and RuntimeID.
type Desktop struct {
	Profile       string `json:"profile"`
	ProfileSha256 string `json:"profileSha256"`
	GPUMilli      int    `json:"gpuMilli"`
}

func DesktopPorts() []string {
	return []string{"tcp:47984", "tcp:47989", "tcp:48010", "udp:47998", "udp:47999", "udp:48000"}
}

var desktopHash = regexp.MustCompile(`^[0-9a-f]{64}$`)

func NonzeroHash(s string) bool {
	return desktopHash.MatchString(s) && s != strings.Repeat("0", 64)
}

// ValidateDesktop checks the experimental V8 shape only. It does not authorize
// launching a profile, releasing a secret, or using a worker.
func (m Manifest) ValidateDesktop() error {
	d := m.Desktop
	if d == nil {
		return nil
	}
	if d.Profile != DesktopProfile || !NonzeroHash(d.ProfileSha256) || d.GPUMilli < 500 || d.GPUMilli > 1000 {
		return errors.New("invalid masked desktop profile")
	}
	if m.World != WorldCLI || m.HTTP != 8000 || m.Label != "" || m.Inference != nil || !slices.Equal(m.Ports, DesktopPorts()) {
		return errors.New("desktop requires its fixed command and protected Moonlight ports, without an inference profile or label")
	}
	if !strings.HasPrefix(m.SecretDeployment, "0x") || !NonzeroHash(strings.TrimPrefix(m.SecretDeployment, "0x")) || m.ConfigBase64 == "" {
		return errors.New("desktop requires public configuration and a nonzero sealed-secret deployment identity")
	}
	p := m.Policy
	if p.CPUPercent < 400 || p.CPUPercent > 1600 || p.MemMiB < 8192 || p.MemMiB > 65536 || p.Vcpus < 4 || p.Vcpus > 16 {
		return errors.New("desktop requires 8192..65536 MiB, 4..16 vCPUs, and 400..1600 CPU percent")
	}
	return nil
}

// ParseDesktop validates an experimental desktop bundle for offline tooling.
// Normal Parse deliberately refuses these bundles until the measured guest
// lifecycle, release verification and secret/worker admission are implemented.
func ParseDesktop(b []byte) (Manifest, []byte, error) {
	m, artifact, err := parseBundle(b, true)
	if err == nil && m.Desktop == nil {
		return m, nil, errors.New("not a desktop bundle")
	}
	return m, artifact, err
}
