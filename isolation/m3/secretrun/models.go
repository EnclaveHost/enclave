package main

// Model volumes in a secret partition domain (m3/monitor/modelvol.go, m3/domexec.c model_volumes): domexec already put
// the preopens, the preloads and the --env NAMES in this process's argv, and their values in its environment. This
// process execs the runtime with an environment of its own making, so it carries exactly those values across - and
// only when the monitor's root-owned, read-only /model.volumes says this domain has model volumes. They are ENCLAVE_
// names, which an owner secret may never be (shieldconfig.Validate), so no secret can shadow one.

import (
	"errors"
	"os"
	"syscall"
)

const modelMarker = "/model.volumes"

var modelEnvNames = []string{"ENCLAVE_MODELS", "ENCLAVE_NN_PRELOADS", "ENCLAVE_NN_SERVE_BYTES", "ENCLAVE_NN_SERVE_KIND",
	"ENCLAVE_GGML_BACKEND_DIR", "ENCLAVE_GGML_N_GPU_LAYERS"}

// modelEnviron -> the model values to carry into the runtime's environment, or none without the monitor's marker.
func modelEnviron(marker string, lookup func(string) (string, bool)) ([]string, error) {
	fi, err := os.Lstat(marker)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !fi.Mode().IsRegular() || fi.Mode().Perm()&0o222 != 0 || !ok || st.Uid != markerOwner || fi.Size() > 1024 {
		return nil, errors.New("the model-volume marker is not the monitor's")
	}
	var out []string
	for _, k := range modelEnvNames {
		if v, ok := lookup(k); ok {
			out = append(out, k+"="+v)
		}
	}
	if len(out) == 0 {
		return nil, errors.New("model volumes, and domexec named none")
	}
	return out, nil
}
