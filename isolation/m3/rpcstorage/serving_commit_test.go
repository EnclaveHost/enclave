//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

func ownerCommitFixture(t *testing.T, lifetime time.Duration) (*OwnerContinuation, *bootstrap.RPCContinuationChain, servingCommitRequest) {
	t.Helper()
	c, chain, p := ownerContinuationFixture(t, lifetime)
	raw, e := c.IssueStartup(p)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = chain.Accept(c.issued.bundle, raw); e != nil {
		t.Fatal(e)
	}
	prep := ownerPreparationRequest(t, c)
	request, _ := json.Marshal(prep)
	proof, e := c.PrepareServing(request)
	if e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(proof)
	obs := sha256.Sum256(prep.Observation)
	p.Sequence++
	p.PreviousSHA256 = c.previous
	p.Phase = "serving"
	p.ReadinessSHA256 = hex.EncodeToString(obs[:])
	p.NotAfter = p.IssuedAt + 2
	return c, chain, servingCommitRequest{Schema: servingCommitSchema, PreparedSHA256: hex.EncodeToString(h[:]), Permit: p}
}
func ownerCommitBytes(p servingCommitRequest) []byte { r, _ := json.Marshal(p); return r }
func TestOwnerServingCommitDurableLiveChainAndRenewAfterStartup(t *testing.T) {
	c, chain, p := ownerCommitFixture(t, 180*time.Millisecond)
	original := c.owner.deadline
	raw, e := c.IssueServing(ownerCommitBytes(p))
	if e != nil {
		t.Fatal(e)
	}
	accepted, e := chain.Accept(c.issued.bundle, raw)
	if e != nil {
		t.Fatal(e)
	}
	stem := fmt.Sprintf("continuation-%s-%016x-proof", c.requestHash, p.Permit.Sequence)
	disk, e := os.ReadFile(filepath.Join(c.owner.journal.Name(), stem))
	if e != nil || !bytes.Equal(disk, raw) {
		t.Fatal("exact proof not persisted", e)
	}
	disk, e = os.ReadFile(filepath.Join(c.owner.journal.Name(), fmt.Sprintf("serving-commit-%s-%016x-submit", c.requestHash, p.Permit.Sequence)))
	if e != nil || !bytes.Equal(disk, ownerCommitBytes(p)) {
		t.Fatal("exact commit intent missing", e)
	}
	time.Sleep(time.Until(original) + 25*time.Millisecond)
	if c.ctx.Err() != nil || !c.bound.Load().serving || c.owner.deadline != original {
		t.Fatal("commit reset startup clock or failed to survive it")
	}
	p.Permit.Sequence++
	p.Permit.PreviousSHA256 = accepted.Digest()
	p.Permit.NotAfter++
	raw, e = c.IssueServing(ownerCommitBytes(p))
	if e != nil {
		t.Fatal("renewal after startup", e)
	}
	if _, e = chain.Accept(c.issued.bundle, raw); e != nil {
		t.Fatal(e)
	}
	// Neither a repeat commit nor an old receipt can re-open this live sequence.
	if _, e = c.IssueServing(ownerCommitBytes(p)); e == nil || c.ctx.Err() == nil {
		t.Fatal("replayed serving permit accepted")
	}
}
func TestOwnerServingCommitUsesCurrentChainAfterPreparation(t *testing.T) {
	c, chain, p := ownerCommitFixture(t, 0)
	next := p.Permit
	next.Phase = "startup"
	next.ReadinessSHA256 = ""
	next.NotAfter = next.IssuedAt + 30
	raw, e := c.IssueStartup(next)
	if e != nil {
		t.Fatal(e)
	}
	accepted, e := chain.Accept(c.issued.bundle, raw)
	if e != nil {
		t.Fatal(e)
	}
	p.Permit.Sequence++
	p.Permit.PreviousSHA256 = accepted.Digest()
	raw, e = c.IssueServing(ownerCommitBytes(p))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = chain.Accept(c.issued.bundle, raw); e != nil {
		t.Fatal(e)
	}
}
func TestOwnerServingCommitRefusalsRetainAuthorityBoundary(t *testing.T) {
	for _, mode := range []string{"no-live-preparation", "prepared-hash", "observation", "stale-preparation", "old-link", "gap", "wrong-phase", "intent-conflict", "proof-conflict", "unknown-field", "same-expiry-renewal", "startup-regression", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c, _, p := ownerCommitFixture(t, 0)
			switch mode {
			case "no-live-preparation":
				c.prepared = nil
			case "prepared-hash":
				p.PreparedSHA256 = strings.Repeat("e", 64)
			case "observation":
				p.Permit.ReadinessSHA256 = strings.Repeat("e", 64)
			case "stale-preparation":
				c.prepared.until = time.Now().Add(-time.Second)
			case "old-link":
				p.Permit.PreviousSHA256 = strings.Repeat("e", 64)
			case "gap":
				p.Permit.Sequence++
			case "wrong-phase":
				p.Permit.Phase = "startup"
			case "intent-conflict", "proof-conflict":
				name := fmt.Sprintf("serving-commit-%s-%016x-submit", c.requestHash, p.Permit.Sequence)
				if mode == "proof-conflict" {
					name = fmt.Sprintf("continuation-%s-%016x-proof", c.requestHash, p.Permit.Sequence)
				}
				if e := os.WriteFile(filepath.Join(c.owner.journal.Name(), name), []byte("held"), 0400); e != nil {
					t.Fatal(e)
				}
			case "same-expiry-renewal", "startup-regression":
				if _, e := c.IssueServing(ownerCommitBytes(p)); e != nil {
					t.Fatal(e)
				}
				p.Permit.Sequence++
				p.Permit.PreviousSHA256 = c.previous
			case "cancel":
				c.Close()
			}
			raw := ownerCommitBytes(p)
			if mode == "unknown-field" {
				raw = append(raw[:len(raw)-1], []byte(`,"override":true}`)...)
			}
			var out []byte
			var e error
			if mode == "startup-regression" {
				p.Permit.Phase = "startup"
				p.Permit.ReadinessSHA256 = ""
				out, e = c.IssueStartup(p.Permit)
			} else {
				out, e = c.IssueServing(raw)
			}
			if e == nil || out != nil || c.ctx.Err() == nil {
				t.Fatal("invalid commit did not poison original actor", e)
			}
			if mode == "proof-conflict" {
				if _, e = os.Stat(filepath.Join(c.owner.journal.Name(), fmt.Sprintf("serving-commit-%s-%016x-submit", c.requestHash, p.Permit.Sequence))); e != nil {
					t.Fatal("consumed commit disappeared", e)
				}
			}
		})
	}
}
func TestOwnerServingExpiryIndependentOfOperationLock(t *testing.T) {
	c, _, p := ownerCommitFixture(t, 180*time.Millisecond)
	if _, e := c.IssueServing(ownerCommitBytes(p)); e != nil {
		t.Fatal(e)
	}
	until := c.bound.Load().until
	c.op.Lock()
	select {
	case <-c.ctx.Done():
		if time.Now().Before(until) {
			c.op.Unlock()
			t.Fatal("serving ended before permit")
		}
	case <-time.After(time.Until(until) + 300*time.Millisecond):
		c.op.Unlock()
		t.Fatal("locked operation defeated independent expiry")
	}
	c.op.Unlock()
	<-c.done
	for _, key := range c.keys {
		if len(key) != 0 {
			t.Fatal("keys retained after operation settled")
		}
	}
}
func TestOwnerServingLateCommitCannotReviveBlockedOperation(t *testing.T) {
	c, _, p := ownerCommitFixture(t, 120*time.Millisecond)
	c.op.Lock()
	done := make(chan error, 1)
	go func() { _, e := c.IssueServing(ownerCommitBytes(p)); done <- e }()
	select {
	case <-c.ctx.Done():
	case <-time.After(time.Second):
		c.op.Unlock()
		t.Fatal("startup deadline waited for signing lock")
	}
	c.op.Unlock()
	if e := <-done; e == nil || c.bound.Load().serving {
		t.Fatal("late commit revived startup")
	}
}
func TestOwnerServingOriginalFramedEntryAndLostReply(t *testing.T) {
	for _, mode := range []string{"live-stream", "short-write"} {
		t.Run(mode, func(t *testing.T) {
			c, chain, p := ownerCommitFixture(t, 0)
			if mode == "short-write" {
				var request bytes.Buffer
				writeOwnerFrame(&request, ownerCommitBytes(p))
				if e := c.ServeStartupContinuations(&request, ownerShortWriter{}); e == nil || c.ctx.Err() == nil {
					t.Fatal("lost commit reply did not close")
				}
				if _, e := os.Stat(filepath.Join(c.owner.journal.Name(), fmt.Sprintf("continuation-%s-%016x-proof", c.requestHash, p.Permit.Sequence))); e != nil {
					t.Fatal("ambiguous committed proof not retained", e)
				}
				return
			}
			server, client := net.Pipe()
			defer server.Close()
			defer client.Close()
			done := make(chan error, 1)
			go func() { done <- c.ServeStartupContinuations(server, server) }()
			client.SetDeadline(time.Now().Add(time.Second))
			if e := writeOwnerFrame(client, ownerCommitBytes(p)); e != nil {
				t.Fatal(e)
			}
			raw, e := readOwnerFrame(client, 2048)
			if e != nil {
				t.Fatal(e)
			}
			if _, e = chain.Accept(c.issued.bundle, raw); e != nil {
				t.Fatal(e)
			}
			client.Close()
			if e = <-done; e == nil || c.ctx.Err() == nil {
				t.Fatal("EOF left original actor alive", e)
			}
		})
	}
}
