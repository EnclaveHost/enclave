//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

func startupContinuationFixture(t *testing.T, remaining time.Duration, phase ...string) (*BrokerSession, *os.File, []byte) {
	t.Helper()
	f, err := brokerFixtureStart(t, "valid", remaining)
	if err != nil {
		t.Fatal(err)
	}
	s := f.session
	binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
	a, proof, keys := exportAuthorizationKeys(t, s.Request(), &binding)
	receipts := guestReceipts(t)
	if err = s.AuthenticateRemoteReservation(a, rpcBundle(t), proof, receipts); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(proof)
	now := time.Now().Unix()
	p := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "startup", Sequence: 1, PreviousSHA256: hex.EncodeToString(h[:]), IssuedAt: now, NotAfter: now + 30}
	if len(phase) != 0 {
		p.Phase = phase[0]
		p.ReadinessSHA256 = strings.Repeat("e", 64)
	}
	payloads, err := a.RPCContinuationSigningPayloads(rpcBundle(t), s.consent, p)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(bootstrap.RPCContinuationSignatures{Permit: p, L1: hex.EncodeToString(ed25519.Sign(keys[0], payloads[0])), Base: hex.EncodeToString(ed25519.Sign(keys[1], payloads[1]))})
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range keys {
		clear(key)
	}
	return s, receipts, raw
}

func TestStartupContinuationPersistsAndCannotResetOriginalDeadline(t *testing.T) {
	s, receipts, raw := startupContinuationFixture(t, 300*time.Millisecond)
	original := s.request
	if err := s.ApplyStartupContinuation(rpcBundle(t), raw, receipts); err != nil {
		t.Fatal(err)
	}
	if s.request != original || s.continuationSequence != 1 {
		t.Fatal("attempt changed")
	}
	got, err := os.ReadFile(filepath.Join(receipts.Name(), "continuation-0000000000000001-accepted"))
	if err != nil || !bytes.Equal(raw, got) {
		t.Fatal("accepted proof not persisted", err)
	}
	if _, err = os.Stat(filepath.Join(receipts.Name(), "continuation-0000000000000001-submit")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-s.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("continuation reset original900s window")
	}
	if err = s.ApplyStartupContinuation(rpcBundle(t), raw, receipts); err == nil {
		t.Fatal("expired session revived")
	}
}

func TestStartupContinuationFailureRetainsIntentAndClosesSession(t *testing.T) {
	for _, mode := range []string{"bad-signature", "receipt-conflict", "replay"} {
		t.Run(mode, func(t *testing.T) {
			s, receipts, raw := startupContinuationFixture(t, 0)
			switch mode {
			case "bad-signature":
				var p bootstrap.RPCContinuationSignatures
				json.Unmarshal(raw, &p)
				p.Base = p.L1
				raw, _ = json.Marshal(p)
			case "receipt-conflict":
				if err := os.WriteFile(filepath.Join(receipts.Name(), "continuation-0000000000000001-accepted"), []byte("held"), 0400); err != nil {
					t.Fatal(err)
				}
			case "replay":
				if err := s.ApplyStartupContinuation(rpcBundle(t), raw, receipts); err != nil {
					t.Fatal(err)
				}
			}
			if err := s.ApplyStartupContinuation(rpcBundle(t), raw, receipts); err == nil {
				t.Fatal("failed continuation accepted")
			}
			select {
			case <-s.ctx.Done():
			default:
				t.Fatal("failed continuation left session live")
			}
			if _, err := os.Stat(filepath.Join(receipts.Name(), "continuation-0000000000000001-submit")); err != nil {
				t.Fatal("consumed intent lost", err)
			}
		})
	}
}

func TestStartupContinuationRefusesValidServingPermit(t *testing.T) {
	s, receipts, raw := startupContinuationFixture(t, 0, "serving")
	original := s.authorizationUntil
	if err := s.ApplyStartupContinuation(rpcBundle(t), raw, receipts); err == nil || !strings.Contains(err.Error(), "serving handoff is not implemented") {
		t.Fatal("serving was not refused at phase gate", err)
	}
	if s.authorizationUntil != original {
		t.Fatal("serving permit changed startup authority")
	}
	select {
	case <-s.ctx.Done():
	default:
		t.Fatal("serving refusal left session live")
	}
	if _, err := os.Stat(filepath.Join(receipts.Name(), "continuation-0000000000000001-submit")); err != nil {
		t.Fatal("intent missing", err)
	}
	if _, err := os.Stat(filepath.Join(receipts.Name(), "continuation-0000000000000001-accepted")); !os.IsNotExist(err) {
		t.Fatal("serving receipt published", err)
	}
}
