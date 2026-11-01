//go:build linux && amd64

package rpcservice

import (
	"context"
	"errors"
	"os"
	"syscall"
	"time"

	"enclave.host/isolation/contract"
)

func (b *osBackend) prepareReady() error {
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	if err = syscall.SetNonblock(int(r.Fd()), true); err != nil {
		r.Close()
		w.Close()
		return err
	}
	b.readyReader, b.readyWriter = r, w
	return nil
}

func (b *osBackend) localReady(ctx context.Context) (time.Time, error) {
	if !b.readyUsed.CompareAndSwap(false, true) {
		return time.Time{}, errors.New("RPC readiness already consumed")
	}
	expected, err := contract.ParseRPCStartBinding(b.approvalFrame)
	if err != nil {
		return time.Time{}, err
	}
	return readLocalReady(ctx, b.readyReader, expected)
}

// The parent has already closed its writer. Exact frame AND EOF are required;
// a lost/held writer or unexpected bytes cannot become a successful observation.
// The caller retains the reader until process exit and drains this routine before
// claiming cleanup, just as for owner approval. This never changes a deadline.
func readLocalReady(ctx context.Context, r *os.File, expected contract.RPCStartBinding) (time.Time, error) {
	fail := func(err error) (time.Time, error) { return time.Time{}, err }
	if _, err := expected.Frame(); err != nil {
		return fail(err)
	}
	var st syscall.Stat_t
	if r == nil || syscall.Fstat(int(r.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO {
		return fail(errors.New("private RPC readiness reader required"))
	}
	fd := int(r.Fd())
	flags, err := fcntl(uintptr(fd), syscall.F_GETFL, 0)
	if err != nil || flags&syscall.O_ACCMODE != syscall.O_RDONLY {
		return fail(errors.New("RPC readiness reader required"))
	}
	if err = syscall.SetNonblock(fd, true); err != nil {
		return fail(err)
	}
	buf := make([]byte, contract.RPCLocalReadyFrameSize+1)
	used := 0
	for {
		if err = ctx.Err(); err != nil {
			return fail(err)
		}
		n, re := syscall.Read(fd, buf[used:])
		if n > 0 {
			used += n
		}
		if used > contract.RPCLocalReadyFrameSize {
			return fail(errors.New("oversized RPC readiness"))
		}
		if re == nil && n == 0 {
			record, err := contract.ParseRPCLocalReady(buf[:used])
			if err != nil {
				return fail(err)
			}
			// Earlier Go sample makes conversion conservative, never fresher.
			before := time.Now()
			now, err := MonotonicNow()
			if err != nil {
				return fail(err)
			}
			if err = record.Validate(expected, now); err != nil {
				return fail(err)
			}
			if err = ctx.Err(); err != nil {
				return fail(err)
			}
			return before.Add(-time.Duration(now - record.ObservedMono)), nil
		}
		if re != nil && re != syscall.EAGAIN && re != syscall.EINTR {
			return fail(re)
		}
		if _, err = pollOwner(fd, 10*time.Millisecond); err != nil {
			return fail(err)
		}
	}
}
