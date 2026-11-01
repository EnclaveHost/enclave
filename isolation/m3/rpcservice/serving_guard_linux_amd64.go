//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math"
	"os"
	"runtime"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

// The channel is a private inherited capability from measured PID1/monitor to
// its original broker. These records are NOT publicly authenticated permits.
// Only the broker may translate a coordinated owner/storage/host commit into
// them. A digest pins that decision; it does not prove health or authority.
const guardFrameSize = 88
const guardFresh = uint64(4 * time.Second)
const guardPermit = uint64(30 * time.Second)

type GuardBinding struct {
	Origin, Deadline, Observed uint64
	PreparedSHA256             [32]byte
}
type guardState struct {
	binding         GuardBinding
	until, sequence uint64
	phase           byte
}

func newGuardState(origin, deadline uint64) (guardState, error) {
	if origin > math.MaxInt64-uint64(StartupWindow) || deadline != origin+uint64(StartupWindow) {
		return guardState{}, errors.New("original guard interval required")
	}
	return guardState{binding: GuardBinding{Origin: origin, Deadline: deadline}, until: deadline}, nil
}
func (s *guardState) accept(b []byte, now uint64) error {
	bad := errors.New("serving guard record refused")
	if len(b) != guardFrameSize || string(b[:8]) != "ERPCSV01" || !bytes.Equal(b[9:16], make([]byte, 7)) || now < s.binding.Origin || now >= s.until || now > math.MaxInt64 {
		return bad
	}
	origin, d := binary.LittleEndian.Uint64(b[16:]), binary.LittleEndian.Uint64(b[24:])
	observed, until, seq := binary.LittleEndian.Uint64(b[32:]), binary.LittleEndian.Uint64(b[40:]), binary.LittleEndian.Uint64(b[48:])
	var digest [32]byte
	copy(digest[:], b[56:])
	if origin != s.binding.Origin || d != s.binding.Deadline {
		return bad
	}
	if b[8] == 1 {
		if s.phase != 0 || seq != 0 || until != 0 || digest == [32]byte{} || observed < origin || observed > now || now-observed >= guardFresh || now >= d {
			return bad
		}
		s.binding.Observed = observed
		s.binding.PreparedSHA256 = digest
		s.phase = 1
		return nil
	}
	if observed != s.binding.Observed || digest != s.binding.PreparedSHA256 || seq == 0 || s.sequence == math.MaxUint64 || seq != s.sequence+1 || until <= now || until > math.MaxInt64 || until-now > guardPermit {
		return bad
	}
	switch b[8] {
	case 2:
		if s.phase != 1 || seq != 1 || now >= d || observed > now || now-observed >= guardFresh {
			return bad
		}
	case 3:
		if s.phase != 2 || until <= s.until {
			return bad
		}
	default:
		return bad
	}
	s.phase = 2
	s.sequence = seq
	s.until = until
	return nil
}
func guardFrame(op byte, b GuardBinding, sequence, expiry uint64) []byte {
	raw := make([]byte, guardFrameSize)
	copy(raw, "ERPCSV01")
	raw[8] = op
	for i, n := range []uint64{b.Origin, b.Deadline, b.Observed, expiry, sequence} {
		binary.LittleEndian.PutUint64(raw[16+i*8:], n)
	}
	copy(raw[56:], b.PreparedSHA256[:])
	return raw
}

// GuardSocketFD validates a held connected private root Unix seqpacket socket,
// sets CLOEXEC/NONBLOCK, and returns the cached FD. Do not call File.Fd again:
// Go can restore blocking mode. This checks type, not capability provenance.
func GuardSocketFD(f *os.File) (int, error) {
	if f == nil {
		return -1, errors.New("missing private guardian capability")
	}
	fd := int(f.Fd())
	var st syscall.Stat_t
	typ, e := syscall.GetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_TYPE)
	peer, pe := syscall.Getpeername(fd)
	_, unix := peer.(*syscall.SockaddrUnix)
	if e != nil || pe != nil || !unix || typ != syscall.SOCK_SEQPACKET || syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK {
		return -1, errors.New("private root Unix seqpacket required")
	}
	if _, e = fcntl(uintptr(fd), syscall.F_SETFD, syscall.FD_CLOEXEC); e != nil {
		return -1, e
	}
	if e = syscall.SetNonblock(fd, true); e != nil {
		return -1, e
	}
	return fd, nil
}
func recvGuard(fd int) ([]byte, error) {
	raw := make([]byte, guardFrameSize)
	n, _, flags, _, e := syscall.Recvmsg(fd, raw, nil, syscall.MSG_DONTWAIT|syscall.MSG_TRUNC|syscall.MSG_CMSG_CLOEXEC)
	if e != nil {
		return nil, e
	}
	if n != len(raw) || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 {
		return nil, errors.New("guardian message truncated, ancillary, or channel lost")
	}
	return raw, nil
}
func sendGuard(fd int, b []byte) error {
	return syscall.Sendmsg(fd, b, nil, nil, syscall.MSG_DONTWAIT|syscall.MSG_NOSIGNAL)
}

