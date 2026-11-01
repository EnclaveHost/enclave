//go:build linux && amd64

package main

import (
	"bytes"
	"io"
	"os"
	"syscall"
	"testing"
	"unsafe"

	"enclave.host/isolation/contract"
)

func TestRPCStartPrivateCapabilityBindingAndOnce(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root ownership check requires isolated user-namespace fixture")
	}
	for _, mode := range []string{"valid", "wrong-app", "wrong-runtime", "wrong-deployment", "unsealed", "reader-as-writer"} {
		t.Run(mode, func(t *testing.T) {
			b := contract.RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
			frame, err := b.Frame()
			if err != nil {
				t.Fatal(err)
			}
			name := []byte("rpc-test-binding\x00")
			fd, _, e := syscall.Syscall(319, uintptr(unsafe.Pointer(&name[0])), 3, 0)
			if e != 0 {
				t.Fatal(e)
			}
			binding := os.NewFile(fd, "test-binding")
			defer binding.Close()
			if _, err = binding.Write(frame); err != nil {
				t.Fatal(err)
			}
			if mode != "unsealed" {
				if _, _, e = syscall.Syscall(syscall.SYS_FCNTL, fd, 1033, 15); e != 0 {
					t.Fatal(e)
				}
			}
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			defer w.Close()
			writerFD, err := syscall.Dup(int(w.Fd()))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "reader-as-writer" {
				syscall.Close(writerFD)
				writerFD, err = syscall.Dup(int(r.Fd()))
				if err != nil {
					t.Fatal(err)
				}
			}
			switch mode {
			case "wrong-app":
				b.AppID[0]++
			case "wrong-runtime":
				b.RuntimeID[0]++
			case "wrong-deployment":
				b.Deployment[0]++
			}
			a, err := rpcApprovalFromFDs(writerFD, int(fd), b.AppID[:], b.RuntimeID, b.Deployment)
			if mode != "valid" {
				syscall.Close(writerFD)
				if err == nil {
					t.Fatal("invalid capability accepted")
				}
				return
			}
			if err != nil {
				syscall.Close(writerFD)
				t.Fatal(err)
			}
			w.Close() // only approval owns the duplicate writer now
			if err = a.approve(); err != nil {
				t.Fatal(err)
			}
			if err = a.approve(); err == nil {
				t.Fatal("approval replayed")
			}
			got, err := io.ReadAll(r)
			if err != nil || !bytes.Equal(got, frame) {
				t.Fatal("approval differs", err)
			}
		})
	}
}
