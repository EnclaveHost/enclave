//go:build linux && amd64

// Package rpcstorage is the monitor side of a measured, independently running
// storage authority. Peer credentials authenticate only that local TCB peer;
// they do not prove remote storage ownership, a writer fence or its watchdog.
// The accepted bootstrap must implement those obligations before granting.
package rpcstorage

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

const socketPath = "/run/native-rpc-storage/broker.sock"
const requestSchema = contract.RPCStorageRequestSchema
const acceptedPrefix = "ENCLAVE-RPC-STORAGE-ACCEPTED/1 "
const replyPrefix = "ENCLAVE-RPC-STORAGE/1 "

// Request binds one attempt to actual loaded identity and the original clock.
// No host pathname, endpoint, executable, budget or asserted permission exists.
type Request = contract.RPCStorageRequest

// Attempt is retained on any post-submission ambiguity. Neither Close nor
// release is exposed. Loss returns once on EOF, a byte, error or original D;
// no keepalive messages, retries, automatic regrant or renewed deadline exist.
// A live connection alone is NOT proof of an independently armed watchdog.
type Attempt struct {
	Request  Request
	L1, Base *os.File
	conn     *net.UnixConn
	owner    *os.File
	peer     *os.File
	intent   *os.File
	loss     chan struct{}
}

func (a *Attempt) Loss() <-chan struct{} { return a.loss }

func NewRequest(bundle []byte, origin uint64) (Request, error) {
	man, _, err := contract.ParseRPC(bundle)
	if err != nil {
		return Request{}, err
	}
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return Request{}, err
	}
	if origin > now || now-origin >= uint64(rpcservice.StartupWindow) || origin > ^uint64(0)-uint64(rpcservice.StartupWindow) {
		return Request{}, errors.New("original RPC window expired")
	}
	raw, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if err != nil {
		return Request{}, err
	}
	boot := strings.TrimSpace(string(raw))
	if len(boot) != 36 {
		return Request{}, errors.New("kernel boot identity unavailable")
	}
	var nonce [32]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return Request{}, err
	}
	sum := contract.AppID(bundle)
	return Request{AppID: hex.EncodeToString(sum[:]), BaseVolume: man.RPC.BaseVolumeID, Boot: boot, Deadline: origin + uint64(rpcservice.StartupWindow), Deployment: man.SecretDeployment, L1Volume: man.RPC.L1VolumeID, Nonce: hex.EncodeToString(nonce[:]), Origin: origin, Profile: man.RPC.ProfileSha256, Schema: requestSchema}, nil
}

