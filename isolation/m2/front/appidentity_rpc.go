//go:build native_rpc && !native_desktop

package main

import "enclave.host/isolation/contract"

const nativeDesktopFront = false
const nativeRPCFront = true

// Only this distinct measured front build admits V9. The identity covers the
// actual component plus profile/deployment/two volume IDs in the bundle. No
// absent artifact, bare component or stated-hash fallback is permitted.
func loadedAppIDForBuild(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	return loadedAppIDWithParser(bundlePath, wasmPath, statedPath, contract.ParseRPC, true)
}
