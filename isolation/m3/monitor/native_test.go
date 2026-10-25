package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/desktop"
)

func nativeFixture(t *testing.T) (*nativeGuest, contract.Manifest, []byte) {
	t.Helper()
	raw, err := os.ReadFile("../desktop/testdata/profile.json")
	if err != nil {
		t.Fatal(err)
	}
	p, _, err := desktop.ParseProfile(raw)
	if err != nil {
		t.Fatal(err)
	}
	artifact := []byte{0, 97, 115, 109, 13, 0, 1, 0}
	sum := sha256.Sum256(artifact)
	p.ControllerSha256 = hex.EncodeToString(sum[:])
	raw, err = json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	p, id, err := desktop.ParseProfile(append(raw, '\n'))
	if err != nil {
		t.Fatal(err)
	}
	man := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.DesktopPorts(), Policy: contract.Policy{CPUPercent: 400, MemMiB: 8192, Vcpus: 4},
		Desktop: &contract.Desktop{Profile: contract.DesktopProfile, ProfileSha256: id, GPUMilli: 500}, SecretDeployment: "0x" + strings.Repeat("1", 64),
		ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"egress":"public-web"}`))}
	return &nativeGuest{profile: p, sha: id}, man, artifact
}

func TestNativeAdmissionBindsControllerProfileAndResources(t *testing.T) {
	g, man, artifact := nativeFixture(t)
	if err := g.validate(man, artifact, 400, 8192); err != nil {
		t.Fatal(err)
	}
	if err := g.validate(man, artifact, 400, 16384); err != nil {
		t.Fatal("larger permitted RAM allocation", err)
	}
	for _, c := range []struct {
		name     string
		cpu, mem int
	}{
		{"CPU override", 500, 8192}, {"below minimum", 400, 8191}, {"above native ceiling", 400, 65537},
	} {
		t.Run(c.name, func(t *testing.T) {
			if g.validate(man, artifact, c.cpu, c.mem) == nil {
				t.Fatal("unsafe allocation accepted")
			}
		})
	}
	for _, c := range []struct {
		name string
		edit func(*contract.Manifest)
	}{
		{"profile identity", func(m *contract.Manifest) { m.Desktop.ProfileSha256 = strings.Repeat("e", 64) }},
		{"raw inference", func(m *contract.Manifest) { m.Inference = &contract.Inference{} }},
		{"unsealed controller", func(m *contract.Manifest) { m.SecretDeployment = "" }},
		{"missing egress", func(m *contract.Manifest) { m.ConfigBase64 = base64.StdEncoding.EncodeToString([]byte(`{}`)) }},
		{"CPU exceeds vCPUs", func(m *contract.Manifest) { m.Policy.CPUPercent = 500 }},
	} {
		t.Run(c.name, func(t *testing.T) {
			m := man
			d := *man.Desktop
			m.Desktop = &d
			c.edit(&m)
			if g.validate(m, artifact, m.Policy.CPUPercent, m.Policy.MemMiB) == nil {
				t.Fatal("invalid native bundle accepted")
			}
		})
	}
	if g.validate(man, append(artifact, 0), 400, 8192) == nil {
		t.Fatal("different controller accepted")
	}
}

func TestNativeLoadNeverFallsBackToOrdinaryArtifactOrProbe(t *testing.T) {
	g, man, artifact := nativeFixture(t)
	m := newMonitor(false, "/not-opened", "/not-opened", 40000, 5000)
	m.native = g
	ordinary, err := contract.Build(contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}, artifact)
	if err != nil {
		t.Fatal(err)
	}
	native, err := contract.Build(man, artifact)
	if err != nil {
		t.Fatal(err)
	}
	for _, data := range [][]byte{artifact, ordinary} {
		if _, err = m.load(bufio.NewReader(bytes.NewReader(data)), request{Size: len(data)}); err == nil {
			t.Fatal("ordinary app entered native guest")
		}
	}
	if _, err = m.load(bufio.NewReader(bytes.NewReader(native)), request{Size: len(native), Probe: true}); err == nil {
		t.Fatal("probe replaced native controller")
	}
	if len(m.doms) != 0 || len(m.byUID) != 0 {
		t.Fatal("rejected load registered a domain")
	}
}

func TestNativeControllerReportSocketStaysPrivate(t *testing.T) {
	d := &domain{dir: "/domains/desktop-test", native: &nativeDomain{}}
	if d.frontPath("monitor.sock") != "/domains/desktop-test/run/front/monitor.sock" {
		t.Fatal("native report socket outside private front directory")
	}
}
