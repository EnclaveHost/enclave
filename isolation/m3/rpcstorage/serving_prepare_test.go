//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

func ownerPreparationRequest(t *testing.T, c *OwnerContinuation) servingPrepareRequest {
	t.Helper()
	b := contract.RPCStartBinding{Nonce: [32]byte{9}}
	for _, v := range []struct {
		text string
		dst  *[32]byte
	}{{c.issued.request.AppID, &b.AppID}, {c.issued.consent.RuntimeID(), &b.RuntimeID}, {strings.TrimPrefix(c.issued.request.Deployment, "0x"), &b.Deployment}} {
		raw, e := hex.DecodeString(v.text)
		if e != nil {
			t.Fatal(e)
		}
		copy(v.dst[:], raw)
	}
	// This owner fixture intentionally uses a DIFFERENT remote kernel epoch.
	now := c.issued.request.Origin + 1
	raw, e := (contract.RPCLocalReady{Binding: b, ObservedMono: now}).Frame()
	if e != nil {
		t.Fatal(e)
	}
	return servingPrepareRequest{Schema: servingPrepareSchema, Sequence: c.sequence, PreviousSHA256: c.previous, Observation: raw}
}
func TestOwnerServingPreparationIsDistinctOneShotAndNotPermit(t *testing.T) {
	c, chain, p := ownerContinuationFixture(t, 0)
	startup, e := c.IssueStartup(p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = chain.Accept(c.issued.bundle, startup); e != nil {
		t.Fatal(e)
	}
	before, seq, prev := *c.until.Load(), c.sequence, c.previous
	request := ownerPreparationRequest(t, c)
	raw, _ := json.Marshal(request)
	reply, e := c.PrepareServing(raw)
	if e != nil {
		t.Fatal(e)
	}
	if *c.until.Load() != before || c.sequence != seq || c.previous != prev || c.prepared == nil {
		t.Fatal("preparation modified permit/deadline")
	}
	disk, e := os.ReadFile(filepath.Join(c.owner.journal.Name(), "serving-prepare-"+c.requestHash+"-proof"))
	if e != nil || !bytes.Equal(disk, reply) {
		t.Fatal("proof not persisted", e)
	}
	var prepared servingPreparedProof
	if e = json.Unmarshal(reply, &prepared); e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(raw)
	if prepared.RequestSHA256 != hex.EncodeToString(h[:]) || prepared.Schema != servingPreparedSchema {
		t.Fatal("request binding lost")
	}
	if _, e = chain.Accept(c.issued.bundle, reply); e == nil {
		t.Fatal("preparation accepted as continuation")
	}
	if _, e = c.PrepareServing(raw); e == nil || c.ctx.Err() == nil {
		t.Fatal("preparation replay not terminal")
	}
}
func TestOwnerServingPreparationRefusals(t *testing.T) {
	for _, mode := range []string{"before-first-permit", "link", "sequence", "runtime", "app", "deployment", "clock", "unknown-field", "intent-conflict", "proof-conflict"} {
		t.Run(mode, func(t *testing.T) {
			c, _, permit := ownerContinuationFixture(t, 0)
			if mode != "before-first-permit" {
				if _, e := c.IssueStartup(permit); e != nil {
					t.Fatal(e)
				}
			}
			p := ownerPreparationRequest(t, c)
			switch mode {
			case "link":
				p.PreviousSHA256 = strings.Repeat("e", 64)
			case "sequence":
				p.Sequence++
			case "runtime", "app", "deployment", "clock":
				r, _ := contract.ParseRPCLocalReady(p.Observation)
				switch mode {
				case "runtime":
					r.Binding.RuntimeID[0]++
				case "app":
					r.Binding.AppID[0]++
				case "deployment":
					r.Binding.Deployment[0]++
				case "clock":
					r.ObservedMono = c.issued.request.Deadline
				}
				p.Observation, _ = r.Frame()
			case "intent-conflict", "proof-conflict":
				suffix := "submit"
				if mode == "proof-conflict" {
					suffix = "proof"
				}
				if e := os.WriteFile(filepath.Join(c.owner.journal.Name(), "serving-prepare-"+c.requestHash+"-"+suffix), []byte("held"), 0400); e != nil {
					t.Fatal(e)
				}
			}
			raw, _ := json.Marshal(p)
			if mode == "unknown-field" {
				raw = append(raw[:len(raw)-1], []byte(`,"grant":true}`)...)
			}
			_, e := c.PrepareServing(raw)
			if e == nil || c.ctx.Err() == nil || c.prepared != nil {
				t.Fatal("bad preparation did not poison", e)
			}
			if mode == "intent-conflict" || mode == "proof-conflict" {
				if !os.IsExist(e) {
					t.Fatal("did not reach intended journal conflict", e)
				}
				if mode == "proof-conflict" {
					if _, e = os.Stat(filepath.Join(c.owner.journal.Name(), "serving-prepare-"+c.requestHash+"-submit")); e != nil {
						t.Fatal("proof conflict had no consumed intent", e)
					}
				}
			}
		})
	}
}
func TestOwnerServingPreparationKeepsOriginalDeadline(t *testing.T) {
	c, _, p := ownerContinuationFixture(t, 180*time.Millisecond)
	if _, e := c.IssueStartup(p); e != nil {
		t.Fatal(e)
	}
	raw, _ := json.Marshal(ownerPreparationRequest(t, c))
	if _, e := c.PrepareServing(raw); e != nil {
		t.Fatal(e)
	}
	select {
	case <-c.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("preparation extended original deadline")
	}
	if _, e := c.PrepareServing(raw); e == nil {
		t.Fatal("dead actor revived")
	}
}
