//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

const soPeerPIDFD = 77 // Linux SO_PEERPIDFD, asm-generic/socket.h; no PID-only fallback

type brokerPoll struct {
	FD               int32
	Events, Returned int16
}

// BrokerSession owns one accepted monitor connection and exact kernel process
// references. It authenticates/reserves, but cannot grant writable roots: the
// independently supervised exporter and its fencing integration remain required.
// Context cancellation is advisory to callers, NOT a native-operation deadline
// or an independent OS watchdog. Persistent intents remain consumed on loss.
type BrokerSession struct {
	done                 chan struct{}
	request              Request
	conn                 *net.UnixConn
	peer, owner, clock   *os.File
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	consumed             bool
	accepted             bool
	reserved, exportUsed bool
	intent               *BrokerIntent
	consent              *bootstrap.RPCStorageConsent
	remoteReceipt        *os.File
	exportRaw            net.Conn
	authorizationUntil   time.Time
	once                 sync.Once
}

func (s *BrokerSession) Request() Request         { return s.request }
func (s *BrokerSession) Context() context.Context { return s.ctx }

func pidfdPID(f *os.File) (int, error) {
	if f == nil {
		return 0, errors.New("missing monitor pidfd")
	}
	var fs syscall.Statfs_t
	if syscall.Statfs("/proc", &fs) != nil || fs.Type != 0x9fa0 {
		return 0, errors.New("actual proc view required")
	}
	link, e := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", f.Fd()))
	if e != nil || link != "anon_inode:[pidfd]" {
		return 0, errors.New("actual kernel pidfd required")
	}
	in, e := os.Open(fmt.Sprintf("/proc/self/fdinfo/%d", f.Fd()))
	if e != nil {
		return 0, e
	}
	raw, e := io.ReadAll(io.LimitReader(in, 4097))
	in.Close()
	if e != nil || len(raw) > 4096 {
		return 0, errors.New("bounded pidfd identity required")
	}
	pid, seen := 0, false
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "Pid:") {
			if seen {
				return 0, errors.New("ambiguous pidfd identity")
			}
			seen = true
			v := strings.TrimSpace(strings.TrimPrefix(line, "Pid:"))
			pid, e = strconv.Atoi(v)
			if e != nil || pid <= 0 || strconv.Itoa(pid) != v {
				return 0, errors.New("live peer pidfd required")
			}
		}
	}
	if !seen {
		return 0, errors.New("missing pidfd identity")
	}
	flags, _, eno := syscall.Syscall(syscall.SYS_FCNTL, f.Fd(), syscall.F_GETFD, 0)
	if eno != 0 || flags&syscall.FD_CLOEXEC == 0 {
		return 0, errors.New("atomically CLOEXEC pidfd required")
	}
	return pid, nil
}
func pollBroker(rows []brokerPoll, wait time.Duration) (bool, error) {
	ts := syscall.NsecToTimespec(int64(wait))
	n, _, e := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&rows[0])), uintptr(len(rows)), uintptr(unsafe.Pointer(&ts)), 0, 0, 0)
	// EINTR never establishes liveness; the caller must resample original time.
	if e != 0 {
		return false, e
	}
	if n != 0 {
		return true, nil
	}
	for _, r := range rows {
		if r.Returned != 0 {
			return true, nil
		}
	}
	return false, nil
}
func (s *BrokerSession) alive() error {
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		return e
	}
	if now < s.request.Origin || now >= s.request.Deadline {
		return errors.New("original broker window ended")
	}
	select {
	case <-s.ctx.Done():
		return errors.New("monitor session lost")
	default:
	}
	s.mu.Lock()
	until := s.authorizationUntil
	s.mu.Unlock()
	if !until.IsZero() && !time.Now().Before(until) {
		return errors.New("original storage authorization expired")
	}
	raw, e := s.conn.SyscallConn()
	if e != nil {
		return e
	}
	var event bool
	var pe error
	e = raw.Control(func(fd uintptr) {
		event, pe = pollBroker([]brokerPoll{{int32(s.peer.Fd()), 1, 0}, {int32(s.owner.Fd()), 1, 0}, {int32(fd), 1 | 0x2000, 0}}, 0)
	})
	if e != nil {
		return e
	}
	if pe != nil {
		return pe
	}
	if event {
		return errors.New("monitor exited, disconnected or sent another packet")
	}
	return nil
}
func (s *BrokerSession) lose() {
	s.once.Do(func() {
		s.cancel()
		s.conn.Close()
		s.mu.Lock()
		raw := s.exportRaw
		s.mu.Unlock()
		// Close the underlying TCP object, never TLS Close/close_notify: shutdown
		// must not wait on a blocked TLS writer, signer, or remote handshake.
		if raw != nil {
			raw.Close()
		}
	})
}
func (s *BrokerSession) watch(armed chan<- struct{}) {
	defer close(s.done)
	close(armed)
	// This watcher performs no authentication, journal, mount or provider work.
	// Its connection cancellation must not be represented as independent fencing.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if s.alive() != nil {
			s.lose()
			return
		}
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// ReceiveBrokerSession accepts precisely the existing monitor packet and one
// SCM_RIGHTS pidfd. SO_PEERPIDFD holds the socket peer itself, independently of
// its reusable numeric PID. Both references must still be live when compared.
// A relayed socket or unrelated held pidfd cannot substitute another monitor.
// The caller owns the protected listener and independently enforced lifetime;
// this function does not create a permissive listener or reset the clock.
func ReceiveBrokerSession(c *net.UnixConn, originalClock *os.File) (session *BrokerSession, err error) {
	if c == nil {
		return nil, errors.New("missing broker connection")
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &BrokerSession{conn: c, clock: originalClock, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	watchStarted := false
	defer func() {
		if err != nil {
			s.lose()
			if watchStarted {
				<-s.done
			}
			if s.peer != nil {
				s.peer.Close()
			}
			if s.owner != nil {
				s.owner.Close()
			}
		}
	}()
	origin, err := rpcservice.OriginalEntryOrigin(originalClock)
	if err != nil {
		return nil, err
	}
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return nil, err
	}
	deadline := origin + uint64(rpcservice.StartupWindow)
	if now < origin || now >= deadline {
		return nil, errors.New("expired original broker window")
	}
	remaining := time.Duration(deadline - now)
	if remaining > 3*time.Second {
		remaining = 3 * time.Second
	}
	if err = c.SetDeadline(before.Add(remaining)); err != nil {
		return nil, err
	}
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, err
	}
	var cred *syscall.Ucred
	var pe error
	peerFD := -1
	err = raw.Control(func(fd uintptr) {
		cred, pe = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if pe == nil {
			peerFD, pe = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, soPeerPIDFD)
		}
	})
	if pe == nil && peerFD >= 0 {
		s.peer = os.NewFile(uintptr(peerFD), "kernel-storage-socket-peer")
	}
	if err != nil {
		return nil, err
	}
	if pe != nil {
		return nil, pe
	}
	if cred == nil || cred.Uid != 0 || cred.Pid <= 0 {
		return nil, errors.New("measured root monitor peer required")
	}
	peerPID, err := pidfdPID(s.peer)
	if err != nil || peerPID != int(cred.Pid) {
		return nil, errors.New("socket peer process identity differs")
	}
	packet := make([]byte, 2048)
	oob := make([]byte, syscall.CmsgSpace(4))
	var n, on, flags int
	err = raw.Read(func(fd uintptr) bool {
		n, on, flags, _, pe = syscall.Recvmsg(int(fd), packet, oob, syscall.MSG_CMSG_CLOEXEC)
		return pe != syscall.EAGAIN && pe != syscall.EWOULDBLOCK
	})
	if err != nil {
		return nil, err
	}
	if pe != nil {
		return nil, pe
	}
	fds, parseErr := receivedRights(oob[:on])
	for i, fd := range fds {
		if i == 0 {
			s.owner = os.NewFile(uintptr(fd), "transferred-monitor-owner")
		} else {
			syscall.Close(fd)
		}
	}
	if parseErr != nil {
		return nil, parseErr
	}
	if n == 0 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || len(fds) != 1 {
		return nil, errors.New("one bounded request and exact owner pidfd required")
	}
	if err = json.Unmarshal(packet[:n], &s.request); err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(s.request)
	if err != nil || !bytes.Equal(canonical, packet[:n]) {
		return nil, errors.New("noncanonical or ambiguous broker request")
	}
	if err = s.request.Validate(); err != nil {
		return nil, err
	}
	boot, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return nil, err
	}
	if s.request.Origin != origin || s.request.Boot != strings.TrimSpace(string(boot)) {
		return nil, errors.New("request reset original time or boot")
	}
	ownerPID, err := pidfdPID(s.owner)
	if err != nil || ownerPID != peerPID {
		return nil, errors.New("transferred owner is not socket peer")
	}
	if err = s.alive(); err != nil {
		return nil, err
	}
	if err = c.SetDeadline(time.Time{}); err != nil {
		return nil, err
	}
	armed := make(chan struct{})
	watchStarted = true
	go s.watch(armed)
	<-armed
	if err = s.alive(); err != nil {
		return nil, err
	}
	return s, nil
}

