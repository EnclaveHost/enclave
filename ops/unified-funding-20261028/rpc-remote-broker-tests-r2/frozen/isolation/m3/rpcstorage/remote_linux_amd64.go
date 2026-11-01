//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"syscall"
	"time"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

func bootJournal(d *os.File) error {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if d == nil || syscall.Fstat(int(d.Fd()), &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Mode&07777 != 0700 || syscall.Fstatfs(int(d.Fd()), &fs) != nil || fs.Type != 0x01021994 || fs.Flags&1 != 0 {
		return errors.New("held private writable guest tmpfs receipt directory required")
	}
	return nil
}

// ExchangeOwner sends exactly one public request to the bootstrap's relay.
// The relay carries bytes, NOT authority: its response must independently pass
// both storage-owner signatures and this guest's real Reader authorization.
// No key, endpoint override, filesystem path or deadline selection is sent.
// The owner dispatcher must already own its independently enforced deadline.
// Ambiguous submission remains consumed. This is not an export/grant API.
func (s *BrokerSession) ExchangeOwner(relay *net.UnixConn, bundle, manifest []byte, receipts *os.File) (responseBytes []byte, err error) {
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if relay == nil || len(bundle) == 0 || len(bundle) > 2<<20 || len(manifest) == 0 || len(manifest) > 65536 {
		return nil, errors.New("bounded bootstrap relay and public inputs required")
	}
	defer relay.Close()
	if relay.LocalAddr().Network() != "unix" {
		return nil, errors.New("owner relay must be a Unix byte stream")
	}
	if err := s.alive(); err != nil {
		return nil, err
	}
	if err := bootJournal(receipts); err != nil {
		return nil, err
	}
	request, err := json.Marshal(map[string]any{"bundle": bundle, "manifest": manifest, "request": s.request})
	if err != nil || len(request) > 4<<20 {
		return nil, errors.New("bounded owner request")
	}
	sum := sha256.Sum256(request)
	intent, err := json.Marshal(map[string]any{"schema": "enclave-rpc-owner-relay-intent/1", "request": s.request, "wireSha256": hex.EncodeToString(sum[:])})
	if err != nil {
		return nil, err
	}
	held, err := consumeRecord(receipts, "owner-submit", intent)
	if err != nil {
		return nil, err
	}
	defer held.Close() // The exclusive name remains permanently consumed this boot.
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil || now < s.request.Origin || now >= s.request.Deadline {
		return nil, errors.New("original owner relay deadline")
	}
	deadline := before.Add(time.Duration(s.request.Deadline - now))
	// The owner's unchanged dispatch cap is 60 seconds. This is not a reset
	// of its clock, the guest startup clock or the caller's independent cap.
	if limit := before.Add(60 * time.Second); limit.Before(deadline) {
		deadline = limit
	}
	if err = relay.SetDeadline(deadline); err != nil {
		return nil, err
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		select {
		case <-s.ctx.Done():
			relay.Close()
		case <-stop:
		}
	}()
	wire := make([]byte, 4, len(request)+4)
	binary.BigEndian.PutUint32(wire, uint32(len(request)))
	wire = append(wire, request...)
	n, err := relay.Write(wire)
	if err != nil || n != len(wire) {
		return nil, errors.New("owner submission ambiguous; intent retained")
	}
	// A relay may send the maintained dispatcher's response, but never FDs.
	var size [4]byte
	if err = readRelay(relay, size[:]); err != nil {
		return nil, err
	}
	length := binary.BigEndian.Uint32(size[:])
	if length == 0 || length > 65536 {
		return nil, errors.New("bounded owner response frame required")
	}
	response := make([]byte, length)
	if err = readRelay(relay, response); err != nil {
		return nil, err
	}
	if err = s.alive(); err != nil {
		return nil, err
	}
	// Retain the exact bytes even if the subsequent signature check refuses.
	heldResponse, err := consumeRecord(receipts, "owner-relay-response", response)
	if err != nil {
		return nil, err
	}
	heldResponse.Close()
	return response, nil
}

func readRelay(c *net.UnixConn, b []byte) error {
	raw, err := c.SyscallConn()
	if err != nil {
		return err
	}
	for len(b) != 0 {
		oob := make([]byte, syscall.CmsgSpace(16))
		var n, on, flags int
		var inner error
		err = raw.Read(func(fd uintptr) bool {
			n, on, flags, _, inner = syscall.Recvmsg(int(fd), b, oob, syscall.MSG_CMSG_CLOEXEC)
			return inner != syscall.EAGAIN && inner != syscall.EWOULDBLOCK
		})
		if on != 0 {
			fds, _ := receivedRights(oob[:on])
			for _, fd := range fds {
				syscall.Close(fd)
			}
		}
		if err != nil {
			return err
		}
		if inner != nil {
			return inner
		}
		if n == 0 {
			return io.ErrUnexpectedEOF
		}
		if on != 0 || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 {
			return errors.New("owner relay ancillary data refused")
		}
		b = b[n:]
	}
	return nil
}

// AuthenticateRemoteReservation verifies the storage owner's signed result.
// OwnerIssuer persists both authoritative volume records BEFORE signing and
// its complete proof BEFORE output. That journal stays at the storage owner.
// This tmpfs record is only a guest audit/replay guard; it is never presented
// as remote writer exclusivity, writer settlement, export readiness or release.
func (s *BrokerSession) AuthenticateRemoteReservation(a *bootstrap.Authorization, bundle, proof []byte, receipts *os.File) error {
	s.mu.Lock()
	if s.consumed {
		s.mu.Unlock()
		return errors.New("broker session already consumed")
	}
	s.consumed = true
	s.mu.Unlock()
	fail := func(e error) error { s.lose(); return e }
	if err := s.alive(); err != nil {
		return fail(err)
	}
	if err := bootJournal(receipts); err != nil {
		return fail(err)
	}
	if len(proof) == 0 || len(proof) > 4096 {
		return fail(errors.New("bounded storage-owner proof required"))
	}
	consent, err := AuthorizeBrokerRequest(a, bundle, s.request, proof, s.clock)
	if err != nil {
		return fail(err)
	}
	binding, err := consent.ExportBinding(s.request)
	if err != nil || binding == nil {
		return fail(errors.New("both authorities must sign the exact export transport"))
	}
	proofSHA := sha256.Sum256(proof)
	record, err := json.Marshal(map[string]any{"schema": "enclave-rpc-remote-proof-receipt/1", "request": s.request, "proofSha256": hex.EncodeToString(proofSHA[:]), "export": binding})
	if err != nil {
		return fail(err)
	}
	held, err := consumeRecord(receipts, "owner-response", record)
	if err != nil {
		return fail(err)
	}
	s.mu.Lock()
	s.remoteReceipt = held
	s.mu.Unlock()
	if err = s.alive(); err != nil {
		return fail(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return errors.New("monitor lost before proof publication")
	}
	s.consent, s.reserved = consent, true
	now := time.Now()
	s.authorizationUntil = now.Add(consent.NotAfter().Sub(now))
	return nil
}

// Stop closes only this control session. It never frees either owner's writer
// reservation, disconnects a block device or asserts remote process death.
func (s *BrokerSession) Stop() { s.lose() }
