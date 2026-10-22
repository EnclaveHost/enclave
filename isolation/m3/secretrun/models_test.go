package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestModelEnvironCarriesDomexecsValuesOnlyWithTheMonitorsMarker(t *testing.T) {
	markerOwner = uint32(os.Getuid())
	marker := filepath.Join(t.TempDir(), "model.volumes")
	env := map[string]string{"ENCLAVE_MODELS": "qwen-a", "ENCLAVE_NN_PRELOADS": "qwen-a", "ENCLAVE_NN_SERVE_BYTES": "805306368",
		"ENCLAVE_NN_SERVE_KIND": "RAM", "ENCLAVE_GGML_BACKEND_DIR": "/plat/rt/backends", "ENCLAVE_GGML_N_GPU_LAYERS": "0", "OTHER": "x"}
	lookup := func(k string) (string, bool) { v, ok := env[k]; return v, ok }

	// no marker: nothing, whatever the environment holds
	if got, err := modelEnviron(marker, lookup); err != nil || got != nil {
		t.Fatalf("no marker: %v %v", got, err)
	}
	os.WriteFile(marker, []byte("M1\nvol=qwen-a\n"), 0o444)
	got, err := modelEnviron(marker, lookup)
	if err != nil || strings.Join(got, " ") != "ENCLAVE_MODELS=qwen-a ENCLAVE_NN_PRELOADS=qwen-a ENCLAVE_NN_SERVE_BYTES=805306368 ENCLAVE_NN_SERVE_KIND=RAM ENCLAVE_GGML_BACKEND_DIR=/plat/rt/backends ENCLAVE_GGML_N_GPU_LAYERS=0" {
		t.Fatalf("carried %v %v", got, err)
	}
	// a runtime without wasi-nn: only the names
	got, _ = modelEnviron(marker, func(k string) (string, bool) {
		if k == "ENCLAVE_MODELS" {
			return "qwen-a", true
		}
		return "", false
	})
	if strings.Join(got, " ") != "ENCLAVE_MODELS=qwen-a" {
		t.Fatalf("names only: %v", got)
	}
	// a marker and nothing from domexec: refused, never a runtime without its volumes' names
	if _, err := modelEnviron(marker, func(string) (string, bool) { return "", false }); err == nil {
		t.Fatal("a marker with nothing to carry")
	}
	// a marker anyone may write is not the monitor's
	os.Chmod(marker, 0o644)
	if _, err := modelEnviron(marker, lookup); err == nil || !strings.Contains(err.Error(), "not the monitor's") {
		t.Fatalf("writable marker: %v", err)
	}
	os.Remove(marker)
	os.Symlink("/etc/hostname", marker)
	if _, err := modelEnviron(marker, lookup); err == nil {
		t.Fatal("a symlinked marker")
	}
}
