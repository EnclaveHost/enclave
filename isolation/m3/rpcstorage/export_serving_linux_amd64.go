//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync/atomic"
	"time"
)

// Private capability produced only by the original explicitly negotiated /2
// ConnectExportControl. No reconnect, public constructor or recovered journal.
type exportPermitConnection struct {
	conn    io.ReadWriter
	raw     net.Conn
	pending atomic.Bool
	replies chan []byte
}

func (s *BrokerSession) watchExportPermits(stream *exportPermitConnection) {
	for {
		var header [4]byte
		if _, e := io.ReadFull(stream.conn, header[:1]); e != nil || !stream.pending.CompareAndSwap(true, false) {
			s.lose()
			return
		}
		if _, e := io.ReadFull(stream.conn, header[1:]); e != nil {
			s.lose()
			return
		}
		n := binary.BigEndian.Uint32(header[:])
		if n != uint32(len(exportPermitAck)+32) {
			s.lose()
			return
		}
		raw := make([]byte, n)
		if _, e := io.ReadFull(stream.conn, raw); e != nil {
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

// commitExportPermit is serialized by the original broker continuation loop.
// Owner proof has already been persisted. The exact exporter must acknowledge
// its own original worker before either local guardian may commit this permit.
func (s *BrokerSession) commitExportPermit(ctx context.Context, proof []byte, until time.Time) error {
	s.mu.Lock()
	stream, bound := s.exportStream, s.exportBound
	s.mu.Unlock()
	if stream == nil || !bound || len(proof) == 0 || len(proof) > 2048 {
		return errors.New("original /2 export capability required")
	}
	deadline, ok := ctx.Deadline()
	if !ok || ctx.Err() != nil || !time.Now().Before(until) {
		return errors.New("bounded live export transaction required")
	}
	if until.Before(deadline) {
		deadline = until
	}
	if e := stream.raw.SetDeadline(deadline); e != nil {
		return e
	}
	stream.pending.Store(true)
	if e := writeOwnerFrame(stream.conn, proof); e != nil {
		return e
	}
	hash := sha256.Sum256(proof)
	expected := append([]byte(exportPermitAck), hash[:]...)
	select {
	case ack := <-stream.replies:
		if !bytes.Equal(ack, expected) || ctx.Err() != nil || !time.Now().Before(deadline) {
			return errors.New("exporter permit acknowledgement differs or is late")
		}
	case <-ctx.Done():
		return errors.New("exporter permit acknowledgement lost; held")
	}
	if e := s.alive(); e != nil {
		return e
	}
	// This transport follows the signed bound; the broker's own originalD
	// remains independently enforced pending the outer host handoff.
	return stream.raw.SetDeadline(until)
}
