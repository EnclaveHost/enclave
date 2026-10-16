package wg

import (
	"syscall"
	"unsafe"
)

// Windows may give a background process coarse timers: 15.6 ms steps unless the process asks for finer ones, and
// power throttling (efficiency mode) coalesces them whatever it asked. The pacer's 1-2 ms waits then cost most of each
// step (pace.go maxPaceCredit). So, while this process runs: opt out of execution-speed throttling and of the
// timer-resolution throttling, and ask for 1 ms. Each is best effort; a host without them keeps the pacer's oversleep
// credit.
func init() {
	k32 := syscall.NewLazyDLL("kernel32.dll")
	if p := k32.NewProc("SetProcessInformation"); p.Find() == nil {
		const (
			processPowerThrottling        = 4   // PROCESS_INFORMATION_CLASS ProcessPowerThrottling
			throttleExecutionSpeed        = 0x1 // PROCESS_POWER_THROTTLING_EXECUTION_SPEED
			throttleIgnoreTimerResolution = 0x4 // PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION
		)
		// ControlMask names the policies this process sets; StateMask 0 turns them off (never throttle)
		state := struct{ Version, ControlMask, StateMask uint32 }{1, throttleExecutionSpeed | throttleIgnoreTimerResolution, 0}
		current := ^uintptr(0) // GetCurrentProcess()
		p.Call(current, processPowerThrottling, uintptr(unsafe.Pointer(&state)), unsafe.Sizeof(state))
	}
	if p := syscall.NewLazyDLL("winmm.dll").NewProc("timeBeginPeriod"); p.Find() == nil {
		p.Call(1)
	}
}
