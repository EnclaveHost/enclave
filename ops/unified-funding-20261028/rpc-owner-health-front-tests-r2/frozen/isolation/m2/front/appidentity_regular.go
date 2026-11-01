//go:build !native_desktop && !native_rpc

package main

const nativeDesktopFront = false
const nativeRPCFront = false

func loadedAppIDForBuild(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	return loadedAppID(bundlePath, wasmPath, statedPath)
}
