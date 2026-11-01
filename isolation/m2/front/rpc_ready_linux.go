//go:build linux && amd64

package main

import (
	"context"
	"errors"
	"math"
	"os"
	"sync/atomic"
	"syscall"
	"unsafe"

	"enclave.host/isolation/contract"
)

type rpcReadyDelivery struct {
	writer   *os.File
	fd       int
	approval *rpcStartApproval
	binding  contract.RPCStartBinding
	used     atomic.Bool
}

// FD5 is a second private pipe, distinct from the owner approval pipe. Only
// the exact front child inherits its writer; neither clients nor controller do.
func readRPCReadyDelivery(a *rpcStartApproval) (*rpcReadyDelivery, error) {
	return rpcReadyFromFD(5, a)
}

func rpcReadyFromFD(fd int, a *rpcStartApproval) (*rpcReadyDelivery, error) {
	if a == nil {
		return nil, errors.New("RPC startup binding required")
	}
	b, err := contract.ParseRPCStartBinding(a.frame)
	if err != nil {
		return nil, err
	}
	var st, start syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO || st.Uid != 0 || syscall.Fstat(a.fd, &start) != nil || st.Dev == start.Dev && st.Ino == start.Ino {
		return nil, errors.New("distinct root-owned private RPC readiness pipe required")
	}
	flags, _, e := syscall.Syscall(syscall.SYS_FCNTL, uintptr(fd), syscall.F_GETFL, 0)
	if e != 0 || flags&syscall.O_ACCMODE != syscall.O_WRONLY {
		return nil, errors.New("RPC readiness writer required")
	}
	syscall.CloseOnExec(fd)
	if err = syscall.SetNonblock(fd, true); err != nil {
		return nil, err
	}
	return &rpcReadyDelivery{writer: os.NewFile(uintptr(fd), "rpc-local-readiness"), fd: fd, approval: a, binding: b}, nil
}

func rpcReadyNow() (uint64, error) {
	var t syscall.Timespec
	_, _, e := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, 1, uintptr(unsafe.Pointer(&t)), 0)
	if e != 0 {
		return 0, e
	}
	if t.Sec < 0 || t.Nsec < 0 || t.Nsec >= 1_000_000_000 || uint64(t.Sec) > (math.MaxInt64-uint64(t.Nsec))/1_000_000_000 {
		return 0, errors.New("invalid RPC readiness clock")
	}
	return uint64(t.Sec)*1_000_000_000 + uint64(t.Nsec), nil
}

// sample does not consume the delivery on ordinary not-ready observations.
// Only a successful check with a fresh request-start timestamp can be sent.
func (r *rpcReadyDelivery) sample(ctx context.Context, check func(context.Context) error) (uint64, error) {
	if r == nil || !r.approval.succeeded.Load() || r.used.Load() {
		return 0, errors.New("RPC owner approval required before health")
	}
	start, err := rpcReadyNow()
	if err != nil {
		return 0, err
	}
	if err = check(ctx); err != nil {
		return 0, err
	}
	if err = ctx.Err(); err != nil {
		return 0, err
	}
	now, err := rpcReadyNow()
	if err != nil {
		return 0, err
	}
	return start, (contract.RPCLocalReady{Binding: r.binding, ObservedMono: start}).Validate(r.binding, now)
}

func (r *rpcReadyDelivery) publish(observed uint64) error {
	if r == nil || !r.used.CompareAndSwap(false, true) {
		return errors.New("RPC readiness missing or consumed")
	}
	defer r.writer.Close()
	if !r.approval.succeeded.Load() {
		return errors.New("RPC owner approval not delivered")
	}
	now, err := rpcReadyNow()
	if err != nil {
		return err
	}
	record := contract.RPCLocalReady{Binding: r.binding, ObservedMono: observed}
	if err = record.Validate(r.binding, now); err != nil {
		return err
	}
	frame, err := record.Frame()
	if err != nil {
		return err
	}
	n, err := syscall.Write(r.fd, frame)
	if err != nil || n != len(frame) {
		return errors.New("RPC readiness delivery failed; no retry")
	}
	return nil
}
