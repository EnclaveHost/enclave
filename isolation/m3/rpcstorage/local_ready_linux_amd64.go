//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

// A historical observation, never a reusable readiness/serving capability.
// Only the original private supervisor pipe can populate it. Every later
// handoff must resample freshness and current owner/export authority.
type brokerLocalReady struct {
	record contract.RPCLocalReady
	raw    []byte
	digest string
}

// ReceiveLocalReady consumes the ORIGINAL monitor-created pipe once. The
// monitor gives its sole writer to the exact native supervisor, which verifies
// its front's nonce and forwards the unchanged frame. The broker separately
// binds app/runtime/deployment, original interval, active reservation/export and
// the full request in its durable receipt. No host input or digest-only API.
// This prepares evidence; it does NOT adopt serving or alter any deadline.
func (s *BrokerSession) ReceiveLocalReady(r *os.File, bundle []byte, receipts *os.File) (err error) {
	defer func() {
		if err != nil {
			s.lose()
		}
	}()
	if !s.localReadyUsed.CompareAndSwap(false, true) {
		return errors.New("local readiness already consumed")
	}
	if err = s.alive(); err != nil {
		return err
	}
	if err = bootJournal(receipts); err != nil {
		return err
	}
	man, _, err := contract.ParseRPC(bundle)
	if err != nil {
		return err
	}
	s.mu.Lock()
	runtimeID := s.consent.RuntimeID()
	s.mu.Unlock()
	app := contract.AppID(bundle)
	if hex.EncodeToString(app[:]) != s.request.AppID || man.SecretDeployment != s.request.Deployment || !contract.NonzeroHash(runtimeID) {
		return errors.New("local readiness scope differs from original attempt")
	}
	record, raw, err := rpcservice.ReadLocalReadyEvidence(s.ctx, r)
	if err != nil {
		return err
	}
	expected := record.Binding // nonce authenticates this front via the private pipe topology
	expected.AppID = app
	runtimeBytes, _ := hex.DecodeString(runtimeID)
	copy(expected.RuntimeID[:], runtimeBytes)
	deployment, err := hex.DecodeString(man.SecretDeployment[2:])
	if err != nil || len(deployment) != 32 {
		return errors.New("invalid original deployment")
	}
	copy(expected.Deployment[:], deployment)
	check := func() error {
		if e := s.alive(); e != nil {
			return e
		}
		now, e := rpcservice.MonotonicNow()
		if e != nil {
			return e
		}
		if record.ObservedMono < s.request.Origin || now >= s.request.Deadline {
			return errors.New("readiness outside original attempt")
		}
		if e = record.Validate(expected, now); e != nil {
			return e
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		if !s.reserved || s.consent == nil || !s.exportBound || s.ctx.Err() != nil || !time.Now().Before(s.authorizationUntil) {
			return errors.New("live original storage authority required for readiness")
		}
		return nil
	}
	if err = check(); err != nil {
		return err
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	intent, _ := json.Marshal(struct {
		Schema  string  `json:"schema"`
		Request Request `json:"request"`
		SHA256  string  `json:"readinessSha256"`
	}{"enclave-rpc-local-readiness-consumed/1", s.request, digest})
	held, err := consumeRecord(receipts, "local-readiness-submit", intent)
	if err != nil {
		return err
	}
	defer held.Close()
	accepted, err := consumeRecord(receipts, "local-readiness-frame", raw)
	if err != nil {
		return err
	}
	defer accepted.Close()
	// Persistence/pipe time counts against the SAME sample and original deadline.
	if err = check(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil || !time.Now().Before(s.authorizationUntil) {
		return errors.New("authority lost while publishing readiness")
	}
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		return e
	}
	if now >= s.request.Deadline {
		return errors.New("original deadline elapsed before readiness publication")
	}
	if e = record.Validate(expected, now); e != nil {
		return e
	}
	s.localReady = &brokerLocalReady{record: record, raw: append([]byte(nil), raw...), digest: digest}
	if s.localReadySignal == nil {
		s.localReadySignal = make(chan struct{})
	}
	close(s.localReadySignal)
	return nil
}
