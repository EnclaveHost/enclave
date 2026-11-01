//go:build native_desktop && !native_rpc

package main

import "enclave.host/isolation/contract"

const nativeDesktopFront = true
const nativeRPCFront = false

// Only the separately measured native front admits this bundle format.
// Neither a missing bundle nor an ordinary component is an identity fallback.
func loadedAppIDForBuild(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	return loadedAppIDWithParser(bundlePath, wasmPath, statedPath, contract.ParseDesktop, true)
}
