package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// The launcher's CPU allocation is the purchased share of the host, applied exactly: above the catalog cpuPercent (a
// share of several processors) and BELOW it (a share smaller than one processor: 1% of 16 logical processors is 16% of
// one), never past the processors online, never ignored. RAM keeps its catalog minimum.
func TestCPUAllowanceIsThePurchasedShare(t *testing.T) {
	man := &contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}
	ok := []struct {
		req      request
		cpus     int
		cpu, mem int
	}{
		{request{}, 4, 100, 512},                          // nothing asked: the catalog's share, exactly as before
		{request{CPU: 16, MemMiB: 983}, 1, 16, 983},       // 1% of 16 LPs: 16% of one processor, NOT the catalog's 100
		{request{CPU: 32}, 1, 32, 512},                    // 2%
		{request{CPU: 64}, 1, 64, 512},                    // 4%
		{request{CPU: 1}, 1, 1, 512},                      // the cgroup's smallest quota (1 ms per 100 ms period)
		{request{CPU: 336, MemMiB: 20643}, 4, 336, 20643}, // a 21% share of 16 VPs: 4 VPs at 84%
		{request{CPU: 400}, 4, 400, 512},                  // 25%: every online processor
		{request{CPU: 100}, 1, 100, 512},                  // 6.25%: one whole processor
		{request{CPU: 208}, 3, 208, 512},                  // 13%: 2.08 processors
	}
	for _, c := range ok {
		pol, err := allocatedPolicy(man, c.req, c.cpus, false)
		if err != nil || pol.CPUPercent != c.cpu || pol.MemMiB != c.mem || pol.Vcpus != 1 {
			t.Fatalf("%+v on %d CPUs: %+v %v", c.req, c.cpus, pol, err)
		}
		// an explicit allocation wins on a VM-bound image too
		if pol, err := allocatedPolicy(man, c.req, c.cpus, true); c.req.CPU != 0 && (err != nil || pol.CPUPercent != c.cpu) {
			t.Fatalf("VM-bound %+v on %d CPUs: %+v %v", c.req, c.cpus, pol, err)
		}
	}
	if man.Policy.CPUPercent != 100 {
		t.Fatalf("the hashed manifest's policy was changed: %+v", man.Policy)
	}
	for _, c := range []struct {
		req  request
		cpus int
	}{{request{CPU: -5}, 4}, {request{CPU: 401}, 4}, {request{CPU: 200}, 1}, {request{CPU: 101}, 1}, {request{CPU: 1601}, 16},
		{request{MemMiB: 256}, 4}, {request{CPU: 16, MemMiB: 256}, 1}} {
		if pol, err := allocatedPolicy(man, c.req, c.cpus, false); err == nil {
			t.Fatalf("%+v on %d CPUs was accepted: %+v", c.req, c.cpus, pol)
		}
	}
	// a bare artifact (no manifest) keeps the request's numbers, exactly as before
	if pol, err := allocatedPolicy(nil, request{CPU: 50, MemMiB: 128}, 1, true); err != nil || pol.CPUPercent != 50 || pol.MemMiB != 128 {
		t.Fatalf("bare artifact: %+v %v", pol, err)
	}
}

// What was allocated is what the domain's cgroup gets: cpu.max quota per 100000 us period.
func TestCPUAllowanceReachesCgroup(t *testing.T) {
	man := &contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}
	pol, err := allocatedPolicy(man, request{CPU: 336}, 4, false)
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

// On a VM-bound image (one app per hypervisor-capped partition) a domain with no explicit allocation gets every online
// processor; an explicit allocation still wins, and an image without the marker keeps the catalog share.
func TestVMBoundImageGivesTheDomainEveryOnlineProcessor(t *testing.T) {
	man := &contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 512, Vcpus: 1}}
	for _, c := range []struct {
		req     request
		cpus    int
		vmBound bool
		want    int
	}{
		{request{}, 4, true, 400}, {request{}, 1, true, 100}, {request{}, 4, false, 100}, {request{CPU: 208}, 3, true, 208},
	} {
		pol, err := allocatedPolicy(man, c.req, c.cpus, c.vmBound)
		if err != nil || pol.CPUPercent != c.want {
			t.Fatalf("%+v on %d CPUs vmBound=%v: %+v %v", c.req, c.cpus, c.vmBound, pol, err)
		}
	}
	shield := &contract.Manifest{Policy: contract.Policy{CPUPercent: 400, MemMiB: 8192, Vcpus: 4}}
	if pol, _ := allocatedPolicy(shield, request{}, 2, true); pol.CPUPercent != 400 {
		t.Fatalf("a catalog share above the online processors is never lowered: %+v", pol)
	}
}
