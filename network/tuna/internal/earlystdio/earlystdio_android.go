package earlystdio

// Android only (the _android file suffix): syscall.Dup does not exist on Windows, so this cannot sit behind a runtime
// GOOS check in a file every platform compiles - that broke the Windows build of enclave-tuna.exe.

import (
	"os"
	"syscall"
)

func init() {
	if fd, err := syscall.Dup(1); err == nil {
		syscall.CloseOnExec(fd)
		Stdout = os.NewFile(uintptr(fd), "stdout")
	}
}
