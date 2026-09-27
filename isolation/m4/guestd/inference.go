package main

import (
	"enclave.host/isolation/contract"
	"fmt"
	"math"
)

// The measured release supplies both GPU routes and the pinned model. The host
// ledger controls availability only; it cannot supply engine arguments or keys.
func (s *server) inferenceRefusal(r *Request, m contract.Manifest, legacy bool) string {
	if m.Inference == nil {
		if r.GPUShare != 0 {
			return "GPU share requires a measured inference bundle"
		}
		return ""
	}
	if !s.ShieldEnabled || legacy {
		return "this guest manager has no admitted Shield inference release"
	}
	if math.IsNaN(r.GPUShare) || math.IsInf(r.GPUShare, 0) || math.Abs(r.GPUShare*1000-float64(m.Inference.GPUMilli)) > 1e-7 {
		return "GPU allocation differs from the measured bundle"
	}
	return ""
}
func (s *server) gpuAllocatedLocked() int64 {
	var bytes int64
	for _, v := range s.vms {
		if v.holds() {
			bytes += v.GPUCardBytes
		}
	}
	return bytes
}
func (s *server) gpuAdmitLocked(bytes int64) error {
	if bytes == 0 {
		return nil
	}
	if !s.ShieldEnabled {
		return fmt.Errorf("Shield inference is disabled")
	}
	free := contract.ShieldCardBytes - s.gpuAllocatedLocked()
	if bytes > free {
		return fmt.Errorf("GPU pool full: requires %d bytes per card, available %d", bytes, max(int64(0), free))
	}
	return nil
}
func (s *server) inferenceHealthLocked() any {
	if !s.ShieldEnabled {
		return nil
	}
	used := s.gpuAllocatedLocked()
	return map[string]any{"model": contract.ShieldModel, "cards": 2, "cardBudgetBytes": contract.ShieldCardBytes,
		"cardAllocatedBytes": used, "cardFreeBytes": max(int64(0), contract.ShieldCardBytes-used), "minimumGpuMilli": 70,
		"guestFloorMiB": 8192, "release": s.ShieldReleases}
}

func (s *server) inferenceVolumes() []map[string]any {
	if !s.ShieldEnabled {
		return []map[string]any{}
	}
	return []map[string]any{{"name": contract.ShieldModel, "bytes": 675710816, "backend": "ggml"}}
}