// Acquire is invoked before Prepare or any mount. A successful broker reply
// promises that owner authorization, exact volume acquisition and the original
// deadline/owner-death watchdog are already established, not merely queued.
// That promise needs real broker implementation and target qualification; this
// client does not manufacture it or enable a fallback when the broker is absent.
func Acquire(bundle []byte, origin uint64) (*Attempt, error) {
	req, err := NewRequest(bundle, origin)
	if err != nil {
		return nil, err
	}
	if err = protectedSocket(); err != nil {
		return nil, err
	}
	d, err := os.Open("/run/native-rpc-storage")
	if err != nil {
		return nil, err
	}
	intent, err := consumeIntent(d, req)
	d.Close()
	if err != nil {
		return nil, err
	}
	c, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: socketPath, Net: "unixpacket"})
	if err != nil {
		return &Attempt{Request: req, intent: intent, loss: make(chan struct{})}, err
	}
	a, err := acquire(c, req)
	a.intent = intent
	return a, err
}
func protectedSocket() error {
	for _, p := range []string{"/", "/run", "/run/native-rpc-storage", socketPath} {
		var st syscall.Stat_t
		if syscall.Lstat(p, &st) != nil || st.Uid != 0 || st.Mode&0022 != 0 {
			return errors.New("protected measured storage broker namespace required")
		}
		want := uint32(syscall.S_IFDIR)
		if p == socketPath {
			want = syscall.S_IFSOCK
		}
		if st.Mode&syscall.S_IFMT != want {
			return errors.New("storage broker namespace type")
		}
	}
	return nil
}
func acquire(c *net.UnixConn, req Request) (a *Attempt, err error) {
	a = &Attempt{Request: req, conn: c, loss: make(chan struct{})}
	defer func() {
		if err != nil {
			c.Close() // Notify the broker; never infer owner settlement from this.
			close(a.loss)
		}
	}()
	// A failed submission is intentionally retained by the monitor, never retried.
	raw, e := c.SyscallConn()
	if e != nil {
		return a, e
	}
	var cred *syscall.Ucred
	peerFD := -1
	if e = raw.Control(func(fd uintptr) {
		cred, err = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
		if err == nil {
			peerFD, err = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, soPeerPIDFD)
		}
	}); e != nil {
		return a, e
	}
	if peerFD >= 0 {
		a.peer = os.NewFile(uintptr(peerFD), "exact-storage-broker")
	}
	if err != nil || cred == nil || cred.Uid != 0 {
		return a, errors.New("storage peer is not measured guest root")
	}
	pid, e := pidfdPID(a.peer)
	if e != nil || pid != int(cred.Pid) {
		return a, errors.New("exact live broker peer required")
	}
	before := time.Now()
	now, e := rpcservice.MonotonicNow()
	if e != nil || now < req.Origin || now >= req.Deadline {
		return a, errors.New("storage request outside original window")
	}
	remaining := time.Duration(req.Deadline - now)
	handshake := remaining
	if handshake > 3*time.Second {
		handshake = 3 * time.Second
	}
	if err = c.SetDeadline(before.Add(handshake)); err != nil {
		return a, err
	}
	fd, _, eno := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if eno != 0 {
		return a, eno
	}
	a.owner = os.NewFile(fd, "rpc-storage-monitor-owner")
	b, e := json.Marshal(req)
	if e != nil {
		return a, e
	}
	n, on, e := c.WriteMsgUnix(b, syscall.UnixRights(int(fd)), nil)
	if e != nil || n != len(b) || on != syscall.CmsgSpace(4) {
		return a, errors.New("ambiguous storage acquire submission; retained")
	}
	sum := sha256.Sum256(b)
	binding := hex.EncodeToString(sum[:]) + "\n"
	ack, ackRights, e := readAcquisitionPacket(c, a.peer, before.Add(handshake))
	for _, received := range ackRights {
		syscall.Close(received)
	}
	if e != nil || len(ackRights) != 0 || string(ack) != acceptedPrefix+binding {
		return a, errors.New("exact one-shot acceptance required before storage grant")
	}
	// Acceptance is not consent, a root grant, readiness or an independent
	// watchdog receipt. It permits only waiting, within the ORIGINAL deadline,
	// for one final grant from this exact held broker process. No keepalives.
	if err = c.SetDeadline(time.Time{}); err != nil {
		return a, err
	}
	reply, rights, packetErr := readAcquisitionPacket(c, a.peer, before.Add(remaining))
	// Retain even malformed grants. No capability is returned to a reuse pool.
	for i, fd := range rights {
		f := os.NewFile(uintptr(fd), "rpc-state-grant")
		if i == 0 {
			a.L1 = f
		} else if i == 1 {
			a.Base = f
		} else {
			f.Close()
		}
	}
	expected := replyPrefix + binding
	if packetErr != nil || string(reply) != expected || len(rights) != 2 {
		return a, errors.New("storage grant differs from exact attempt")
	}
	for _, f := range []*os.File{a.L1, a.Base} {
		var st syscall.Stat_t
		if f == nil || syscall.Fstat(int(f.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 {
			return a, errors.New("held storage roots required")
		}
	}
	before = time.Now()
	now, e = rpcservice.MonotonicNow()
	if e != nil || now >= req.Deadline {
		return a, errors.New("late storage grant; retained")
	}
	if err = c.SetDeadline(time.Time{}); err != nil {
		return a, err
	}
	if err = c.SetReadDeadline(before.Add(time.Duration(req.Deadline - now))); err != nil {
		return a, err
	}
	go func() {
		// Any packet, EOF, exact broker death or original deadline is loss.
		_, rights, _ := readAcquisitionPacket(c, a.peer, before.Add(time.Duration(req.Deadline-now)))
		for _, fd := range rights {
			syscall.Close(fd)
		}
		c.Close()
		close(a.loss)
	}()
	return a, nil
}

// readAcquisitionPacket watches the exact broker pidfd even if another process
// retains the socket. A blocked broker cannot refresh or replace the deadline.
// This bounds the monitor wait; it does not kill or settle the remote exporter.
func readAcquisitionPacket(c *net.UnixConn, peer *os.File, deadline time.Time) ([]byte, []int, error) {
	raw, err := c.SyscallConn()
	if err != nil {
		return nil, nil, err
	}
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return nil, nil, errors.New("original acquisition stage expired")
		}
		if left > 10*time.Millisecond {
			left = 10 * time.Millisecond
		}
		rows := []brokerPoll{{int32(peer.Fd()), 1, 0}, {0, 1 | 0x2000, 0}}
		var ready bool
		var pe error
		err = raw.Control(func(fd uintptr) {
			rows[1].FD = int32(fd)
			ready, pe = pollBroker(rows, left)
		})
		if err != nil {
			return nil, nil, err
		}
		if pe == syscall.EINTR {
			continue
		}
		if pe != nil {
			return nil, nil, pe
		}
		if rows[0].Returned != 0 {
			return nil, nil, errors.New("exact broker process exited")
		}
		if !ready {
			continue
		}
		packet, oob := make([]byte, 256), make([]byte, syscall.CmsgSpace(8))
		var n, on, flags int
		err = raw.Control(func(fd uintptr) {
			n, on, flags, _, pe = syscall.Recvmsg(int(fd), packet, oob, syscall.MSG_CMSG_CLOEXEC|syscall.MSG_DONTWAIT)
		})
		if err != nil {
			return nil, nil, err
		}
		if pe == syscall.EAGAIN || pe == syscall.EWOULDBLOCK || pe == syscall.EINTR {
			continue
		}
		if pe != nil {
			return nil, nil, pe
		}
		rights, parseErr := receivedRights(oob[:on])
		if parseErr != nil {
			return nil, rights, parseErr
		}
		if n == 0 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || !time.Now().Before(deadline) {
			return nil, rights, errors.New("closed, truncated or late acquisition packet")
		}
		// The process must still be alive after receipt, before using any grant.
		dead, pe := pollBroker([]brokerPoll{{int32(peer.Fd()), 1, 0}}, 0)
		if pe != nil || dead {
			return nil, rights, errors.New("broker died during acquisition")
		}
		return packet[:n], rights, nil
	}
}

func receivedRights(raw []byte) ([]int, error) {
	msgs, err := syscall.ParseSocketControlMessage(raw)
	if err != nil {
		return nil, err
	}
	var out []int
	for _, msg := range msgs {
		if msg.Header.Level != syscall.SOL_SOCKET || msg.Header.Type != syscall.SCM_RIGHTS {
			return out, fmt.Errorf("unexpected storage ancillary record")
		}
		fds, err := syscall.ParseUnixRights(&msg)
		if err != nil {
			return out, err
		}
		out = append(out, fds...)
	}
	return out, nil
}
