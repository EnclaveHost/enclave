package vsock

import (
	"errors"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestAlreadyConnectedSocketDoesNotLoseReadyEvent(t *testing.T) {
	fds, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	f := os.NewFile(uintptr(fds[0]), "connected-socket")
	defer f.Close()
	defer syscall.Close(fds[1])
	// Give the poller time to observe initial writability. The previous unconditional
	// first wait times out here even though the socket is connected throughout.
	time.Sleep(time.Millisecond)
	if e = f.SetWriteDeadline(time.Now().Add(100 * time.Millisecond)); e != nil {
		t.Fatal(e)
	}
	if e = waitConnected(f); e != nil {
		t.Fatalf("connected socket waited for another edge: %v", e)
	}
}
func TestZeroSocketErrorDoesNotMeanConnected(t *testing.T) {
	fd, e := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	f := os.NewFile(uintptr(fd), "unconnected-socket")
	defer f.Close()
	f.SetWriteDeadline(time.Now().Add(20 * time.Millisecond))
	if e = waitConnected(f); !errors.Is(e, os.ErrDeadlineExceeded) {
		t.Fatalf("unconnected socket returned %v", e)
	}
}
func TestConnectionRefusalSurvivesPoll(t *testing.T) {
	bound, e := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer syscall.Close(bound)
	if e = syscall.Bind(bound, &syscall.SockaddrInet4{Addr: [4]byte{127, 0, 0, 1}}); e != nil {
		t.Fatal(e)
	}
	addr, e := syscall.Getsockname(bound)
	if e != nil {
		t.Fatal(e)
	}
	fd, e := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM|syscall.SOCK_NONBLOCK|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	f := os.NewFile(uintptr(fd), "refused-socket")
	defer f.Close()
	f.SetWriteDeadline(time.Now().Add(time.Second))
	e = syscall.Connect(fd, addr)
	if e == syscall.EINPROGRESS {
		e = waitConnected(f)
	}
	if !errors.Is(e, syscall.ECONNREFUSED) {
		t.Fatalf("refusal returned %v", e)
	}
}
