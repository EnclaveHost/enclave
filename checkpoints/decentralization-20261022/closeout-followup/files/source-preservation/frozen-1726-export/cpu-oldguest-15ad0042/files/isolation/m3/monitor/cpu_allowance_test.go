package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// The launcher's CPU allocation RAISES a bundle domain's cgroup quota above the catalog cpuPercent, as its RAM allocation
// raises memory.max; it never lowers the catalog minimum, never exceeds the processors online, and is never ignored.
func TestCPUAllowanceRaisesCatalogShare(t *testing.T) {
	man := &contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}
	ok := []struct {
		req      request
		cpus     int
		cpu, mem int
	}{
		{request{}, 4, 100, 512},                          // nothing asked: the catalog's share, exactly as before
		{request{CPU: 336, MemMiB: 20643}, 4, 336, 20643}, // a 21% share of 16 VPs: 4 VPs at 84%
		{request{CPU: 400}, 4, 400, 512},                  // every online processor
		{request{CPU: 100}, 1, 100, 512},                  // the catalog share itself is always allowed
		{request{CPU: 208}, 3, 208, 512},                  // 13%: 3 VPs at 69.333%, quota rounded UP so the VM cap binds
	}
	for _, c := range ok {
		pol, err := allocatedPolicy(man, c.req, c.cpus)
		if err != nil || pol.CPUPercent != c.cpu || pol.MemMiB != c.mem || pol.Vcpus != 1 {
			t.Fatalf("%+v on %d CPUs: %+v %v", c.req, c.cpus, pol, err)
		}
	}
	if man.Policy.CPUPercent != 100 {
		t.Fatalf("the hashed manifest's policy was changed: %+v", man.Policy)
	}
	for _, c := range []struct {
		req  request
		cpus int
	}{{request{CPU: 16}, 16}, {request{CPU: -5}, 4}, {request{CPU: 401}, 4}, {request{CPU: 200}, 1}, {request{MemMiB: 256}, 4}} {
		if pol, err := allocatedPolicy(man, c.req, c.cpus); err == nil {
			t.Fatalf("%+v on %d CPUs was accepted: %+v", c.req, c.cpus, pol)
		}
	}
	// a bare artifact (no manifest) keeps the request's numbers, exactly as before
	if pol, err := allocatedPolicy(nil, request{CPU: 50, MemMiB: 128}, 1); err != nil || pol.CPUPercent != 50 || pol.MemMiB != 128 {
		t.Fatalf("bare artifact: %+v %v", pol, err)
	}
}

// What was allocated is what the domain's cgroup gets: cpu.max quota per 100000 us period.
func TestCPUAllowanceReachesCgroup(t *testing.T) {
	man := &contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}
	pol, err := allocatedPolicy(man, request{CPU: 336}, 4)
	if err != nil {
		t.Fatal(err)
	}
	m := &monitor{}
	d := &domain{CPU: pol.CPUPercent, MemMiB: pol.MemMiB, cgroup: filepath.Join(t.TempDir(), "dom1")}
	// cgroupfs creates the control files with the directory; a plain directory needs them made first
	if err := os.MkdirAll(d.cgroup, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"cpu.max", "memory.max", "pids.max"} {
		if err := os.WriteFile(filepath.Join(d.cgroup, f), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := m.cgroup(d); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(filepath.Join(d.cgroup, "cpu.max"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(got)) != "336000 100000" {
		t.Fatalf("cpu.max = %q", got)
	}
}