// AuthenticateAndReserve is one-shot even when authorization or persistence
// fails. The trusted service fetches signatures for Request(), using Context()
// to abandon network work on peer loss; it must also impose an OS watchdog.
// A returned partial intent must be retained, including on loss during fsync.
func (s *BrokerSession) AuthenticateAndReserve(a *bootstrap.Authorization, bundle, signatures []byte, journal *os.File) (*BrokerIntent, error) {
	s.mu.Lock()
	if s.consumed {
		s.mu.Unlock()
		return nil, errors.New("broker session already consumed")
	}
	s.consumed = true
	s.mu.Unlock()
	if err := s.alive(); err != nil {
		s.lose()
		return nil, err
	}
	intent, err := BeginBrokerAttempt(a, bundle, s.request, signatures, s.clock, journal)
	s.mu.Lock()
	s.intent = intent
	s.mu.Unlock()
	if err != nil {
		s.lose()
		return intent, err
	}
	if err = s.alive(); err != nil {
		s.lose()
		return intent, err
	}
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return intent, errors.New("monitor lost before reservation publication")
	}
	s.reserved = true
	s.consent = intent.consent
	// Anchor the immutable wall-time authorization bound to this process's
	// monotonic clock once; a later wall-clock rollback cannot extend it.
	now := time.Now()
	s.authorizationUntil = now.Add(intent.consent.NotAfter().Sub(now))
	s.mu.Unlock()
	return intent, nil
}

// Acknowledge sends exactly one ingress acknowledgment after the exact peer and
// transferred owner have been checked and the session watcher is armed. It does
// not certify owner consent, attachment, fencing or an independent guardian.
func (s *BrokerSession) Acknowledge() (err error) {
	s.mu.Lock()
	used := s.accepted
	s.accepted = true
	s.mu.Unlock()
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if used {
		return errors.New("storage acceptance already consumed")
	}
	if err = s.alive(); err != nil {
		return err
	}
	raw, err := json.Marshal(s.request)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	packet := []byte(acceptedPrefix + hex.EncodeToString(sum[:]) + "\n")
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil || now >= s.request.Deadline {
		return errors.New("late storage acceptance")
	}
	remaining := time.Duration(s.request.Deadline - now)
	if remaining > 3*time.Second {
		remaining = 3 * time.Second
	}
	if err = s.conn.SetWriteDeadline(before.Add(remaining)); err != nil {
		return err
	}
	n, on, err := s.conn.WriteMsgUnix(packet, nil, nil)
	if err != nil || n != len(packet) || on != 0 {
		return errors.New("ambiguous storage acceptance; held")
	}
	if err = s.conn.SetWriteDeadline(time.Time{}); err != nil {
		return err
	}
	return s.alive()
}
