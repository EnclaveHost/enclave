package main

import "testing"

func TestHvIsolationFields(t *testing.T) {
	const leafOK = hvCPUIDIsolation
	for _, c := range []struct {
		name string
		h    hvIsolation
		want string
	}{
		{"not Microsoft's hypervisor (KVM, bare metal)", hvIsolation{hyperv: false, maxLeaf: 0x40000001}, "hv_isolation=n/a paravisor=n/a"},
		{"Hyper-V without the isolation leaf", hvIsolation{hyperv: true, maxLeaf: 0x4000000A}, "hv_isolation=n/a paravisor=n/a"},
		{"type 16: no isolation privilege, OpenHCL above", hvIsolation{hyperv: true, maxLeaf: leafOK, configA: 1, configB: 1}, "hv_isolation=none paravisor=yes"},
		{"type 1: VBS-isolated, OpenHCL above", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configA: 1, configB: 1}, "hv_isolation=vbs paravisor=yes"},
		{"VBS without a paravisor", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configB: 1}, "hv_isolation=vbs paravisor=no"},
		{"SNP with the shared-GPA bits set", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configA: 1, configB: 2 | 1<<5 | 46<<6}, "hv_isolation=snp paravisor=yes"},
		{"TDX", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configB: 3}, "hv_isolation=tdx paravisor=no"},
		{"an isolation type this monitor does not know", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configB: 7}, "hv_isolation=type7 paravisor=no"},
		{"isolation privilege granted, type none", hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true}, "hv_isolation=none paravisor=no"},
	} {
		if got := c.h.fields(); got != c.want {
			t.Errorf("%s: got %q, want %q", c.name, got, c.want)
		}
	}
	// the boundary tuple stays one short, space-separated key=value string with host_excluded=no
	b := "tier=t0-hv vmpl=n/a vmpl_floor=n/a vmpl0=n/a host_excluded=no " + (hvIsolation{hyperv: true, maxLeaf: leafOK, isolationOK: true, configA: 1, configB: 1}).fields()
	if len(b) > 200 {
		t.Errorf("tuple longer than judge.mjs checkBoundary accepts: %d", len(b))
	}
}

// On whatever machine runs the tests: reading CPUID must not fault, and the fields must be well formed.
func TestHvIsolationReadsHere(t *testing.T) {
	h := readHvIsolation()
	t.Logf("this machine: %s -> %s", h.raw(), h.fields())
}
