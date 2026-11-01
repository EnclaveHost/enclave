//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strconv"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

const exportHello = "ENCLAVE-RPC-EXPORT-CONTROL/1\n"
const exportBound = "ENCLAVE-RPC-EXPORT-BOUND/1\n"

// ExportControl records only that the exact authenticated transport acknowledged
// the request. It is not export readiness, a writable-root grant, settlement,
// or permission to release a reservation. There is no reconnect or write API.
type ExportControl struct {
	ctx                     context.Context
	requestSHA, contractSHA string
}

func (c *ExportControl) Context() context.Context { return c.ctx }
func (c *ExportControl) RequestSHA256() string    { return c.requestSHA }
func (c *ExportControl) ContractSHA256() string   { return c.contractSHA }

// ConnectExportControl consumes one possible connection before dialing. BOTH
// storage authorities must have signed its endpoint/certificate/contract binding.
// The local-owner path persists both records directly; the remote-owner path
// verifies OwnerIssuer's proof, produced after its authoritative persistence.
// Caller-supplied certificate
// bytes are checked against that authorization; they cannot select a target.
// The accepted bootstrap supplies the private client key. The same storage-owner
// authoritative journal remains required; a guest-local directory is not a
// substitute for remote writer exclusivity. This method cannot grant roots.
func (s *BrokerSession) ConnectExportControl(serverDER []byte, client tls.Certificate) (control *ExportControl, err error) {
	s.mu.Lock()
	if s.exportUsed {
		s.mu.Unlock()
		return nil, errors.New("export control already consumed")
	}
	s.exportUsed = true
	consent, reserved := s.consent, s.reserved
	s.mu.Unlock()
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if !reserved || consent == nil {
		return nil, errors.New("authenticated storage-owner reservation proof required")
	}
	binding, err := consent.ExportBinding(s.request)
	if err != nil {
		return nil, err
	}
	if binding == nil {
		return nil, errors.New("historical consent does not authorize export transport")
	}
	if err = s.alive(); err != nil {
		return nil, err
	}
	if len(serverDER) == 0 || len(serverDER) > 16384 || len(client.Certificate) == 0 || len(client.Certificate) > 4 || client.PrivateKey == nil {
		return nil, errors.New("bounded explicit TLS credentials required")
	}
	serverDER = append([]byte(nil), serverDER...)
	serverHash := sha256.Sum256(serverDER)
	if hex.EncodeToString(serverHash[:]) != binding.ServerCertificateSHA256 {
		return nil, errors.New("server certificate differs from both signed authorities")
	}
	// Clone mutable certificate bytes. The private key is an accepted-bootstrap
	// capability; its implementation also remains inside the required OS bounds.
	cert := tls.Certificate{PrivateKey: client.PrivateKey}
	for _, raw := range client.Certificate {
		if len(raw) == 0 || len(raw) > 16384 {
			return nil, errors.New("bounded client certificate chain required")
		}
		cert.Certificate = append(cert.Certificate, append([]byte(nil), raw...))
	}
	clientHash := sha256.Sum256(cert.Certificate[0])
	if hex.EncodeToString(clientHash[:]) != binding.ClientCertificateSHA256 {
		return nil, errors.New("client certificate differs from both signed authorities")
	}
	serverCert, err := x509.ParseCertificate(serverDER)
	if err != nil {
		return nil, err
	}
	// Exact authority-selected leaf as explicit trust anchor. Ordinary TLS name,
	// validity, usage and handshake verification remain enabled; no system CA or
	// Enclave CA is consulted and InsecureSkipVerify is never set.
	roots := x509.NewCertPool()
	roots.AddCert(serverCert)
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13,
		RootCAs: roots, ServerName: binding.ServerName, Certificates: []tls.Certificate{cert},
		VerifyConnection: func(state tls.ConnectionState) error {
			if len(state.PeerCertificates) == 0 || !bytes.Equal(state.PeerCertificates[0].Raw, serverDER) {
				return errors.New("export peer certificate substituted")
			}
			return nil
		}}
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return nil, err
	}
	if now < s.request.Origin || now >= s.request.Deadline {
		return nil, errors.New("original export control deadline")
	}
	original := before.Add(time.Duration(s.request.Deadline - now))
	handshake := original
	if limit := before.Add(3 * time.Second); limit.Before(handshake) {
		handshake = limit
	}
	ctx, cancel := context.WithDeadline(s.ctx, handshake)
	defer cancel()
	// Canonical literal IP from authenticated consent; exactly one DialContext,
	// no DNS lookup, proxy, endpoint rotation or automatic retry.
	raw, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(binding.Host, strconv.Itoa(int(binding.Port))))
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		raw.Close()
		return nil, errors.New("monitor lost during export connect")
	}
	s.exportRaw = raw
	s.mu.Unlock()
	if err = raw.SetDeadline(handshake); err != nil {
		return nil, err
	}
	conn := tls.Client(raw, cfg)
	if err = conn.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	if err = s.alive(); err != nil {
		return nil, err
	}
	request, err := json.Marshal(s.request)
	if err != nil {
		return nil, err
	}
	hash := sha256.Sum256(request)
	contract, _ := hex.DecodeString(binding.ContractSHA256)
	frame := append([]byte(exportHello), hash[:]...)
	frame = append(frame, contract...)
	n, err := conn.Write(frame)
	if err != nil {
		return nil, err
	}
	if n != len(frame) {
		return nil, io.ErrShortWrite
	}
	frameHash := sha256.Sum256(frame)
	expected := append([]byte(exportBound), frameHash[:]...)
	received := make([]byte, len(expected))
	if _, err = io.ReadFull(conn, received); err != nil {
		return nil, err
	}
	if !bytes.Equal(expected, received) {
		return nil, errors.New("export control acknowledgement differs")
	}
	if err = s.alive(); err != nil {
		return nil, err
	}
	if err = raw.SetReadDeadline(original); err != nil {
		return nil, err
	}
	armed := make(chan struct{})
	go func() {
		close(armed)
		var one [1]byte
		// EOF/error/any byte from the server is terminal. The session's own
		// watcher closes raw on exact monitor death or authorization loss even
		// while this read or another TLS operation is blocked.
		conn.Read(one[:])
		s.lose()
	}()
	<-armed
	if err = s.alive(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.exportBound = true
	s.mu.Unlock()
	return &ExportControl{ctx: s.ctx, requestSHA: hex.EncodeToString(hash[:]), contractSHA: binding.ContractSHA256}, nil
}
