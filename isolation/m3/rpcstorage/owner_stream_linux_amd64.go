//go:build linux && amd64

package rpcstorage

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"sync/atomic"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

type ownerContinuationConnection struct {
	conn          *tls.Conn
	raw           net.Conn
	authorization *bootstrap.Authorization
	used          atomic.Bool
	pending       atomic.Bool
	replies       chan []byte
	previous      string // protected by BrokerSession.continuationMu
}

// HasOwnerContinuations reports authenticated /2 negotiation, never readiness.
func (s *BrokerSession) HasOwnerContinuations() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ownerStream != nil
}

// RunOwnerContinuations owns authorization refresh after initial reservation and
// export-control binding. No other caller may use this Authorization concurrently.
// It keeps the SAME authenticated /2 TLS connection. No new dial, start request,
// fallback or retry. Every failure closes the broker, including its export TCP
// connection. It returns only on loss; serving adoption remains unavailable.
func (s *BrokerSession) RunOwnerContinuations(a *bootstrap.Authorization, bundle []byte, receipts *os.File) (err error) {
	defer func() { s.lose() }()
	s.mu.Lock()
	stream := s.ownerStream
	ready := s.reserved && s.exportBound
	s.mu.Unlock()
	if stream == nil || stream.authorization != a || !ready || !stream.used.CompareAndSwap(false, true) {
		return errors.New("original authenticated owner/2 stream required after export binding")
	}
	for {
		if err = s.continueOwnerOnce(stream, a, bundle, receipts); err != nil {
			return err
		}
		timer := time.NewTimer(10 * time.Second)
		select {
		case <-s.ctx.Done():
			timer.Stop()
			return errors.New("owner continuation session lost")
		case <-timer.C:
		}
	}
}
func (s *BrokerSession) continueOwnerOnce(stream *ownerContinuationConnection, a *bootstrap.Authorization, bundle []byte, receipts *os.File) (err error) {
	s.continuationMu.Lock()
	defer s.continuationMu.Unlock()
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if err = s.alive(); err != nil {
		return err
	}
	if err = bootJournal(receipts); err != nil {
		return err
	}
	s.mu.Lock()
	until, initial := s.authorizationUntil, s.ownerProofSHA
	s.mu.Unlock()
	if initial == "" {
		return errors.New("exact original owner proof required")
	}
	deadline := time.Now().Add(3 * time.Second)
	if until.Before(deadline) {
		deadline = until
	}
	// s.watch independently enforces originalD throughout network/chain/fsync.
	ctx, cancel := context.WithDeadline(s.ctx, deadline)
	defer cancel()
	if err = a.Revalidate(ctx); err != nil {
		return err
	}
	if stream.previous == "" {
		stream.previous = initial
	}
	now := time.Now().Unix()
	p := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "startup", Sequence: s.continuationSequence + 1, PreviousSHA256: stream.previous, IssuedAt: now, NotAfter: now + bootstrap.RPCContinuationMaxSeconds}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	// Separate transport submission intent precedes any bytes to the owner.
	held, err := consumeRecord(receipts, fmt.Sprintf("owner-continuation-%016x-submit", p.Sequence), raw)
	if err != nil {
		return err
	}
	defer held.Close()
	if err = s.alive(); err != nil {
		return err
	}
	if !time.Now().Before(deadline) {
		return errors.New("owner continuation request late")
	}
	if err = stream.raw.SetDeadline(deadline); err != nil {
		return err
	}
	stream.pending.Store(true)
	if err = writeOwnerFrame(stream.conn, raw); err != nil {
		return err
	}
	var reply []byte
	select {
	case reply = <-stream.replies:
	case <-ctx.Done():
		return errors.New("owner continuation response lost or late")
	}
	if !time.Now().Before(deadline) {
		return errors.New("owner continuation response late")
	}
	if err = s.applyStartupContinuation(bundle, reply, receipts); err != nil {
		return err
	}
	if !time.Now().Before(deadline) {
		return errors.New("owner continuation persistence late")
	}
	h := sha256.Sum256(reply)
	stream.previous = hex.EncodeToString(h[:])
	// Idle time is bounded by the newly accepted permit; the original deadline
	// and exact monitor loss watcher still close the raw transport independently.
	s.mu.Lock()
	until = s.authorizationUntil
	s.mu.Unlock()
	return stream.raw.SetDeadline(until)
}

// One reader remains active even between permits. EOF, oversized data or an
// unsolicited/second response closes the broker immediately; no ten-second
// polling delay or parallel TLS readers. The bounded channel never hides loss.
func (s *BrokerSession) watchOwnerStream(stream *ownerContinuationConnection) {
	for {
		var header [4]byte
		_, e := io.ReadFull(stream.conn, header[:1])
		if e != nil || !stream.pending.CompareAndSwap(true, false) {
			s.lose()
			return
		}
		// Refuse the first unsolicited byte, not only a complete unexpected frame.
		if _, e = io.ReadFull(stream.conn, header[1:]); e != nil {
			s.lose()
			return
		}
		size := binary.BigEndian.Uint32(header[:])
		if size == 0 || size > 2048 {
			s.lose()
			return
		}
		raw := make([]byte, size)
		if _, e = io.ReadFull(stream.conn, raw); e != nil {
			s.lose()
			return
		}
		select {
		case stream.replies <- raw:
		case <-s.ctx.Done():
			return
		}
	}
}
