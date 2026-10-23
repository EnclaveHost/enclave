package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// THE REAL LOAD PATH, without root: a catalog bundle (cpuPercent 100) is loaded with the launcher's cpu, through m.load's
// own read, hash, parse and policy, and startDomain is replaced only to stop before any process exists and to point the
// domain's cgroup writer at a temporary directory. Uses only load, cgroup and the startDomain seam, so the same file runs
// on the pre-fix monitor, where the request's cpu was ignored and the domain kept cpu.max "100000 100000".
func loadWithCPU(t *testing.T, cpu int) (*domain, string, error) { return loadOn(t, cpu, "/plat") }

func loadOn(t *testing.T, cpu int, plat string) (*domain, string, error) {
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
	m := newMonitor(false, plat, t.TempDir(), 40000, 5000)
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

// A purchased share smaller than one processor reaches the domain's cgroup exactly: 1%, 2% and 4% of 16 logical
// processors are 16%, 32% and 64% of one, under a catalog cpuPercent of 100. The pre-fix monitor refused them, so the
// launcher could only leave such a domain at the catalog's whole processor (6.25% of the host for a 1% purchase).
func TestLoadAppliesAPurchasedShareBelowOneProcessor(t *testing.T) {
	for _, cpu := range []int{16, 32, 64} {
		d, cpuMax, err := loadWithCPU(t, cpu)
		if err != nil {
			t.Fatalf("%d%% under a catalog 100%% was refused: %v", cpu, err)
		}
		ans, _ := json.Marshal(d)
		want := strconv.Itoa(cpu*1000) + " 100000"
		if d.CPU != cpu || cpuMax != want || !bytes.Contains(ans, []byte(`"cpuPercent":`+strconv.Itoa(cpu)+`,`)) {
			t.Fatalf("asked %d: domain cpuPercent %d, cgroup cpu.max %q (want %q), answer %s", cpu, d.CPU, cpuMax, want, ans)
		}
	}
}

func TestLoadRefusesAnAllocationPastTheOnlineProcessors(t *testing.T) {
	if d, cpuMax, err := loadWithCPU(t, runtime.NumCPU()*100+1); err == nil {
		t.Fatalf("more than every online processor was loaded (cpuPercent %d, cpu.max %q) instead of refused", d.CPU, cpuMax)
	}
}

// THE LEGACY CPU IMAGE carries the VM-bound marker in its measured platform directory: with the installed loader (which
// sends no cpu) every domain gets all online processors, so the partition's exact Hyper-V cap is what binds. Same real
// load path; on the pre-fix monitor the domain stayed at the catalog 100%.
func TestLoadOnVMBoundImageGivesEveryOnlineProcessor(t *testing.T) {
	plat := t.TempDir()
	if err := os.WriteFile(filepath.Join(plat, "cpu-vm-bound.enabled"), []byte("1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	n := runtime.NumCPU()
	d, cpuMax, err := loadOn(t, 0, plat)
	want := strconv.Itoa(n*100000) + " 100000"
	if err != nil || d.CPU != n*100 || cpuMax != want {
		t.Fatalf("VM-bound image, %d online: %v cpuPercent %v cpu.max %q (want %q)", n, err, d, cpuMax, want)
	}
}
