//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

// Public inputs only. Evidence is the monitor's retained actual report; the
// untrusted host may supply HostEvidence and Offer but never replace Evidence.
type OwnerBootstrapInput struct {
	Evidence     json.RawMessage `json:"evidence"`
	HostEvidence json.RawMessage `json:"hostEvidence"`
	Offer        json.RawMessage `json:"offer"`
	ServerDER    []byte          `json:"serverDer"`
}

func DecodeOwnerBootstrap(raw []byte) (OwnerBootstrapInput, error) {
	var in OwnerBootstrapInput
	if len(raw) == 0 || len(raw) > 12<<20 {
		return in, errors.New("owner bootstrap input bound")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&in); e != nil {
		return in, e
	}
	encoded, e := json.Marshal(in)
	if e != nil || !bytes.Equal(encoded, raw) || len(in.Evidence) == 0 || len(in.HostEvidence) == 0 || len(in.Offer) == 0 || len(in.ServerDER) == 0 || len(in.ServerDER) > 16384 {
		return in, errors.New("exact canonical bootstrap input required")
	}
	return in, nil
}

// ExchangeAuthenticatedOwner replaces the host Unix relay with one direct TLS
// connection to an endpoint signed by BOTH currently committed storage keys.
// Endpoint signatures do not reserve writers; returned owner consent still has
// to pass AuthenticateRemoteReservation. No Enclave resolver/registry is used.
func (s *BrokerSession) ExchangeAuthenticatedOwner(a *bootstrap.Authorization, bundle, manifest []byte, in OwnerBootstrapInput, client tls.Certificate, receipts *os.File) (response []byte, err error) {
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if err = s.alive(); err != nil {
		return nil, err
	}
	if err = bootJournal(receipts); err != nil {
		return nil, err
	}
	offer, err := a.VerifyRPCBootstrapOffer(bundle, s.request, in.Offer)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(in.ServerDER)
	if len(in.ServerDER) == 0 || len(in.ServerDER) > 16384 || hex.EncodeToString(sum[:]) != offer.ServerCertificateSHA256 || len(client.Certificate) != 1 || client.PrivateKey == nil {
		return nil, errors.New("owner bootstrap TLS identity differs")
	}
	clientSum := sha256.Sum256(client.Certificate[0])
	if hex.EncodeToString(clientSum[:]) != offer.ClientCertificateSHA256 {
		return nil, errors.New("owner offer names another guest credential")
	}
	var evidence struct {
		Purpose       string                     `json:"purpose"`
		Request       contract.RPCStorageRequest `json:"request"`
		RequestSHA256 string                     `json:"requestSha256"`
		Runtime       contract.RuntimeIdentity   `json:"runtime"`
		TransportKey  []byte                     `json:"transportKey"`
		Certificate   []byte                     `json:"certificate"`
		RootsGranted  bool                       `json:"rootsGranted"`
		RPCReady      bool                       `json:"rpcReady"`
		Challenge     string                     `json:"challenge"`
		Report        []byte                     `json:"vbsVmReport"`
	}
	d := json.NewDecoder(bytes.NewReader(in.Evidence))
	d.DisallowUnknownFields()
	if d.Decode(&evidence) != nil || evidence.Request != s.request || evidence.Purpose != contract.RPCBootstrapPurpose || evidence.RootsGranted || evidence.RPCReady || evidence.RequestSHA256 != offer.RequestSHA256 || evidence.Challenge != offer.Challenge || !bytes.Equal(evidence.Certificate, client.Certificate[0]) || len(evidence.Report) == 0 || len(evidence.Report) > 9000 {
		return nil, errors.New("retained guest report differs from owner offer")
	}
	rid, e := contract.RuntimeID(evidence.Runtime)
	if e != nil || hex.EncodeToString(rid[:]) != offer.Runtime {
		return nil, errors.New("bootstrap runtime differs")
	}
	cert, e := x509.ParseCertificate(client.Certificate[0])
	if e != nil {
		return nil, e
	}
	spki, e := x509.MarshalPKIXPublicKey(cert.PublicKey)
	if e != nil || !bytes.Equal(spki, evidence.TransportKey) {
		return nil, errors.New("guest report key differs")
	}
	frame, e := json.Marshal(struct {
		Schema       string          `json:"schema"`
		Evidence     json.RawMessage `json:"evidence"`
		HostEvidence json.RawMessage `json:"hostEvidence"`
	}{"enclave-rpc-owner-bootstrap-evidence/1", in.Evidence, in.HostEvidence})
	if e != nil || len(frame) > 12<<20 {
		return nil, errors.New("bootstrap evidence frame bound")
	}
	request, e := json.Marshal(map[string]any{"bundle": bundle, "manifest": manifest, "request": s.request})
	if e != nil || len(bundle) == 0 || len(bundle) > 2<<20 || len(manifest) == 0 || len(manifest) > 65536 || len(request) > 4<<20 {
		return nil, errors.New("bounded owner request required")
	}
	manifestSum := sha256.Sum256(manifest)
	if hex.EncodeToString(manifestSum[:]) != offer.ManifestSHA256 {
		return nil, errors.New("owner startup package differs")
	}
	certOwner, e := x509.ParseCertificate(in.ServerDER)
	if e != nil {
		return nil, e
	}
	roots := x509.NewCertPool()
	roots.AddCert(certOwner)
	config := &tls.Config{MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13, RootCAs: roots, ServerName: offer.ServerName, Certificates: []tls.Certificate{client}, VerifyConnection: func(state tls.ConnectionState) error {
		if state.DidResume || len(state.PeerCertificates) == 0 || !bytes.Equal(state.PeerCertificates[0].Raw, in.ServerDER) {
			return errors.New("fresh exact owner TLS peer required")
		}
		return nil
	}}
	// Permanently consume before dialing or sending any report/request.
	intent, _ := json.Marshal(map[string]any{"schema": "enclave-rpc-owner-bootstrap-submit/1", "offer": json.RawMessage(in.Offer), "request": s.request, "rpcReady": false})
	held, e := consumeRecord(receipts, "owner-bootstrap-submit", intent)
	if e != nil {
		return nil, e
	}
	defer held.Close()
	before := time.Now()
	now, e := rpcservice.MonotonicNow()
	if e != nil || now < s.request.Origin || now >= s.request.Deadline {
		return nil, errors.New("original bootstrap deadline ended")
	}
	deadline := before.Add(time.Duration(s.request.Deadline - now))
	if cap := before.Add(63 * time.Second); cap.Before(deadline) {
		deadline = cap
	}
	handshake := before.Add(3 * time.Second)
	if deadline.Before(handshake) {
		handshake = deadline
	}
	ctx, cancel := context.WithDeadline(s.ctx, handshake)
	defer cancel()
	raw, e := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(offer.Host, strconv.Itoa(int(offer.Port))))
	if e != nil {
		return nil, e
	}
	retained := false
	defer func() {
		if !retained {
			raw.Close()
		}
	}()
	s.mu.Lock()
	if s.ctx.Err() != nil {
		s.mu.Unlock()
		return nil, errors.New("owner connection lost before publication")
	}
	s.ownerRaw = raw
	s.mu.Unlock()
	stop := make(chan struct{})
	defer func() {
		if !retained {
			close(stop)
		}
	}()
	go func() {
		select {
		case <-s.ctx.Done():
			raw.Close()
		case <-stop:
		}
	}()
	if e = raw.SetDeadline(handshake); e != nil {
		return nil, e
	}
	conn := tls.Client(raw, config)
	if e = conn.HandshakeContext(ctx); e != nil {
		return nil, e
	}
	if e = writeOwnerFrame(conn, frame); e != nil {
		return nil, e
	}
	accepted, e := readOwnerFrame(conn, 65536)
	if e != nil {
		return nil, e
	}
	var ack struct {
		Schema            string `json:"schema"`
		RequestSHA256     string `json:"requestSha256"`
		CertificateSHA256 string `json:"certificateSha256"`
		RootsGranted      bool   `json:"rootsGranted"`
		RPCReady          bool   `json:"rpcReady"`
	}
	dec := json.NewDecoder(bytes.NewReader(accepted))
	dec.DisallowUnknownFields()
	ackSchema := "enclave-rpc-owner-bootstrap-accepted/1"
	if offer.Schema == "enclave-rpc-owner-offer/2" {
		ackSchema = "enclave-rpc-owner-bootstrap-accepted/2"
	}
	if dec.Decode(&ack) != nil || ack.Schema != ackSchema || ack.RequestSHA256 != offer.RequestSHA256 || ack.CertificateSHA256 != offer.ClientCertificateSHA256 || ack.RootsGranted || ack.RPCReady {
		return nil, errors.New("owner acceptance binding differs")
	}
	canonicalAck, _ := json.Marshal(ack)
	if !bytes.Equal(canonicalAck, accepted) {
		return nil, errors.New("exact complete owner acceptance required")
	}
	if e = s.alive(); e != nil {
		return nil, e
	}
	receipt, e := consumeRecord(receipts, "owner-bootstrap-accepted", accepted)
	if e != nil {
		return nil, e
	}
	receipt.Close()
	if e = raw.SetDeadline(deadline); e != nil {
		return nil, e
	}
	// The same global owner-submit name also prevents mixing historical Unix
	// relay and authenticated TLS paths within a single boot attempt.
	requestSHA := sha256.Sum256(request)
	submission, _ := json.Marshal(map[string]any{"request": s.request, "wireSha256": hex.EncodeToString(requestSHA[:])})
	submitted, e := consumeRecord(receipts, "owner-submit", submission)
	if e != nil {
		return nil, e
	}
	defer submitted.Close()
	if e = writeOwnerFrame(conn, request); e != nil {
		return nil, e
	}
	response, e = readOwnerFrame(conn, 65536)
	if e != nil {
		return nil, e
	}
	if e = s.alive(); e != nil {
		return nil, e
	}
	receipt, e = consumeRecord(receipts, "owner-relay-response", response)
	if e != nil {
		return nil, e
	}
	receipt.Close()
	if offer.Schema == "enclave-rpc-owner-offer/2" {
		if e = raw.SetDeadline(before.Add(time.Duration(s.request.Deadline - now))); e != nil {
			return nil, e
		}
		s.mu.Lock()
		if s.ctx.Err() != nil {
			s.mu.Unlock()
			return nil, errors.New("owner stream lost before attachment")
		}
		s.ownerStream = &ownerContinuationConnection{conn: conn, raw: raw, authorization: a, replies: make(chan []byte, 1)}
		stream := s.ownerStream
		retained = true
		s.mu.Unlock()
		go s.watchOwnerStream(stream)
	}
	return response, nil
}
func writeOwnerFrame(w io.Writer, raw []byte) error {
	b := make([]byte, 4, len(raw)+4)
	binary.BigEndian.PutUint32(b, uint32(len(raw)))
	b = append(b, raw...)
	n, e := w.Write(b)
	if e != nil {
		return e
	}
	if n != len(b) {
		return io.ErrShortWrite
	}
	return nil
}
func readOwnerFrame(r io.Reader, maximum uint32) ([]byte, error) {
	var size [4]byte
	if _, e := io.ReadFull(r, size[:]); e != nil {
		return nil, e
	}
	n := binary.BigEndian.Uint32(size[:])
	if n == 0 || n > maximum {
		return nil, errors.New("bounded owner frame required")
	}
	raw := make([]byte, n)
	_, e := io.ReadFull(r, raw)
	return raw, e
}
