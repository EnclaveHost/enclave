package desktop

import "errors"

// CPUAllocation separates the immutable catalog default from the launcher’s
// purchased quota. Zero requests the default. Every explicit request must fit
// the native desktop's existing 400..1600-percent envelope. The guest still
// checks its actual online processors before creating the cgroup.
func CPUAllocation(policyCPU, policyVCPUs, requestedCPU int) (cpu, vcpus int, err error) {
	if policyCPU < 400 || policyCPU > 1600 || policyVCPUs < 4 || policyVCPUs > 16 || policyCPU > policyVCPUs*100 {
		return 0, 0, errors.New("invalid native catalog CPU policy")
	}
	cpu = requestedCPU
	if cpu == 0 {
		cpu = policyCPU
	}
	// Bound before adding or multiplying untrusted request values.
	if cpu < 400 || cpu > 1600 {
		return 0, 0, errors.New("native CPU allocation must be 400..1600 percent")
	}
	vcpus = policyVCPUs
	if needed := (cpu + 99) / 100; needed > vcpus {
		vcpus = needed
	}
	return cpu, vcpus, nil
}
