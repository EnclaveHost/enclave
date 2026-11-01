//go:build native_rpc && native_desktop

package main

// Deliberate compile failure: these measured runtime families are exclusive.
var _ = nativeRPCAndDesktopBuildsCannotBeCombined
