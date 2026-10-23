package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// THE REAL LOAD PATH, without root: a catalog bundle (cpuPercent 100) is loaded with the launcher's cpu, through m.load's
// own read, hash, parse and policy, and startDomain is replaced only to stop before any process exists and to point the
// domain's cgroup writer at a temporary directory. Uses only load, cgroup and the startDomain seam, so the same file runs
// on the pre-fix monitor, where the request's cpu was ignored and the domain kept cpu.max "100000 100000".
func loadWithCPU(t *testing.T, cpu int) (*domain, string, error) {
	t.Helper()
	if runtime.NumCPU() < 4 {
		t.Skip("needs 4 online processors for a 336% allocation")
	}
	component := append([]byte{0x00, 0x61, 0x73, 0x6d, 0x0d, 0x00, 0x01, 0x00}, []byte("cpu-load-test")...)
	bundle, err := contract.Build(contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}, component)
	if err != nil {
		t.Fatal(err)
	}
	cg := filepath.Join(t.TempDir(), "dom")
	orig := startDomain
	t.Cleanup(func() { startDomain = orig })
	startDomain = func(m *monitor, d *domain, _ []byte) error {
		d.cgroup = cg // cgroupfs makes the control files with the directory; a plain one needs them first
		if err := os.MkdirAll(cg, 0o755); err != nil {
			return err
		}
		for _, f := range []string{"cpu.max", "memory.max", "pids.max"} {
			if err := os.WriteFile(filepath.Join(cg, f), nil, 0o644); err != nil {
				return err
			}
		}
		return m.cgroup(d)
	}
	m := newMonitor(false, "/plat", t.TempDir(), 40000, 5000)
	m.noDomains = ""
	d, err := m.load(bufio.NewReader(bytes.NewReader(bundle)), request{Cmd: "load", Label: "cpu", Size: len(bundle), CPU: cpu})
	if err != nil {
		return nil, "", err
	}
	got, err := os.ReadFile(filepath.Join(cg, "cpu.max"))
	if err != nil {
		t.Fatal(err)
	}
	return d, strings.TrimSpace(string(got)), nil
}

func TestLoadAppliesTheLaunchersCPUAllocation(t *testing.T) {
	d, cpuMax, err := loadWithCPU(t, 336)
	if err != nil {
		t.Fatalf("a 336%% allocation over a catalog 100%% was refused: %v", err)
	}
	ans, _ := json.Marshal(d) // the load answer is this domain, encoded
	if d.CPU != 336 || cpuMax != "336000 100000" || !bytes.Contains(ans, []byte(`"cpuPercent":336`)) {
		t.Fatalf("asked 336: domain cpuPercent %d, cgroup cpu.max %q, answer %s", d.CPU, cpuMax, ans)
	}
}

func TestLoadWithoutAllocationKeepsTheCatalogShare(t *testing.T) {
	d, cpuMax, err := loadWithCPU(t, 0)
	if err != nil || d.CPU != 100 || cpuMax != "100000 100000" {
		t.Fatalf("no allocation: %v %v %q", d, err, cpuMax)
	}
}

func TestLoadRefusesAnAllocationBelowTheCatalogShare(t *testing.T) {
	if d, cpuMax, err := loadWithCPU(t, 16); err == nil {
		t.Fatalf("16%% under a catalog 100%% was loaded (cpuPercent %d, cpu.max %q) instead of refused", d.CPU, cpuMax)
	}
}
