package main

import (
	"encoding/binary"
	"fmt"
)

// The partition's isolation configuration AS THE HYPERVISOR STATES IT, read the way Linux reads it
// (arch/x86/kernel/cpu/mshyperv.c): only when the hypervisor is Microsoft's, only when it grants the
// isolation privilege (CPUID 0x40000003 EBX bit 22, HV_ISOLATION) does leaf 0x4000000C carry the
// isolation type (EBX[3:0]: 0 none, 1 VBS, 2 SNP, 3 TDX) and whether a paravisor sits above this guest
// (EAX bit 0).
//
// This is CONFIGURATION, stated by the hypervisor to the guest. It is worth recording - it separates a
// VBS-isolated partition (GuestStateIsolationType 1) from an OpenHCL partition with no isolation (16) in
// the monitor's own words - but it proves nothing to a client: the host chooses the partition type and,
// on this tier, the hypervisor's answers are not signed by anything a client can check. It never changes
// host_excluded, which stays "no" until an exclusion is verifiable.

type hvIsolation struct {
	hyperv      bool   // the hypervisor identifies as "Microsoft Hv"
	maxLeaf     uint32 // CPUID 0x40000000 EAX
	privHigh    uint32 // CPUID 0x40000003 EBX
	configA     uint32 // CPUID 0x4000000C EAX (read when the leaf exists)
	configB     uint32 // CPUID 0x4000000C EBX
	isolationOK bool   // HV_ISOLATION granted, so configB's type is meaningful
}

const (
	hvCPUIDVendor    = 0x40000000
	hvCPUIDFeatures  = 0x40000003
	hvCPUIDIsolation = 0x4000000C
	hvIsolationPriv  = 1 << 22
)

func readHvIsolation() hvIsolation {
	var h hvIsolation
	if !haveCPUID {
		return h
	}
	// CPUID.1:ECX bit 31 is "running under a hypervisor"; without it the 0x40000000 range is undefined
	if _, _, c, _ := cpuid(1, 0); c&(1<<31) == 0 {
		return h
	}
	a, b, c, d := cpuid(hvCPUIDVendor, 0)
	vendor := make([]byte, 12)
	binary.LittleEndian.PutUint32(vendor[0:], b)
	binary.LittleEndian.PutUint32(vendor[4:], c)
	binary.LittleEndian.PutUint32(vendor[8:], d)
	h.maxLeaf = a
	if string(vendor) != "Microsoft Hv" {
		return h
	}
	h.hyperv = true
	if h.maxLeaf >= hvCPUIDFeatures {
		_, h.privHigh, _, _ = cpuid(hvCPUIDFeatures, 0)
	}
	if h.maxLeaf >= hvCPUIDIsolation {
		h.configA, h.configB, _, _ = cpuid(hvCPUIDIsolation, 0)
	}
	h.isolationOK = h.privHigh&hvIsolationPriv != 0 && h.maxLeaf >= hvCPUIDIsolation
	return h
}

// fields -> the tuple's stated fields: hv_isolation=none|vbs|snp|tdx|type<N>|n/a paravisor=yes|no|n/a
// (n/a: not Microsoft's hypervisor, or it does not define the leaf)
func (h hvIsolation) fields() string {
	if !h.hyperv || h.maxLeaf < hvCPUIDIsolation {
		return "hv_isolation=n/a paravisor=n/a"
	}
	iso := "none"
	if h.isolationOK {
		switch t := h.configB & 0xF; t {
		case 0:
			iso = "none"
		case 1:
			iso = "vbs"
		case 2:
			iso = "snp"
		case 3:
			iso = "tdx"
		default:
			iso = fmt.Sprintf("type%d", t)
		}
	}
	pv := "no"
	if h.configA&1 != 0 {
		pv = "yes"
	}
	return "hv_isolation=" + iso + " paravisor=" + pv
}

// raw -> the values the fields came from, for a console line a reviewer can re-derive them from
func (h hvIsolation) raw() string {
	return fmt.Sprintf("hyperv=%v max_leaf=%#x priv_high=%#x isolation_priv=%v config_a=%#x config_b=%#x (stated by the hypervisor, CPUID)",
		h.hyperv, h.maxLeaf, h.privHigh, h.isolationOK, h.configA, h.configB)
}
