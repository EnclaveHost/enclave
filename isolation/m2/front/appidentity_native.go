//go:build native_desktop

package main

import "enclave.host/isolation/contract"

const nativeDesktopFront = true

// Only the separately measured native front admits this bundle format.
// Neither a missing bundle nor an ordinary component is an identity fallback.
func loadedAppIDForBuild(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	return loadedAppIDWithParser(bundlePath, wasmPath, statedPath, contract.ParseDesktop, true)
}
