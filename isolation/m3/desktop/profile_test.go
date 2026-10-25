package desktop

import (
	"crypto/sha256"
	"enclave.host/isolation/contract"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func fixture(t *testing.T) (Profile, []byte) {
	t.Helper()
	b, e := os.ReadFile("testdata/profile.json")
	if e != nil {
		t.Fatal(e)
	}
	p, _, e := ParseProfile(b)
	if e != nil {
		t.Fatal(e)
	}
	return p, b
}
func canonical(p Profile) []byte { b, _ := json.Marshal(p); return append(b, '\n') }
func TestProfileCanonicalAndGeometry(t *testing.T) {
	p, b := fixture(t)
	_, id, e := ParseProfile(b)
	if e != nil || id != "1d74f5fc194a759103291ebdd554c21f017555b4ea2ea74ab68f6776d26b2589" {
		t.Fatal(id, e)
	}
	for _, v := range [][]byte{nil, append([]byte(" "), b...), append(b, b...), b[:len(b)-1], []byte(strings.Replace(string(b), "{", "{\"schema\":\"enclave-native-desktop-profile/1\",", 1)), []byte(strings.Replace(string(b), "{", "{\"hostPath\":\"/tmp/root\",", 1))} {
		if _, _, e := ParseProfile(v); e == nil {
			t.Fatal("noncanonical accepted")
		}
	}
	cases := []struct {
		name string
		f    func(*Profile)
	}{
		{"kernel", func(p *Profile) { p.Kernel.Release = "host" }},
		{"zero hash", func(p *Profile) { p.Root.RootHash = strings.Repeat("0", 64) }},
		{"root overflow", func(p *Profile) { p.Root.DataBlocks = ^uint64(0) }},
		{"root length", func(p *Profile) { p.Root.ImageBytes++ }},
		{"root hash length", func(p *Profile) { p.Root.HashBytes += 4096 }},
		{"model overflow", func(p *Profile) { p.Models.DataBlocks = ^uint64(0) }},
		{"model hash offset", func(p *Profile) { p.Models.HashStartBlock-- }},
		{"model length", func(p *Profile) { p.Models.ImageBytes -= 4096 }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := p
			c.f(&q)
			if _, _, e := ParseProfile(canonical(q)); e == nil {
				t.Fatal("invalid profile accepted")
			}
		})
	}
}
func TestControllerAndManifestBound(t *testing.T) {
	p, _ := fixture(t)
	artifact := []byte("public fixture component")
	hash := sha256.Sum256(artifact)
	p.ControllerSha256 = hex.EncodeToString(hash[:])
	_, id, e := ParseProfile(canonical(p))
	if e != nil {
		t.Fatal(e)
	}
	m := contract.Manifest{Desktop: &contract.Desktop{Profile: contract.DesktopProfile, ProfileSha256: id, GPUMilli: 500}, World: contract.WorldCLI, HTTP: 8000, Ports: contract.DesktopPorts(), SecretDeployment: "0x" + strings.Repeat("1", 64), ConfigBase64: "e30=", Policy: contract.Policy{CPUPercent: 400, MemMiB: 8192, Vcpus: 4}}
	if e = p.CheckBundle(m, artifact); e != nil {
		t.Fatal(e)
	}
	if p.CheckBundle(m, append(artifact, 'x')) == nil {
		t.Fatal("wrong controller accepted")
	}
	m.Desktop.ProfileSha256 = strings.Repeat("2", 64)
	if p.CheckBundle(m, artifact) == nil {
		t.Fatal("wrong profile accepted")
	}
	m.Desktop.ProfileSha256 = id
	m.Desktop.GPUMilli = 499
	if p.CheckBundle(m, artifact) == nil {
		t.Fatal("wrong worker share accepted")
	}
	m.Desktop = nil
	if p.CheckBundle(m, artifact) == nil {
		t.Fatal("ordinary manifest accepted")
	}
}
func TestLimitsAndCapacity(t *testing.T) {
	v, e := Limits(400, 8192, 4)
	if e != nil || len(v) != 5 {
		t.Fatal(v, e)
	}
	want := map[string]string{"cpu.max": "400000 100000", "memory.max": "8589934592", "memory.swap.max": "0", "memory.oom.group": "1", "pids.max": "1024"}
	for _, p := range v {
		if want[p[0]] != p[1] {
			t.Fatal(p)
		}
	}
	for _, a := range [][3]int{{399, 8192, 4}, {1601, 8192, 16}, {400, 8191, 4}, {400, 65537, 4}, {400, 8192, 3}, {400, 8192, 17}, {800, 8192, 4}} {
		if _, e := Limits(a[0], a[1], a[2]); e == nil {
			t.Fatal(a)
		}
	}
	if CheckCapacity(8192, 4, 4, 9*1024*1024) != nil {
		t.Fatal("valid capacity")
	}
	for _, a := range [][4]uint64{{8192, 4, 4, 8192 * 1024}, {8192, 3, 4, 9 * 1024 * 1024}, {65537, 16, 16, 128 * 1024 * 1024}} {
		if CheckCapacity(int(a[0]), int(a[1]), int(a[2]), a[3]) == nil {
			t.Fatal(a)
		}
	}
}
