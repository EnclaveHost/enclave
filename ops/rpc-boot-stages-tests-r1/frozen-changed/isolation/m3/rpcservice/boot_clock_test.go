//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

// The qualification builds the maintained C producer separately with -Werror.
// This tests the actual inherited FD3 after C exec against the Go consumer.
func TestBootClockCInterop(t *testing.T) {
	fixture := os.Getenv("RPC_BOOT_CLOCK_FIXTURE")
	if fixture == "" {
		t.Skip("requires separately compiled inert C fixture")
	}
	now, err := MonotonicNow()
	if err != nil || now < uint64(2*time.Second) {
		t.Fatal(now, err)
	}
	origin := now - uint64(2*time.Second)
	for _, tc := range []struct {
		name   string
		origin uint64
		valid  bool
	}{
		{"original", origin, true},
		{"future", now + uint64(time.Minute), false},
		{"overflow", ^uint64(0), false},
		{"expired", now - uint64(StartupWindow) - 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fds, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
			if e != nil {
				t.Fatal(e)
			}
			parent, child := os.NewFile(uintptr(fds[0]), "parent"), os.NewFile(uintptr(fds[1]), "child")
			defer parent.Close()
			defer child.Close()
			cmd := exec.Command(fixture, fmt.Sprint(tc.origin))
			cmd.ExtraFiles = []*os.File{child}
			output, e := cmd.CombinedOutput()
			if !tc.valid {
				if e == nil {
					t.Fatal("invalid clock accepted")
				}
				return
			}
			if e != nil {
				t.Fatal(e, string(output))
			}
			b, oob := make([]byte, 41), make([]byte, syscall.CmsgSpace(4))
			n, on, flags, _, e := syscall.Recvmsg(int(parent.Fd()), b, oob, syscall.MSG_DONTWAIT|syscall.MSG_CMSG_CLOEXEC)
			if e != nil || n != 40 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 {
				t.Fatal(n, flags, e)
			}
			messages, e := syscall.ParseSocketControlMessage(oob[:on])
			if e != nil || len(messages) != 1 {
				t.Fatal(messages, e)
			}
			rights, e := syscall.ParseUnixRights(&messages[0])
			if e != nil || len(rights) != 1 {
				t.Fatal(rights, e)
			}
			clock := os.NewFile(uintptr(rights[0]), "C-clock")
			defer clock.Close()
			actual, e := OriginalEntryOrigin(clock)
			if e != nil || actual != tc.origin {
				t.Fatal(actual, tc.origin, e)
			}
			boot, e := entryBoot()
			if e != nil {
				t.Fatal(e)
			}
			want, e := encodeEntry(boot, tc.origin)
			if e != nil || !bytes.Equal(want, b[:n]) {
				t.Fatal("C/Go clock frame differs", e)
			}
		})
	}
}
