package main

import "math"

// The deployment's CPU share also buys RAM. A model floor is a minimum
// requirement, never permission to exceed that purchase. Kernel/runtime and
// QEMU overhead stay in the pool reservation, outside the app's RAM allowance.
func (s *server) memoryShareRefusal(share float64, policyMiB, guestMiB int) map[string]any {
	if math.IsNaN(share) || math.IsInf(share, 0) || share <= 0 || share > 1 {
		return map[string]any{"error": "invalid_cpu_share", "detail": "cpuShare must be finite, greater than zero and at most one"}
	}
	if !s.Budget.configured() {
		return nil // admitLocked reports pool_unconfigured
	}
	allowance := int(math.Floor(share*float64(s.Budget.MemMiB) + 1e-7))
	// The generic boot floor is platform overhead. Only inference's extra
	// memory above that floor is chargeable in addition to manifest memory.
	need := max(policyMiB, guestMiB-guestRuntimeMiB)
	if guestMiB == guestFloorMiB {
		need = policyMiB
	}
	if need > allowance {
		return map[string]any{"error": "ram_share_too_small", "allowedMiB": allowance,
			"requiredMiB": need, "minimumCpuMilli": (need*1000 + s.Budget.MemMiB - 1) / s.Budget.MemMiB,
			"detail": "the isolated app's RAM requirement exceeds its CPU share; resize the deployment before starting it"}
	}
	return nil
}
