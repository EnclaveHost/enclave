//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/sha256"
	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBrokerReceivesBoundReadinessWithoutAdopting(t *testing.T) {
	for _, mode := range []string{"valid", "app", "runtime", "deployment", "stale", "future", "before-origin", "extra", "held-open", "no-export", "expired-authority", "receipt-conflict", "replay"} {
		t.Run(mode, func(t *testing.T) {
			s, receipts, _ := startupContinuationFixture(t, 0)
			s.mu.Lock()
			s.exportBound = true
			s.mu.Unlock()
			original := s.request
			runtimeID := s.consent.RuntimeID()
			bundle := rpcBundle(t)
			man, _, _ := contract.ParseRPC(bundle)
			binding := contract.RPCStartBinding{AppID: contract.AppID(bundle), Nonce: [32]byte{4}}
			rt, _ := hex.DecodeString(runtimeID)
			copy(binding.RuntimeID[:], rt)
			dep, _ := hex.DecodeString(man.SecretDeployment[2:])
			copy(binding.Deployment[:], dep)
			now, _ := rpcservice.MonotonicNow()
			record := contract.RPCLocalReady{Binding: binding, ObservedMono: now}
			switch mode {
			case "app":
				record.Binding.AppID[0]++
			case "runtime":
				record.Binding.RuntimeID[0]++
			case "deployment":
				record.Binding.Deployment[0]++
			case "stale":
				record.ObservedMono -= contract.RPCLocalReadyFreshnessNS
			case "future":
				record.ObservedMono += uint64(time.Second)
			case "before-origin":
				record.ObservedMono = s.request.Origin - 1
			case "no-export":
				s.mu.Lock()
				s.exportBound = false
				s.mu.Unlock()
			case "expired-authority":
				s.mu.Lock()
				s.authorizationUntil = time.Now().Add(-time.Second)
				s.mu.Unlock()
			case "receipt-conflict":
				if e := os.WriteFile(filepath.Join(receipts.Name(), "local-readiness-frame"), []byte("held"), 0400); e != nil {
					t.Fatal(e)
				}
			}
			raw, _ := record.Frame()
			sent := append([]byte(nil), raw...)
			if mode == "extra" {
				sent = append(sent, 0)
			}
			r, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer r.Close()
			defer w.Close()
			if _, e = w.Write(sent); e != nil {
				t.Fatal(e)
			}
			if mode == "held-open" {
				time.AfterFunc(60*time.Millisecond, s.lose)
			} else {
				w.Close()
			}
			e = s.ReceiveLocalReady(r, bundle, receipts)
			if (e == nil) != (mode == "valid" || mode == "replay") {
				t.Fatal(mode, e)
			}
			if mode == "valid" || mode == "replay" {
				got, e := os.ReadFile(filepath.Join(receipts.Name(), "local-readiness-frame"))
				if e != nil || !bytes.Equal(got, raw) {
					t.Fatal("raw proof not retained", e)
				}
				digest := sha256.Sum256(raw)
				if s.localReady == nil || s.localReady.record != record || s.localReady.digest != hex.EncodeToString(digest[:]) || s.request != original {
					t.Fatal("readiness changed attempt")
				}
				if mode == "replay" {
					if e = s.ReceiveLocalReady(r, bundle, receipts); e == nil {
						t.Fatal("replay accepted")
					}
				}
			}
			if mode != "valid" {
				select {
				case <-s.ctx.Done():
				default:
					t.Fatal("failed input did not poison session")
				}
			}
		})
	}
}
func TestBrokerLocalReadinessKeepsOriginalDeadline(t *testing.T) {
	s, receipts, _ := startupContinuationFixture(t, 220*time.Millisecond)
	s.mu.Lock()
	s.exportBound = true
	s.mu.Unlock()
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	// A complete-looking frame without EOF must never block the independent
	// original deadline or become a usable observation.
	now, _ := rpcservice.MonotonicNow()
	man, _, _ := contract.ParseRPC(rpcBundle(t))
	dep, _ := hex.DecodeString(man.SecretDeployment[2:])
	b := contract.RPCStartBinding{AppID: contract.AppID(rpcBundle(t)), Nonce: [32]byte{4}}
	copy(b.Deployment[:], dep)
	rt, _ := hex.DecodeString(s.consent.RuntimeID())
	copy(b.RuntimeID[:], rt)
	raw, _ := (contract.RPCLocalReady{Binding: b, ObservedMono: now}).Frame()
	w.Write(raw)
	begin := time.Now()
	if e = s.ReceiveLocalReady(r, rpcBundle(t), receipts); e == nil {
		t.Fatal("held writer accepted")
	}
	if time.Since(begin) > time.Second || s.localReady != nil {
		t.Fatal("deadline extended")
	}
}
