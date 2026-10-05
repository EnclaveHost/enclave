package tuna

// USDC is explicitly negotiated inside the authenticated encrypted connection.
// A controller owns chain authorization, durable meters and receipt signing;
// transport never treats a zero NanoPay price as USDC authorization.
import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"sync"
	"time"

	"github.com/nknorg/tuna/pb"
	"github.com/xtaci/smux"
)

const usdcMode uint32 = 1
const maxUSDCMessage = 16384
const maxUSDCChunk = 32768

// Both peers see the same transcript. The controller signs/binds these exact
// NKN public keys and fresh server nonce to the current application lease.
type USDCTranscript struct {
	ClientKey   string `json:"clientKey"`
	ProviderKey string `json:"providerKey"`
	Nonce       string `json:"nonce"`
	Server      bool   `json:"server"`
}
type USDCController interface {
	Open(context.Context, USDCTranscript, json.RawMessage) (USDCSession, json.RawMessage, error)
}
type USDCSession interface {
	Confirm(context.Context, json.RawMessage) error
	// Reserve is bounded credit before delivery; Commit records only bytes
	// actually transferred. Neither method may trust the peer's byte claim.
	Reserve(context.Context, string, int) (string, error)
	Commit(context.Context, string, int) error
	Remote(context.Context, json.RawMessage) (json.RawMessage, error)
	// Next/Reply connect the runner's settlement worker to the provider over
	// the encrypted payment stream. That stream is never itself metered.
	Next(context.Context) (string, json.RawMessage, error)
	Reply(context.Context, string, json.RawMessage) error
	Close() error
}
type usdcConn struct {
	net.Conn
	billing USDCSession
	ctx     context.Context
	cancel  context.CancelFunc
	once    sync.Once
	payment sync.Once
}

func (c *usdcConn) Close() error {
	err := c.Conn.Close()
	c.once.Do(func() { c.cancel(); _ = c.billing.Close() })
	return err
}
func (c *Common) negotiateUSDC(conn net.Conn, remote *pb.ConnectionMetadata, local *pb.ConnectionMetadata) (net.Conn, error) {
	if remote.IsMeasurement || local.IsMeasurement {
		return conn, nil
	}
	if remote.SettlementMode == 0 && local.SettlementMode == 0 {
		return conn, nil
	}
	if remote.SettlementMode != usdcMode || local.SettlementMode != usdcMode || c.USDC == nil || local.EncryptionAlgo == pb.EncryptionAlgo_ENCRYPTION_NONE && remote.EncryptionAlgo == pb.EncryptionAlgo_ENCRYPTION_NONE {
		return nil, errors.New("USDC transport mode not mutually negotiated")
	}
	t := USDCTranscript{Server: c.IsServer, Nonce: hex.EncodeToString(remote.Nonce), ClientKey: hex.EncodeToString(local.PublicKey), ProviderKey: hex.EncodeToString(remote.PublicKey)}
	if c.IsServer {
		t.ClientKey, t.ProviderKey = t.ProviderKey, t.ClientKey
	}
	ctx, cancel := context.WithCancel(context.Background())
	var s USDCSession
	success := false
	defer func() {
		if !success {
			cancel()
			if s != nil {
				_ = s.Close()
			}
		}
	}()
	var proof json.RawMessage
	var err error
	if c.IsServer {
		proof, err = ReadVarBytes(conn, maxUSDCMessage)
		if err != nil {
			return nil, err
		}
		s, proof, err = c.USDC.Open(ctx, t, proof)
		if err != nil {
			return nil, err
		}
		if s == nil || !json.Valid(proof) || len(proof) > maxUSDCMessage {
			return nil, errors.New("invalid provider authorization")
		}
		if err = WriteVarBytes(conn, proof); err != nil {
			return nil, err
		}
		ack := make([]byte, 1)
		if _, err = io.ReadFull(conn, ack); err != nil || ack[0] != 1 {
			return nil, errors.New("USDC client did not confirm authorization")
		}
		if err = s.Confirm(ctx, nil); err != nil {
			return nil, err
		}
	} else {
		s, proof, err = c.USDC.Open(ctx, t, nil)
		if err != nil {
			return nil, err
		}
		if s == nil || !json.Valid(proof) || len(proof) > maxUSDCMessage {
			return nil, errors.New("invalid runner authorization")
		}
		if err = WriteVarBytes(conn, proof); err != nil {
			return nil, err
		}
		proof, err = ReadVarBytes(conn, maxUSDCMessage)
		if err != nil {
			return nil, err
		}
		if err = s.Confirm(ctx, proof); err != nil {
			return nil, err
		}
		if _, err = conn.Write([]byte{1}); err != nil {
			return nil, err
		}
	}
	success = true
	return &usdcConn{Conn: conn, billing: s, ctx: ctx, cancel: cancel}, nil
}
func (c *Common) bindUSDC(session *smux.Session, conn net.Conn) {
	if paid, ok := conn.(*usdcConn); ok {
		c.usdcSessions.Store(session, paid)
		go func() { <-paid.ctx.Done(); c.usdcSessions.Delete(session) }()
	}
}
func (c *Common) paidSession(session *smux.Session) *usdcConn {
	v, ok := c.usdcSessions.Load(session)
	if !ok {
		return nil
	}
	return v.(*usdcConn)
}
func (c *Common) serviceStream(session *smux.Session, stream *smux.Stream) io.ReadWriteCloser {
	if paid := c.paidSession(session); paid != nil {
		return &usdcStream{ReadWriteCloser: stream, paid: paid}
	}
	return stream
}

