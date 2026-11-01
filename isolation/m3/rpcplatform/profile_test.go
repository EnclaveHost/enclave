package rpcplatform

import (
	"crypto/sha256"
	"enclave.host/isolation/contract"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"testing"
)

func hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func fixture() (Profile, []byte, []byte) {
	controller := []byte{0, 97, 115, 109, 13, 0, 1, 0} // wire fixture, not a deployable controller
	entry := make([]byte, 64)
	copy(entry, []byte{127, 69, 76, 70, 2, 1, 1})
	entry[16] = 2
	entry[18] = 62
	p := Profile{ControllerSha256: hash(controller), EntrySha256: hash(entry), Kernel: Kernel{strings.Repeat("1", 64), strings.Repeat("2", 64), KernelRelease}, Profile: contract.RPCProfile,
		Root: RootVolume{262144, 8458240, strings.Repeat("3", 64), 1073741824, strings.Repeat("4", 64), strings.Repeat("5", 64), strings.Repeat("6", 64)}, Schema: Schema, WrapperSha256: hash([]byte("wrapper fixture"))}
	return p, controller, entry
}

func TestProfileRejectsUnknownDuplicateTrailingAndDesktop(t *testing.T) {
	p, _, _ := fixture()
	b, err := p.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	if _, id, err := ParseProfile(b); err != nil || id != hash(b) {
		t.Fatal(id, err)
	}
	for _, bad := range [][]byte{nil, append([]byte(" "), b...), append(b, b...), b[:len(b)-1], []byte(strings.Replace(string(b), "{", "{\"hostPath\":\"/tmp\",", 1)), []byte(strings.Replace(string(b), "{", "{\"schema\":\"duplicate\",", 1)), []byte(strings.Replace(string(b), Schema, "enclave-native-desktop-profile/1", 1)), []byte(strings.Replace(string(b), Schema, "enclave-native-rpc-profile/1", 1))} {
		if _, _, err := ParseProfile(bad); err == nil {
			t.Fatal("noncanonical/mixed profile accepted")
		}
	}
}

func TestProfileComponentAndGeometryMutations(t *testing.T) {
	p, _, _ := fixture()
	for _, change := range []func(*Profile){func(p *Profile) { p.WrapperSha256 = strings.Repeat("0", 64) }, func(p *Profile) { p.Root.DataBlocks = ^uint64(0) }, func(p *Profile) { p.Root.ImageBytes++ }, func(p *Profile) { p.Root.HashBytes++ }, func(p *Profile) { p.EntrySha256 = strings.Repeat("0", 64) }, func(p *Profile) { p.Kernel.Release = "unqualified" }, func(p *Profile) { p.Profile = contract.DesktopProfile }} {
		q := p
		change(&q)
		if q.Validate() == nil {
			t.Fatal("invalid component/geometry accepted")
		}
	}
}

func TestProfileBindsControllerEntryAndV9(t *testing.T) {
	p, controller, entry := fixture()
	if p.CheckWrapper([]byte("wrapper fixture")) != nil || p.CheckWrapper([]byte("other wrapper")) == nil || p.CheckWrapper(nil) == nil {
		t.Fatal("wrapper pin")
	}
	b, _ := p.Canonical()
	m := contract.Manifest{RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: hash(b), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}, World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64),
		ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}}
	if err := p.CheckBundle(m, controller); err != nil {
		t.Fatal(err)
	}
	if err := p.CheckEntry(entry); err != nil {
		t.Fatal(err)
	}
	if p.CheckBundle(m, append(controller, 1)) == nil {
		t.Fatal("changed controller accepted")
	}
	changed := append([]byte(nil), entry...)
	changed[63]++
	if p.CheckEntry(changed) == nil {
		t.Fatal("changed entry accepted")
	}
	if p.CheckEntry([]byte("shell script")) == nil {
		t.Fatal("non-ELF accepted")
	}
	m.RPC.ProfileSha256 = strings.Repeat("d", 64)
	if p.CheckBundle(m, controller) == nil {
		t.Fatal("changed profile accepted")
	}
	m.RPC = nil
	if p.CheckBundle(m, controller) == nil {
		t.Fatal("ordinary app accepted")
	}
}
