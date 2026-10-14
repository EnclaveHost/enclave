package main

// loadedAppID: the AppID this front puts in report_data[32:64], derived from the bytes init will actually RUN, not read
// from a file that states it.
//
// On the M2/M4a path init runs /app.wasm (dominit.c). The image also carries /app.bundle (the canonical contract bundle
// the identity is defined over: contract.AppID = sha256 of ALL its bytes) and /app.sha256 (what the build wrote). The front:
//   1. parses /app.bundle with contract.Parse (canonical manifest, artifact hash matching the bytes);
//   2. requires the bundle's artifact to be BYTE-IDENTICAL to /app.wasm, so the identity covers what runs;
//   3. takes the AppID as sha256(bundle), and requires /app.sha256 to agree (a disagreement is a broken image).
// An image without /app.bundle (the older bare-artifact M2 build) gets the contract's bare-artifact identity,
// sha256(/app.wasm), from the same bytes. The files sit in the initramfs (root-owned, in guest memory the host cannot
// write under SNP, and the app runs as an unprivileged user that cannot write them), and this runs before init starts
// the app, so what is hashed here is what runs.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"

	"enclave.host/isolation/contract"
)

func loadedAppID(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	wasm, err := os.ReadFile(wasmPath)
	if err != nil {
		return nil, "", fmt.Errorf("the app the runtime loads (%s): %w", wasmPath, err)
	}
	var id [32]byte
	how := ""
	b, err := os.ReadFile(bundlePath)
	switch {
	case err == nil:
		_, artifact, perr := contract.Parse(b)
		if perr != nil {
			return nil, "", fmt.Errorf("%s: %w", bundlePath, perr)
		}
		if !bytes.Equal(artifact, wasm) {
			return nil, "", fmt.Errorf("%s is not the artifact %s carries: the identity would not cover what runs", wasmPath, bundlePath)
		}
		id = contract.AppID(b)
		how = "sha256 of the bundle whose artifact is the loaded component"
	case errors.Is(err, os.ErrNotExist):
		id = sha256.Sum256(wasm)
		how = "sha256 of the loaded bare component (no bundle in this image)"
	default:
		return nil, "", fmt.Errorf("%s: %w", bundlePath, err)
	}
	if raw, err := os.ReadFile(statedPath); err == nil {
		if strings.TrimSpace(string(raw)) != hex.EncodeToString(id[:]) {
			return nil, "", fmt.Errorf("%s states %.16s..., but the loaded code is %x...: refusing a broken image", statedPath, strings.TrimSpace(string(raw)), id[:8])
		}
	}
	return id[:], how, nil
}
