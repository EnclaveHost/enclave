//go:build linux

package main

import (
	"bytes"
	"errors"
	"os"
	"sync/atomic"
	"syscall"

	"enclave.host/isolation/contract"
)

type rpcStartApproval struct {
	writer *os.File
	fd     int
	frame  []byte
	used   atomic.Bool
}

// The dedicated supervisor supplies FD3 (only this front owns the write end)
// and FD4 (fully sealed binding). No pathname or caller readiness flag exists.
func readRPCStartApproval(app []byte, runtime, deployment [32]byte) (*rpcStartApproval, error) {
	return rpcApprovalFromFDs(3, 4, app, runtime, deployment)
}
func rpcApprovalFromFDs(writerFD, bindingFD int, app []byte, runtime, deployment [32]byte) (*rpcStartApproval, error) {
	var st syscall.Stat_t
	if syscall.Fstat(writerFD, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO {
		return nil, errors.New("private RPC approval pipe required")
	}
	flags, _, e := syscall.Syscall(syscall.SYS_FCNTL, uintptr(writerFD), syscall.F_GETFL, 0)
	if e != 0 || flags&syscall.O_ACCMODE != syscall.O_WRONLY {
		return nil, errors.New("RPC approval writer required")
	}
	if syscall.Fstat(bindingFD, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Size != contract.RPCStartFrameSize || st.Uid != 0 {
		return nil, errors.New("bounded root-owned RPC binding required")
	}
	seals, _, e := syscall.Syscall(syscall.SYS_FCNTL, uintptr(bindingFD), 1034, 0)
	if e != 0 || seals&15 != 15 {
		return nil, errors.New("sealed RPC binding required")
	}
	raw := make([]byte, contract.RPCStartFrameSize)
	if n, err := syscall.Pread(bindingFD, raw, 0); err != nil || n != len(raw) {
		return nil, errors.New("RPC binding read failed")
	}
	b, err := contract.ParseRPCStartBinding(raw)
	if err != nil || !bytes.Equal(app, b.AppID[:]) || runtime != b.RuntimeID || deployment != b.Deployment {
		return nil, errors.New("RPC approval binding differs from loaded code/runtime/deployment")
	}
	syscall.CloseOnExec(writerFD)
	syscall.CloseOnExec(bindingFD)
	if err = syscall.SetNonblock(writerFD, true); err != nil {
		return nil, err
	}
	return &rpcStartApproval{writer: os.NewFile(uintptr(writerFD), "rpc-owner-approval"), fd: writerFD, frame: raw}, nil
}

// Consumed before the single nonblocking <=PIPE_BUF write. Any failure or lost
// result is terminal; never retry a partially observed authorization.
func (a *rpcStartApproval) approve() error {
	if a == nil || !a.used.CompareAndSwap(false, true) {
		return errors.New("RPC approval missing or consumed")
	}
	defer a.writer.Close()
	n, err := syscall.Write(a.fd, a.frame)
	if err != nil || n != len(a.frame) {
		return errors.New("RPC approval delivery failed; no retry")
	}
	return nil
}
