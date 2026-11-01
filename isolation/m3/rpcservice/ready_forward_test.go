//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"context"
	"enclave.host/isolation/contract"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestLocalReadyForwardsExactPrivateFrameOnce(t *testing.T) {
	for _, mode := range []string{"valid", "wrong-nonce", "canceled", "full-pipe", "reader-gone"} {
		t.Run(mode, func(t *testing.T) {
			r, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer r.Close()
			defer w.Close()
			out, writer, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer out.Close()
			defer writer.Close()
			binding := contract.RPCStartBinding{AppID: [32]byte{1}, RuntimeID: [32]byte{2}, Deployment: [32]byte{3}, Nonce: [32]byte{4}}
			approval, _ := binding.Frame()
			now, _ := MonotonicNow()
			record := contract.RPCLocalReady{Binding: binding, ObservedMono: now}
			if mode == "wrong-nonce" {
				record.Binding.Nonce[0]++
			}
			raw, _ := record.Frame()
			if _, e = w.Write(raw); e != nil {
				t.Fatal(e)
			}
			w.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if mode == "canceled" {
				cancel()
			}
			if mode == "reader-gone" {
				out.Close()
			}
			if mode == "full-pipe" {
				fd, e := readyOutputFD(writer)
				if e != nil {
					t.Fatal(e)
				}
				for {
					_, e = syscall.Write(fd, make([]byte, 4096))
					if e == syscall.EAGAIN {
						break
					}
					if e != nil {
						t.Fatal(e)
					}
				}
			}
			b := &osBackend{readyReader: r, readyOutput: writer, approvalFrame: approval}
			_, e = b.localReady(ctx)
			if (e == nil) != (mode == "valid") {
				t.Fatal(mode, e)
			}
			if mode == "valid" {
				rec, got, e := ReadLocalReadyEvidence(ctx, out)
				if e != nil || rec != record || !bytes.Equal(got, raw) {
					t.Fatal("changed/undelivered observation", e)
				}
				if _, e = b.localReady(ctx); e == nil {
					t.Fatal("repeated ready publication")
				}
			}
		})
	}
}
func TestLocalReadyOutputRejectsWrongCapability(t *testing.T) {
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	f, e := os.CreateTemp(t.TempDir(), "regular")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	for _, x := range []*os.File{nil, r, f} {
		if ValidateReadyOutput(x) == nil {
			t.Fatal("wrong output accepted")
		}
	}
	if e = ValidateReadyOutput(w); e != nil {
		t.Fatal(e)
	}
	flags, e := fcntl(w.Fd(), syscall.F_GETFD, 0)
	if e != nil || flags&syscall.FD_CLOEXEC == 0 {
		t.Fatal("writer inheritable", e)
	}
}
