//go:build linux && amd64

package rpcservice

import (
	"context"
	"errors"
	"io"
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
	record, raw, err := ReadLocalReadyEvidence(ctx, b.readyReader)
	if err != nil {
		return time.Time{}, err
	}
	before := time.Now()
	now, err := MonotonicNow()
	if err != nil {
		return time.Time{}, err
	}
	if err = record.Validate(expected, now); err != nil {
		return time.Time{}, err
	}
	if b.readyOutput != nil {
		if err = forwardLocalReady(ctx, b.readyOutput, raw); err != nil {
			return time.Time{}, err
		}
	}
	if err = ctx.Err(); err != nil {
		return time.Time{}, err
	}
	return before.Add(-time.Duration(now - record.ObservedMono)), nil
}

// The parent has already closed its writer. Exact frame AND EOF are required;
// a lost/held writer or unexpected bytes cannot become a successful observation.
// The caller retains the reader until process exit and drains this routine before
// claiming cleanup, just as for owner approval. This never changes a deadline.
func readLocalReady(ctx context.Context, r *os.File, expected contract.RPCStartBinding) (time.Time, error) {
	record, _, err := ReadLocalReadyEvidence(ctx, r)
	if err != nil {
		return time.Time{}, err
	}
	before := time.Now()
	now, err := MonotonicNow()
	if err != nil {
		return time.Time{}, err
	}
	if err = record.Validate(expected, now); err != nil {
		return time.Time{}, err
	}
	return before.Add(-time.Duration(now - record.ObservedMono)), ctx.Err()
}

// ReadLocalReadyEvidence reads a fixed private inherited pipe, never a path or
// host message. It verifies framing, EOF and freshness, NOT provenance or scope:
// callers must own the pipe topology and compare the actual expected identity.
// Returned bytes retain the front's original request-start timestamp.
func ReadLocalReadyEvidence(ctx context.Context, r *os.File) (contract.RPCLocalReady, []byte, error) {
	fail := func(err error) (contract.RPCLocalReady, []byte, error) { return contract.RPCLocalReady{}, nil, err }
	if ctx == nil {
		return fail(errors.New("readiness context required"))
	}
	var st syscall.Stat_t
	if r == nil || syscall.Fstat(int(r.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO || st.Uid != 0 {
		return fail(errors.New("private RPC readiness reader required"))
	}
	fd := int(r.Fd())
	if _, err := fcntl(uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); err != nil {
		return fail(err)
	}
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
			now, err := MonotonicNow()
			if err != nil {
				return fail(err)
			}
			if err = record.Validate(record.Binding, now); err != nil {
				return fail(err)
			}
			if err = ctx.Err(); err != nil {
				return fail(err)
			}
			return record, append([]byte(nil), buf[:used]...), nil
		}
		if re != nil && re != syscall.EAGAIN && re != syscall.EINTR {
			return fail(re)
		}
		if _, err = pollOwner(fd, 10*time.Millisecond); err != nil {
			return fail(err)
		}
	}
}

// ValidateReadyOutput checks the inherited write-only capability before any
// client launch. CLOEXEC prevents inheritance by clients or the front itself.
func ValidateReadyOutput(w *os.File) error {
	_, err := readyOutputFD(w)
	return err
}
func readyOutputFD(w *os.File) (int, error) {
	if w == nil {
		return -1, errors.New("root private readiness output pipe required")
	}
	// os.File.Fd can restore blocking mode on a pollable Go file. Fetch ONCE,
	// then set flags and use only this cached number through the atomic write.
	fd := int(w.Fd())
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFIFO || st.Uid != 0 {
		return -1, errors.New("root private readiness output pipe required")
	}
	flags, err := fcntl(uintptr(fd), syscall.F_GETFL, 0)
	if err != nil || flags&syscall.O_ACCMODE != syscall.O_WRONLY {
		return -1, errors.New("write-only readiness pipe required")
	}
	if _, err = fcntl(uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); err != nil {
		return -1, err
	}
	if err = syscall.SetNonblock(fd, true); err != nil {
		return -1, err
	}
	return fd, nil
}
func forwardLocalReady(ctx context.Context, w *os.File, raw []byte) error {
	defer w.Close()
	fd, err := readyOutputFD(w)
	if err != nil {
		return err
	}
	record, err := contract.ParseRPCLocalReady(raw)
	if err != nil {
		return err
	}
	now, err := MonotonicNow()
	if err != nil {
		return err
	}
	if err = record.Validate(record.Binding, now); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// One atomic-sized nonblocking write; no partial write, EAGAIN or EINTR retry.
	n, err := syscall.Write(fd, raw)
	if err != nil {
		return err
	}
	if n != len(raw) {
		return io.ErrShortWrite
	}
	return ctx.Err()
}
