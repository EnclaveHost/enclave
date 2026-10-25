//go:build !native_desktop

package main

const nativeDesktopFront = false

func loadedAppIDForBuild(bundlePath, wasmPath, statedPath string) ([]byte, string, error) {
	return loadedAppID(bundlePath, wasmPath, statedPath)
}
