package main

import "syscall"

// POSIX_FADV_DONTNEED on Linux (s390x differs; this file is amd64 only).
const fadvDontneed = 4

// fadviseDontneed is posix_fadvise(fd, off, n, POSIX_FADV_DONTNEED). The
// kernel drops only clean, unlocked, unmapped page-cache pages of this file,
// keeps partial pages at either end unless the end is EOF, and never drops
// other files' caches.
func fadviseDontneed(fd uintptr, off, n int64) error {
	for {
		_, _, e := syscall.Syscall6(syscall.SYS_FADVISE64, fd, uintptr(off), uintptr(n), fadvDontneed, 0, 0)
		if e == syscall.EINTR {
			continue
		}
		if e != 0 {
			return e
		}
		return nil
	}
}