// GuardClient retains the original descriptor for its entire process lifetime.
// Shutdown wakes the remote guard even if another goroutine is blocked; it
// never closes/recycles a descriptor out from under an in-flight transaction.
type GuardClient struct {
	file   *os.File
	fd     int
	mu     sync.Mutex
	state  guardState
	failed bool
}

func NewGuardClient(f *os.File, origin, deadline uint64) (*GuardClient, error) {
	fd, e := GuardSocketFD(f)
	if e != nil {
		return nil, e
	}
	s, e := newGuardState(origin, deadline)
	if e != nil {
		return nil, e
	}
	return &GuardClient{file: f, fd: fd, state: s}, nil
}
func (g *GuardClient) Shutdown() {
	if g != nil {
		_ = syscall.Shutdown(g.fd, syscall.SHUT_RDWR)
	}
}
func (g *GuardClient) Prepare(ctx context.Context, b GuardBinding) error {
	return g.exchange(ctx, guardFrame(1, b, 0, 0))
}

// Commit and Renew are for the future coordinated broker commit caller. No
// activated callsite emits them until every independent boundary participates.
func (g *GuardClient) Commit(ctx context.Context, b GuardBinding, expiry uint64) error {
	return g.exchange(ctx, guardFrame(2, b, 1, expiry))
}
func (g *GuardClient) Renew(ctx context.Context, b GuardBinding, seq, expiry uint64) error {
	return g.exchange(ctx, guardFrame(3, b, seq, expiry))
}
func (g *GuardClient) exchange(ctx context.Context, raw []byte) (err error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	defer runtime.KeepAlive(g.file)
	defer func() {
		if err != nil {
			g.failed = true
			g.Shutdown()
		}
	}()
	if g.failed {
		return errors.New("guardian channel consumed by failure")
	}
	now, e := MonotonicNow()
	if e != nil {
		return e
	}
	next := g.state
	if e = next.accept(raw, now); e != nil {
		return e
	}
	deadline := time.Now().Add(3 * time.Second)
	for _, limit := range []uint64{g.state.until, g.state.binding.Deadline} {
		if g.state.phase == 2 && limit == g.state.binding.Deadline {
			continue
		}
		if limit <= now {
			return errors.New("guardian exchange expired")
		}
		if d := time.Now().Add(time.Duration(limit - now)); d.Before(deadline) {
			deadline = d
		}
	}
	ctx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	if e = ctx.Err(); e != nil {
		return e
	}
	if e = sendGuard(g.fd, raw); e != nil {
		return e
	} // one atomic submission; never retransmit
	expected := append([]byte(nil), raw...)
	expected[8] |= 0x80
	for {
		if e = ctx.Err(); e != nil {
			return e
		}
		now, e = MonotonicNow()
		if e != nil || now >= g.state.until {
			return errors.New("guardian acknowledgement late")
		}
		reply, e := recvGuard(g.fd)
		if e == syscall.EAGAIN || e == syscall.EINTR {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Millisecond):
			}
			continue
		}
		if e != nil {
			return e
		}
		if !bytes.Equal(reply, expected) {
			return errors.New("guardian acknowledgement changed")
		}
		now, e = MonotonicNow()
		if e != nil || now >= g.state.until || now >= next.until || ctx.Err() != nil {
			return errors.New("guardian expired before acknowledgement")
		}
		if raw[8] == 2 && (now < next.binding.Observed || now-next.binding.Observed >= guardFresh) {
			return errors.New("commit acknowledgement no longer fresh")
		}
		g.state = next
		return nil
	}
}

// watchServingEntry is the independent native namespace PID1 watcher. It runs
// before mounts/client setup, never takes lifecycle/auth locks, and watches both
// exact monitor pidfd and the original broker capability through all phases.
func watchServingEntry(owner, channel int, origin, deadline uint64, armed chan<- struct{}, terminate func(int)) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	state, e := newGuardState(origin, deadline)
	close(armed)
	if e != nil {
		terminate(124)
		return
	}
	fail := func() { terminate(124) }
	for {
		now, e := MonotonicNow()
		if e != nil || now < origin || now >= state.until {
			fail()
			return
		}
		wait := state.until - now
		if wait > uint64(20*time.Millisecond) {
			wait = uint64(20 * time.Millisecond)
		}
		p := [2]entryPollFD{{FD: int32(owner), Events: 1}, {FD: int32(channel), Events: 1}}
		ts := syscall.NsecToTimespec(int64(wait))
		_, _, eno := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&p[0])), 2, uintptr(unsafe.Pointer(&ts)), 0, 0, 0)
		if eno == syscall.EINTR {
			continue
		}
		now, e = MonotonicNow()
		if eno != 0 || e != nil || now >= state.until || p[0].Revents != 0 {
			fail()
			return
		}
		if p[1].Revents == 0 {
			continue
		}
		if p[1].Revents != 1 {
			fail()
			return
		}
		raw, e := recvGuard(channel)
		if e != nil {
			fail()
			return
		}
		prior := state.until
		if e = state.accept(raw, now); e != nil {
			fail()
			return
		}
		now, e = MonotonicNow()
		dead, de := pollOwner(owner, 0)
		if e != nil || de != nil || dead || now >= prior || now >= state.until {
			fail()
			return
		}
		raw[8] |= 0x80
		if sendGuard(channel, raw) != nil {
			fail()
			return
		}
	}
}