type usdcStream struct {
	io.ReadWriteCloser
	paid *usdcConn
}

func (s *usdcStream) Read(p []byte) (int, error) {
	if len(p) > maxUSDCChunk {
		p = p[:maxUSDCChunk]
	}
	n, err := s.ReadWriteCloser.Read(p)
	if n == 0 {
		return n, err
	}
	ticket, e := s.paid.billing.Reserve(s.paid.ctx, "in", n)
	if e == nil {
		e = s.paid.billing.Commit(s.paid.ctx, ticket, n)
	}
	if e != nil {
		_ = s.paid.Close()
		return 0, e
	}
	return n, err
}
func (s *usdcStream) Write(p []byte) (int, error) {
	total := 0
	for len(p) > 0 {
		size := len(p)
		if size > maxUSDCChunk {
			size = maxUSDCChunk
		}
		ticket, e := s.paid.billing.Reserve(s.paid.ctx, "out", size)
		if e != nil {
			_ = s.paid.Close()
			return total, e
		}
		n, err := s.ReadWriteCloser.Write(p[:size])
		if n < 0 || n > size {
			_ = s.paid.Close()
			return total, errors.New("invalid stream write count")
		}
		e = s.paid.billing.Commit(s.paid.ctx, ticket, n)
		total += n
		if e != nil {
			_ = s.paid.Close()
			return total, e
		}
		if err != nil {
			return total, err
		}
		if n != size {
			return total, io.ErrShortWrite
		}
		p = p[n:]
	}
	return total, nil
}
func (c *Common) serveUSDCPayment(session *smux.Session, stream *smux.Stream) error {
	paid := c.paidSession(session)
	if paid == nil {
		return errors.New("USDC payment on an unbound session")
	}
	started := false
	paid.payment.Do(func() { started = true })
	if !started {
		return errors.New("duplicate USDC payment stream")
	}
	defer stream.Close()
	for {
		_ = stream.SetDeadline(time.Now().Add(45 * time.Second))
		request, err := ReadVarBytes(stream, maxUSDCMessage)
		if err != nil {
			return err
		}
		if !json.Valid(request) {
			return errors.New("invalid USDC control message")
		}
		response, err := paid.billing.Remote(paid.ctx, request)
		if err != nil {
			return err
		}
		if !json.Valid(response) || len(response) > maxUSDCMessage {
			return errors.New("invalid USDC control response")
		}
		if err = WriteVarBytes(stream, response); err != nil {
			return err
		}
	}
}
func (c *Common) startUSDCPayment(session *smux.Session, stream *smux.Stream) {
	paid := c.paidSession(session)
	if paid == nil {
		_ = session.Close()
		return
	}
	paid.payment.Do(func() {
		go func() {
			defer session.Close()
			defer stream.Close()
			for {
				id, request, err := paid.billing.Next(paid.ctx)
				if err != nil {
					return
				}
				if id == "" || !json.Valid(request) || len(request) > maxUSDCMessage {
					return
				}
				_ = stream.SetDeadline(time.Now().Add(30 * time.Second))
				if err = WriteVarBytes(stream, request); err != nil {
					return
				}
				response, err := ReadVarBytes(stream, maxUSDCMessage)
				if err != nil || !json.Valid(response) {
					return
				}
				if err = paid.billing.Reply(paid.ctx, id, response); err != nil {
					return
				}
			}
		}()
	})
}
