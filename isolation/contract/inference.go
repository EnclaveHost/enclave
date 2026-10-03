package contract

import "fmt"

// Inference is measured with the app. No worker address or host environment is
// accepted here: the release fixes the private broker routes and public model.
type Inference struct {
	Model    string `json:"model"`
	GPUMilli int    `json:"gpuMilli"`
}

const ShieldModel = "qwen2.5-0.5b-q8-gguf"
const Shield27BModel = "qwen3.8-27b-mtp-q4-vl-gguf"

func (i *Inference) GuestFloorMiB() int {
	if i != nil && i.Model == Shield27BModel {
		// Includes 128-pad pools and both ordinary/MTP contexts, each with
		// eight active, six conversation and eight shared-prefix state slots.
		return 73728
	}
	return 8192
}

const ShieldCardBytes int64 = 31 << 30
const ShieldMinBytes int64 = 2 << 30

func (i *Inference) Validate() error {
	if i == nil {
		return nil
	}
	if i.Model != ShieldModel && i.Model != Shield27BModel {
		return fmt.Errorf("unsupported isolated inference model %q", i.Model)
	}
	minimum := 65
	if i.Model == Shield27BModel {
		minimum = 500
	}
	if i.GPUMilli < minimum || i.GPUMilli > 1000 {
		return fmt.Errorf("isolated inference requires gpuMilli in %d..1000", minimum)
	}
	return nil
}

// Each physical worker reserves the same share. Round down bytes, consistently
// with the worker protocol; admission accounts for both cards separately.
func (i *Inference) CardBytes() int64 {
	if i == nil {
		return 0
	}
	return ShieldCardBytes * int64(i.GPUMilli) / 1000
}
