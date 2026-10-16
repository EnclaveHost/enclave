package wg

import "syscall"

// Windows sleeps in 15.6 ms steps unless some process asks for finer ones, and the pacer's 1-2 ms waits then cost
// most of each step (pace.go maxPaceCredit). Ask for 1 ms while this process runs; Windows restores the old resolution
// when it exits. A host without winmm keeps the coarse timer and the pacer's oversleep credit.
func init() {
	if p := syscall.NewLazyDLL("winmm.dll").NewProc("timeBeginPeriod"); p.Find() == nil {
		p.Call(1)
	}
}
