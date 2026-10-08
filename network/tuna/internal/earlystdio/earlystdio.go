// Package earlystdio keeps the process's ORIGINAL stdout for the stdin/stdout protocol (main.go).
//
// On Android, golang.org/x/mobile's mobileinit -- reached through blank imports of golang.org/x/mobile/asset in nkn-sdk-go
// and tuna -- dup3()s a logcat pipe over fd 1 and fd 2 in its init, so a parent (the phone's host app) would read no events.
// Go initializes packages in import-path order, subject to their dependencies (Go 1.21+). This package's path sorts before
// "golang.org/...", and it imports nothing that reaches mobileinit, so its init runs first and keeps a duplicate of the
// parent's pipe. Elsewhere it is os.Stdout itself.
package earlystdio

import (
	"os"
	"runtime"
	"syscall"
)

// Stdout is where events go: the parent's stdout, whatever a later init does to fd 1.
var Stdout = os.Stdout

func init() {
	if runtime.GOOS != "android" {
		return
	}
	if fd, err := syscall.Dup(1); err == nil {
		syscall.CloseOnExec(fd)
		Stdout = os.NewFile(uintptr(fd), "stdout")
	}
}
