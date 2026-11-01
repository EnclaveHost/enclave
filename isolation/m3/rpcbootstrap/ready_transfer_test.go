//go:build linux && amd64

package rpcbootstrap

import (
	"os"
	"syscall"
	"testing"
)

func TestBrokerReadinessWriterRequiresExactLiveProcessAndOneTransfer(t *testing.T) {
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	fd, _, eno := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if eno != 0 {
		t.Fatal(eno)
	}
	pid := os.NewFile(fd, "held-process")
	defer pid.Close()
	b := &Broker{readyWriter: w, pidfd: pid}
	got, e := b.TakeReadyWriter()
	if e != nil || got != w {
		t.Fatal("exact writer not transferred", e)
	}
	if _, e = b.TakeReadyWriter(); e == nil {
		t.Fatal("duplicate transfer")
	}
	for _, bad := range []*Broker{nil, {}, {readyWriter: w}, {pidfd: pid}} {
		if _, e = bad.TakeReadyWriter(); e == nil {
			t.Fatal("missing capability accepted")
		}
	}
}
