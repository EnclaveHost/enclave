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
	"os"
	"time"

	"enclave.host/isolation/m2/bootstrap"
	"enclave.host/isolation/m3/rpcservice"
)

// continueServingOwnerOnce is reached only by the original authenticated /2
// loop after both guardian PREPARE acknowledgements. It commits the original
// owner and two local guardians, NOT the independent exporter/host. The broker's
// original deadline and export transport cutoff intentionally remain enforced
// until their complete coordinated handoff is implemented and qualified.
func (s *BrokerSession) continueServingOwnerOnce(stream *ownerContinuationConnection, a *bootstrap.Authorization, bundle []byte, receipts *os.File) (err error) {
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
	prepared, ready, prior, guards := s.prepared, s.localReady, s.authorizationUntil, s.guards
	guardianSequence, guardUntil := s.servingSequence, s.servingUntil
	bound := s.reserved && s.exportBound
	s.mu.Unlock()
	if prepared == nil || ready == nil || !bound || stream == nil || stream.authorization != a || stream.previous == "" || s.continuation == nil || guards[0] == nil || guards[1] == nil || !bytes.Equal(prepared.request.Observation, ready.raw) {
		return errors.New("same live prepared owner, readiness, export and guardians required")
	}
	first := guardianSequence == 0
	deadline := time.Now().Add(3 * time.Second)
	if prior.Before(deadline) {
		deadline = prior
	}
	if first && prepared.until.Before(deadline) {
		deadline = prepared.until
	}
	if !first && guardUntil.Before(deadline) {
		deadline = guardUntil
	}
	check := func() error {
		if !time.Now().Before(deadline) {
			return errors.New("serving transaction exceeded prior authority/freshness")
		}
		if e := s.alive(); e != nil {
			return e
		}
		if first {
			now, e := rpcservice.MonotonicNow()
			if e != nil {
				return e
			}
			if e = ready.record.Validate(ready.record.Binding, now); e != nil {
				return e
			}
			if now >= s.request.Deadline {
				return errors.New("first serving commit after original deadline")
			}
		}
		return nil
	}
	if err = check(); err != nil {
		return err
	}
	ctx, cancel := context.WithDeadline(s.ctx, deadline)
	defer cancel()
	if err = a.Revalidate(ctx); err != nil {
		return err
	}
	preparedHash := sha256.Sum256(prepared.raw)
	observationHash := sha256.Sum256(ready.raw)
	now := time.Now().Unix()
	permit := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "serving", Sequence: s.continuationSequence + 1, PreviousSHA256: stream.previous, ReadinessSHA256: hex.EncodeToString(observationHash[:]), IssuedAt: now, NotAfter: now + bootstrap.RPCContinuationMaxSeconds}
	request := servingCommitRequest{Schema: servingCommitSchema, PreparedSHA256: hex.EncodeToString(preparedHash[:]), Permit: permit}
	raw, err := json.Marshal(request)
	if err != nil {
		return err
	}
	// Consume before even one transport write. Every ambiguous result stays held.
	held, err := consumeRecord(receipts, fmt.Sprintf("owner-serving-%016x-submit", permit.Sequence), raw)
	if err != nil {
		return err
	}
	defer held.Close()
	if err = check(); err != nil {
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
		return errors.New("serving owner response lost or late; held")
	}
	if err = check(); err != nil {
		return err
	}
	accepted, err := s.continuation.Accept(bundle, reply)
	if err != nil {
		return err
	}
	if accepted.Permit() != permit {
		return errors.New("signed serving response differs from exact consumed request")
	}
	if !first && !accepted.NotAfter().After(guardUntil) {
		return errors.New("serving permit did not advance previous expiry")
	}
	proof, err := consumeRecord(receipts, fmt.Sprintf("owner-serving-%016x-proof", permit.Sequence), reply)
	if err != nil {
		return err
	}
	defer proof.Close()
	if err = check(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	// Same original authenticated exporter commits its worker first. A lost
	// acknowledgement is ambiguous and closes the entire session; no replay.
	if err = s.commitExportPermit(ctx, reply, accepted.NotAfter()); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	// Anchor to the EARLIER actual kernel sample and LATER Go remaining time:
	// scheduling overhead can only shorten the guard permit, never reset expiry.
	mono, err := rpcservice.MonotonicNow()
	if err != nil {
		return err
	}
	left := time.Until(accepted.NotAfter())
	if left <= 0 || left > 30*time.Second || uint64(left) > ^uint64(0)-mono {
		return errors.New("bounded monotonic serving expiry required")
	}
	expiry := mono + uint64(left)
	binding := rpcservice.GuardBinding{Origin: s.request.Origin, Deadline: s.request.Deadline, Observed: ready.record.ObservedMono, PreparedSHA256: preparedHash}
	nextGuardian := guardianSequence + 1
	for _, g := range guards {
		if err = check(); err != nil {
			return err
		}
		if first {
			err = g.Commit(ctx, binding, expiry)
		} else {
			err = g.Renew(ctx, binding, nextGuardian, expiry)
		}
		if err != nil {
			return err
		}
	}
	if err = check(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	receipt, _ := json.Marshal(struct {
		Schema      string `json:"schema"`
		Sequence    uint64 `json:"guardianSequence"`
		Expiry      uint64 `json:"expiryMonotonicNs"`
		ProofSHA256 string `json:"proofSha256"`
	}{"enclave-rpc-owner-guardians-committed/1", nextGuardian, expiry, accepted.Digest()})
	committed, err := consumeRecord(receipts, fmt.Sprintf("owner-serving-%016x-guardians", permit.Sequence), receipt)
	if err != nil {
		return err
	}
	defer committed.Close()
	if err = check(); err != nil {
		return err
	}
	s.mu.Lock()
	if s.ctx.Err() != nil || ctx.Err() != nil || !time.Now().Before(s.authorizationUntil) || !time.Now().Before(accepted.NotAfter()) {
		s.mu.Unlock()
		return errors.New("authority expired during serving publication")
	}
	s.authorizationUntil = accepted.NotAfter()
	s.servingSequence = nextGuardian
	// The guard's slightly conservative expiry must bound the NEXT transaction.
	sampled := time.Now()
	actual, e := rpcservice.MonotonicNow()
	if e != nil || actual >= expiry {
		s.mu.Unlock()
		return errors.New("guardian expiry passed before publication")
	}
	s.servingUntil = sampled.Add(time.Duration(expiry - actual))
	s.servingProof = append([]byte(nil), reply...)
	s.continuationSequence = permit.Sequence
	stream.previous = accepted.Digest()
	s.mu.Unlock()
	// No broker startup timer, exporter read deadline or host cutoff is changed.
	if err = stream.raw.SetDeadline(accepted.NotAfter()); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	return ctx.Err()
}
