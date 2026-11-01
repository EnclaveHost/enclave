//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

const servingPrepareSchema = "enclave-rpc-serving-prepare/1"
const servingPreparedSchema = "enclave-rpc-serving-prepared/1"

// This is a preparation, NOT a serving permit or watchdog/deadline transfer.
// Both actors retain a process-local capability; disk receipts cannot recreate
// it. A later coordinated commit still needs fresh evidence before originalD.
type servingPrepareRequest struct {
	Schema         string `json:"schema"`
	Sequence       uint64 `json:"sequence"` // current accepted startup sequence, not a new permit
	PreviousSHA256 string `json:"previousSha256"`
	Observation    []byte `json:"observation"` // exact private front frame, base64 on the wire
}
type servingPreparedProof struct {
	Schema        string `json:"schema"`
	RequestSHA256 string `json:"requestSha256"`
	L1            string `json:"l1"`
	Base          string `json:"base"`
}
type servingPrepared struct {
	request servingPrepareRequest
	raw     []byte
	until   time.Time // conservative local freshness limit, never authority extension
}

func decodeServingPrepare(raw []byte) (p servingPrepareRequest, err error) {
	if len(raw) == 0 || len(raw) > 1024 {
		return p, errors.New("bounded serving preparation required")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err = d.Decode(&p); err != nil {
		return p, err
	}
	canonical, e := json.Marshal(p)
	if e != nil || !bytes.Equal(canonical, raw) || p.Schema != servingPrepareSchema || p.Sequence == 0 || p.Sequence > (1<<53)-1 || !contract.NonzeroHash(p.PreviousSHA256) {
		return p, errors.New("exact original serving preparation required")
	}
	if _, err = contract.ParseRPCLocalReady(p.Observation); err != nil {
		return p, err
	}
	return p, nil
}
func preparationBinding(p servingPrepareRequest, r Request, runtimeID string) (contract.RPCLocalReady, error) {
	record, err := contract.ParseRPCLocalReady(p.Observation)
	if err != nil {
		return record, err
	}
	b := record.Binding
	if hex.EncodeToString(b.AppID[:]) != r.AppID || hex.EncodeToString(b.RuntimeID[:]) != runtimeID || "0x"+hex.EncodeToString(b.Deployment[:]) != r.Deployment || record.ObservedMono < r.Origin || record.ObservedMono >= r.Deadline {
		return record, errors.New("preparation observation differs from original scope/window")
	}
	return record, nil
}
func preparationPayloads(a *bootstrap.Authorization, bundle []byte, c *bootstrap.RPCStorageConsent, r Request, initial string, raw []byte) ([2][]byte, error) {
	var out [2][]byte
	if !contract.NonzeroHash(initial) {
		return out, errors.New("original signed proof required")
	}
	l1, base, err := c.WriterEpochs(r)
	if err != nil {
		return out, err
	}
	export, err := c.ExportBinding(r)
	if err != nil || export == nil {
		return out, errors.New("original export consent required")
	}
	payloads, err := a.RPCExportSigningPayloads(bundle, r, l1, base, *export)
	if err != nil {
		return out, err
	}
	first, _ := hex.DecodeString(initial)
	sum := sha256.Sum256(raw)
	for i := range out {
		out[i] = append([]byte("ENCLAVE-RPC-SERVING-PREPARED/1\x00"), payloads[i]...)
		out[i] = append(out[i], first...)
		out[i] = append(out[i], sum[:]...)
	}
	return out, nil
}

// PrepareServing is reachable only through the original authenticated owner
// stream. The guest's measured broker checks its own kernel clock before send
// and after reply; the owner's kernel clock is a DIFFERENT clock and must not
// be compared to guest ObservedMono. Owner verifies the actual frame/scope,
// exact current chain link and current original wallet/storage authorization.
// The receipt cannot be used as a continuation signature or extend any limit.
func (c *OwnerContinuation) PrepareServing(raw []byte) (reply []byte, err error) {
	c.op.Lock()
	defer c.op.Unlock()
	defer func() {
		if err != nil {
			c.Close()
		}
	}()
	if err = c.check(); err != nil {
		return nil, err
	}
	if c.prepareUsed {
		return nil, errors.New("serving preparation consumed")
	}
	c.prepareUsed = true
	p, err := decodeServingPrepare(raw)
	if err != nil {
		return nil, err
	}
	if p.Sequence != c.sequence || p.PreviousSHA256 != c.previous {
		return nil, errors.New("preparation is not linked to current startup authority")
	}
	if _, err = preparationBinding(p, c.issued.request, c.issued.consent.RuntimeID()); err != nil {
		return nil, err
	}
	deadline := time.Now().Add(3 * time.Second)
	if c.until.Load().Before(deadline) {
		deadline = *c.until.Load()
	}
	ctx, cancel := context.WithDeadline(c.ctx, deadline)
	defer cancel()
	// Consume before refreshing/signing. Any interruption retains this attempt.
	stem := "serving-prepare-" + c.requestHash
	held, err := consumeRecord(c.owner.journal, stem+"-submit", raw)
	if err != nil {
		return nil, err
	}
	defer held.Close()
	if err = c.issued.authorization.Revalidate(ctx); err != nil {
		return nil, err
	}
	initial := sha256.Sum256(c.issued.proof)
	payloads, err := preparationPayloads(c.issued.authorization, c.issued.bundle, c.issued.consent, c.issued.request, hex.EncodeToString(initial[:]), raw)
	if err != nil {
		return nil, err
	}
	if err = c.check(); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	proof := servingPreparedProof{Schema: servingPreparedSchema, RequestSHA256: hex.EncodeToString(sum[:]), L1: hex.EncodeToString(ed25519.Sign(c.keys[0], payloads[0])), Base: hex.EncodeToString(ed25519.Sign(c.keys[1], payloads[1]))}
	reply, err = json.Marshal(proof)
	if err != nil {
		return nil, err
	}
	heldProof, err := consumeRecord(c.owner.journal, stem+"-proof", reply)
	if err != nil {
		return nil, err
	}
	defer heldProof.Close()
	if err = c.check(); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	c.prepared = &servingPrepared{request: p, raw: append([]byte(nil), reply...), until: deadline}
	return reply, nil
}

func (s *BrokerSession) readinessSignal() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.localReadySignal == nil {
		s.localReadySignal = make(chan struct{})
	}
	return s.localReadySignal
}
func (s *BrokerSession) prepareOwnerServing(stream *ownerContinuationConnection, a *bootstrap.Authorization, bundle []byte, receipts *os.File) (err error) {
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
	ready, until, initial := s.localReady, s.authorizationUntil, s.ownerProofSHA
	if s.prepareUsed {
		s.mu.Unlock()
		return errors.New("guest preparation consumed")
	}
	s.prepareUsed = true
	s.mu.Unlock()
	if ready == nil || stream == nil || stream.authorization != a {
		return errors.New("original private readiness and owner stream required")
	}
	before := time.Now()
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return err
	}
	if err = ready.record.Validate(ready.record.Binding, now); err != nil {
		return err
	}
	freshUntil := before.Add(time.Duration(contract.RPCLocalReadyFreshnessNS - (now - ready.record.ObservedMono)))
	deadline := before.Add(3 * time.Second)
	if freshUntil.Before(deadline) {
		deadline = freshUntil
	}
	if until.Before(deadline) {
		deadline = until
	}
	ctx, cancel := context.WithDeadline(s.ctx, deadline)
	defer cancel()
	if err = a.Revalidate(ctx); err != nil {
		return err
	}
	p := servingPrepareRequest{Schema: servingPrepareSchema, Sequence: s.continuationSequence, PreviousSHA256: stream.previous, Observation: append([]byte(nil), ready.raw...)}
	raw, err := json.Marshal(p)
	if err != nil {
		return err
	}
	if _, err = decodeServingPrepare(raw); err != nil {
		return err
	}
	held, err := consumeRecord(receipts, "owner-serving-prepare-submit", raw)
	if err != nil {
		return err
	}
	defer held.Close()
	if err = s.alive(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
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
		return errors.New("serving preparation reply lost/late")
	}
	var proof servingPreparedProof
	d := json.NewDecoder(bytes.NewReader(reply))
	d.DisallowUnknownFields()
	if err = d.Decode(&proof); err != nil {
		return err
	}
	canonical, _ := json.Marshal(proof)
	sum := sha256.Sum256(raw)
	if !bytes.Equal(canonical, reply) || proof.Schema != servingPreparedSchema || proof.RequestSHA256 != hex.EncodeToString(sum[:]) {
		return errors.New("serving preparation response differs")
	}
	payloads, err := preparationPayloads(a, bundle, s.consent, s.request, initial, raw)
	if err != nil {
		return err
	}
	authorities, err := a.RPCStorageAuthorities(bundle, s.request)
	if err != nil {
		return err
	}
	for i, sigText := range []string{proof.L1, proof.Base} {
		key, _ := hex.DecodeString(authorities[i].PublicKey)
		sig, e := hex.DecodeString(sigText)
		if e != nil || hex.EncodeToString(sig) != sigText || !ed25519.Verify(ed25519.PublicKey(key), payloads[i], sig) {
			return errors.New("both original preparation signatures required")
		}
	}
	accepted, err := consumeRecord(receipts, "owner-serving-prepare-proof", reply)
	if err != nil {
		return err
	}
	defer accepted.Close()
	if err = s.alive(); err != nil {
		return err
	}
	s.mu.Lock()
	if s.ctx.Err() != nil || !time.Now().Before(deadline) || !time.Now().Before(s.authorizationUntil) {
		s.mu.Unlock()
		return errors.New("preparation expired before publication")
	}
	now, err = rpcservice.MonotonicNow()
	if err == nil {
		err = ready.record.Validate(ready.record.Binding, now)
	}
	if err != nil || now >= s.request.Deadline {
		s.mu.Unlock()
		return errors.New("preparation observation no longer fresh in original window")
	}
	s.prepared = &servingPrepared{request: p, raw: append([]byte(nil), reply...), until: freshUntil}
	s.mu.Unlock()
	// Preparation does NOT alter sequence/link, permit expiry or originalD.
	return stream.raw.SetDeadline(until)
}
