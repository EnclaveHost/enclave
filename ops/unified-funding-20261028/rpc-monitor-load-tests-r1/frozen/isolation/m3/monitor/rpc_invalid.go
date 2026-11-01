//go:build native_rpc && native_desktop

package main

var _ = nativeRPCAndDesktopMustNotShareAMeasuredMonitor
