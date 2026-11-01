//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"
)

// ApplyStartupContinuation admits an explicit new dual-signed off-chain permit
// to the SAME consumed attempt. It never resets originalD, reconnects an exporter,
// starts work, grants writable roots, or adopts serving mode. Serving-phase
// permits are deliberately refused until the complete handoff is implemented.
// The trusted broker uses its SAME accepted boot journal; arbitrary fresh paths
// or reconstructed sessions are not replay authority. Caller serializes chain
// revalidation with this operation; an independent watchdog must bound fsync.
func (s *BrokerSession) ApplyStartupContinuation(bundle, raw []byte, receipts *os.File) (err error) {
	s.continuationMu.Lock()
	defer s.continuationMu.Unlock()
	return s.applyStartupContinuation(bundle, raw, receipts)
}
func (s *BrokerSession) applyStartupContinuation(bundle, raw []byte, receipts *os.File) (err error) {
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if len(raw) == 0 || len(raw) > 2048 {
		return errors.New("bounded startup continuation proof required")
	}
	if err = s.alive(); err != nil {
		return err
	}
	if err = bootJournal(receipts); err != nil {
		return err
	}
	s.mu.Lock()
	consent, reserved := s.consent, s.reserved
	s.mu.Unlock()
	if !reserved || consent == nil {
		return errors.New("original authenticated reservation required")
	}
	if s.continuation == nil {
		s.continuation, err = consent.NewContinuationChain()
		if err != nil {
			return err
		}
	}
	// Consume a deterministic sequence name BEFORE verification/application.
	// Even an invalid or interrupted response remains held and poisons the actor.
	sequence := s.continuationSequence + 1
	if sequence > (1<<53)-1 {
		return errors.New("continuation sequence exhausted")
	}
	sum := sha256.Sum256(raw)
	intent, _ := json.Marshal(struct {
		Schema      string  `json:"schema"`
		Request     Request `json:"request"`
		Sequence    uint64  `json:"sequence"`
		ProofSHA256 string  `json:"proofSha256"`
	}{"enclave-rpc-continuation-consumed/1", s.request, sequence, hex.EncodeToString(sum[:])})
	held, err := consumeRecord(receipts, fmt.Sprintf("continuation-%016x-submit", sequence), intent)
	if err != nil {
		return err
	}
	defer held.Close()
	accepted, err := s.continuation.Accept(bundle, raw)
	if err != nil {
		return err
	}
	if accepted.Permit().Phase != "startup" || accepted.Permit().Sequence != sequence {
		return errors.New("serving handoff is not implemented; startup continuation only")
	}
	receipt, err := consumeRecord(receipts, fmt.Sprintf("continuation-%016x-accepted", sequence), raw)
	if err != nil {
		return err
	}
	defer receipt.Close()
	if err = s.alive(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// The watcher may have expired the old authorization while persistence was
	// blocked. No fresh signature or successful fsync may revive a lost session.
	if s.ctx.Err() != nil || !time.Now().Before(s.authorizationUntil) || !time.Now().Before(accepted.NotAfter()) {
		return errors.New("continuation arrived after authority loss; retained")
	}
	s.authorizationUntil = accepted.NotAfter()
	s.continuationSequence = sequence
	return nil
}
