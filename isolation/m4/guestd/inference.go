package main

import (
	"enclave.host/isolation/contract"
	"fmt"
	"math"
	"slices"
	"strings"
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
	if !slices.Contains(s.supportedShieldModels(), m.Inference.Model) {
		return "model is not included in the pinned Shield runtime"
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
	models := s.supportedShieldModels()
	floors := map[string]int{}
	for _, model := range models {
		floors[model] = (&contract.Inference{Model: model}).GuestFloorMiB()
	}
	// Legacy supervisors use model as a protocol discriminator; models is the available subset.
	return map[string]any{"shareBoundedMemory": s.ShieldShareMemory, "model": contract.ShieldModel, "models": models, "cards": 2, "cardBudgetBytes": contract.ShieldCardBytes,
		"cardAllocatedBytes": used, "cardFreeBytes": max(int64(0), contract.ShieldCardBytes-used), "minimumGpuMilli": 70,
		"guestFloorMiB": 8192, "modelFloorsMiB": floors, "release": s.ShieldReleases}
}

func (s *server) inferenceVolumes() []map[string]any {
	if !s.ShieldEnabled {
		return []map[string]any{}
	}
	volumes := []map[string]any{{"name": contract.ShieldModel, "bytes": 675710816, "backend": "ggml"}, {"name": contract.Shield27BModel, "bytes": 17559178144, "backend": "ggml", "minimumGpuMilli": 500}}
	out := []map[string]any{}
	for _, volume := range volumes {
		if slices.Contains(s.supportedShieldModels(), volume["name"].(string)) {
			out = append(out, volume)
		}
	}
	return out
}

// The verified release declares the subset it actually packages.
func parseShieldModels(marker string) ([]string, error) {
	models := strings.Fields(marker)
	if len(models) == 0 {
		return nil, fmt.Errorf("Shield release has no supported model marker")
	}
	seen := map[string]bool{}
	for _, model := range models {
		if (model != contract.ShieldModel && model != contract.Shield27BModel) || seen[model] {
			return nil, fmt.Errorf("invalid Shield model marker: %q", model)
		}
		seen[model] = true
	}
	return models, nil
}
func (s *server) supportedShieldModels() []string {
	// Preserve the dual-model default for older callers; production sets this from its verified release.
	if s.ShieldModels == nil {
		return []string{contract.ShieldModel, contract.Shield27BModel}
	}
	return s.ShieldModels
}
