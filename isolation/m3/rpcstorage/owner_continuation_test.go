//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

func ownerContinuationFixture(t *testing.T, lifetime time.Duration) (*OwnerContinuation, *bootstrap.RPCContinuationChain, bootstrap.RPCContinuation) {
	t.Helper()
	o, a, b, r, seeds := ownerFixture(t)
	if lifetime != 0 {
		o.deadline = time.Now().Add(lifetime)
	}
	proof, e := o.Issue(context.Background(), a, b, r)
	if e != nil {
		t.Fatal(e)
	}
	c, e := o.BeginStartupContinuations(context.Background(), seeds)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() {
		c.Close()
		select {
		case <-c.done:
		case <-time.After(time.Second):
			t.Error("owner watcher did not stop")
		}
	})
	consent, e := a.VerifyRPCStorage(b, r, proof)
	if e != nil {
		t.Fatal(e)
	}
	chain, e := consent.NewContinuationChain()
	if e != nil {
		t.Fatal(e)
	}
	h := sha256.Sum256(proof)
	now := time.Now().Unix()
	p := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "startup", Sequence: 1, PreviousSHA256: hex.EncodeToString(h[:]), IssuedAt: now, NotAfter: now + 30}
	return c, chain, p
}
func TestOwnerContinuationPersistsAndCannotRestart(t *testing.T) {
	c, chain, p := ownerContinuationFixture(t, 0)
	for i := 0; i < 2; i++ {
		raw, e := c.IssueStartup(p)
		if e != nil {
			t.Fatal(e)
		}
		accepted, e := chain.Accept(c.issued.bundle, raw)
		if e != nil {
			t.Fatal(e)
		}
		stem := "continuation-" + c.requestHash + "-" + []string{"0000000000000001", "0000000000000002"}[i]
		disk, e := os.ReadFile(filepath.Join(c.owner.journal.Name(), stem+"-proof"))
		if e != nil || !bytes.Equal(raw, disk) {
			t.Fatal("reply not durable", e)
		}
		if _, e = os.Stat(filepath.Join(c.owner.journal.Name(), stem+"-submit")); e != nil {
			t.Fatal(e)
		}
		p.Sequence++
		p.PreviousSHA256 = accepted.Digest()
	}
	if _, e := c.owner.BeginStartupContinuations(context.Background(), [2][]byte{}); e == nil {
		t.Fatal("reattached same actor")
	}
	// Same protected journal but no live original issuance capability.
	next := &OwnerIssuer{journal: c.owner.journal, deadline: c.owner.deadline}
	if _, e := next.BeginStartupContinuations(context.Background(), [2][]byte{}); e == nil {
		t.Fatal("reopened receipt restored authority")
	}
}
func TestOwnerContinuationRefusalClosesAndRetainsRecords(t *testing.T) {
	for _, mode := range []string{"phase", "previous", "gap", "oversized-lifetime", "replay", "intent-conflict", "proof-conflict", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			c, _, p := ownerContinuationFixture(t, 0)
			stem := "continuation-" + c.requestHash + "-0000000000000001"
			switch mode {
			case "phase":
				p.Phase = "serving"
				p.ReadinessSHA256 = strings.Repeat("e", 64)
			case "previous":
				p.PreviousSHA256 = strings.Repeat("e", 64)
			case "gap":
				p.Sequence++
			case "oversized-lifetime":
				p.NotAfter++
			case "replay":
				if _, e := c.IssueStartup(p); e != nil {
					t.Fatal(e)
				}
			case "intent-conflict", "proof-conflict":
				suffix := "-submit"
				if mode == "proof-conflict" {
					suffix = "-proof"
				}
				if e := os.WriteFile(filepath.Join(c.owner.journal.Name(), stem+suffix), []byte("held"), 0400); e != nil {
					t.Fatal(e)
				}
			case "cancel":
				c.Close()
			}
			if raw, e := c.IssueStartup(p); e == nil || raw != nil {
				t.Fatal("refusal returned proof", e)
			}
			select {
			case <-c.Context().Done():
			case <-time.After(time.Second):
				t.Fatal("session still authorized")
			}
			<-c.done
			for _, key := range c.keys {
				if len(key) != 0 {
					t.Fatal("keys retained after stopped operation")
				}
			}
			if _, e := c.IssueStartup(p); e == nil {
				t.Fatal("failed session revived")
			}
			if mode == "proof-conflict" || mode == "replay" {
				if _, e := os.Stat(filepath.Join(c.owner.journal.Name(), stem+"-submit")); e != nil {
					t.Fatal("intent removed", e)
				}
			}
		})
	}
}
func TestOwnerContinuationOriginalDeadlineDuringBlockedRead(t *testing.T) {
	c, _, _ := ownerContinuationFixture(t, 150*time.Millisecond)
	server, client := net.Pipe()
	defer client.Close()
	defer server.Close()
	done := make(chan error, 1)
	go func() { done <- c.ServeStartupContinuations(server, server) }()
	// Models the command's independently armed exit on loss; no request arrives.
	select {
	case <-c.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("blocked read reset owner deadline")
	}
	server.Close()
	select {
	case e := <-done:
		if e == nil {
			t.Fatal("lost connection succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("transport did not stop")
	}
}
func TestOwnerContinuationFramedTransportToBroker(t *testing.T) {
	f, e := brokerFixtureStart(t, "valid", 0)
	if e != nil {
		t.Fatal(e)
	}
	s := f.session
	binding := bootstrap.RPCExportBinding{Host: "127.0.0.1", Port: 12345, ServerName: "storage.example", ServerCertificateSHA256: strings.Repeat("1", 64), ClientCertificateSHA256: strings.Repeat("2", 64), ContractSHA256: strings.Repeat("3", 64)}
	a, _, keys := exportAuthorizationKeys(t, s.request, &binding)
	seeds := [2][]byte{keys[0].Seed(), keys[1].Seed()}
	defer func() {
		for _, v := range seeds {
			clear(v)
		}
		for _, k := range keys {
			clear(k)
		}
	}()
	o, e := NewOwnerIssuer(persistentFixture(t), seeds, [2]string{s.request.L1Volume, s.request.BaseVolume}, binding, time.Now().Add(2*time.Second))
	if e != nil {
		t.Fatal(e)
	}
	proof, e := o.Issue(context.Background(), a, rpcBundle(t), s.request)
	if e != nil {
		t.Fatal(e)
	}
	defer o.proof.Close()
	for _, r := range o.intent.records {
		defer r.Close()
	}
	receipts := guestReceipts(t)
	if e = s.AuthenticateRemoteReservation(a, rpcBundle(t), proof, receipts); e != nil {
		t.Fatal(e)
	}
	c, e := o.BeginStartupContinuations(context.Background(), seeds)
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	done := make(chan error, 1)
	go func() { done <- c.ServeStartupContinuations(server, server) }()
	h := sha256.Sum256(proof)
	now := time.Now().Unix()
	p := bootstrap.RPCContinuation{Schema: bootstrap.RPCContinuationSchema, Phase: "startup", Sequence: 1, PreviousSHA256: hex.EncodeToString(h[:]), IssuedAt: now, NotAfter: now + 30}
	raw, _ := json.Marshal(p)
	if e = writeOwnerFrame(client, raw); e != nil {
		t.Fatal(e)
	}
	reply, e := readOwnerFrame(client, 2048)
	if e != nil {
		t.Fatal(e)
	}
	if e = s.ApplyStartupContinuation(rpcBundle(t), reply, receipts); e != nil {
		t.Fatal(e)
	}
	if s.continuationSequence != 1 {
		t.Fatal("broker did not apply owner reply")
	}
	client.Close()
	if e = <-done; e != io.EOF {
		t.Fatal("EOF did not terminate owner", e)
	}
	<-c.done
}
func TestOwnerContinuationWireRefusals(t *testing.T) {
	for _, mode := range []string{"duplicate", "trailing", "oversized-frame", "short-write"} {
		t.Run(mode, func(t *testing.T) {
			c, _, p := ownerContinuationFixture(t, 0)
			raw, _ := json.Marshal(p)
			switch mode {
			case "duplicate":
				raw = []byte(strings.Replace(string(raw), `"phase":`, `"phase":"startup","phase":`, 1))
			case "trailing":
				raw = append(raw, ' ')
			}
			var frame bytes.Buffer
			writeOwnerFrame(&frame, raw)
			if mode == "oversized-frame" {
				frame.Reset()
				var n [4]byte
				binary.BigEndian.PutUint32(n[:], 1025)
				frame.Write(n[:])
			}
			var out bytes.Buffer
			var w io.Writer = &out
			if mode == "short-write" {
				w = ownerShortWriter{}
			}
			if e := c.ServeStartupContinuations(&frame, w); e == nil {
				t.Fatal("bad wire accepted")
			}
			if !c.closed.Load() {
				t.Fatal("wire failure left session authorized")
			}
		})
	}
}

type ownerShortWriter struct{}

func (ownerShortWriter) Write(b []byte) (int, error) { return len(b) - 1, nil }

func TestOwnerContinuationAttachmentRefusesKeysAndExpiredActor(t *testing.T) {
	for _, mode := range []string{"before-issue", "wrong-key", "expired", "cancelled"} {
		t.Run(mode, func(t *testing.T) {
			o, a, b, r, seeds := ownerFixture(t)
			if mode != "before-issue" {
				if _, e := o.Issue(context.Background(), a, b, r); e != nil {
					t.Fatal(e)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "wrong-key":
				seeds[0], seeds[1] = seeds[1], seeds[0]
			case "expired":
				o.deadline = time.Now().Add(-time.Second)
			case "cancelled":
				cancel()
			}
			if c, e := o.BeginStartupContinuations(ctx, seeds); e == nil || c != nil {
				t.Fatal("invalid original attachment accepted", e)
			}
			if _, e := o.BeginStartupContinuations(context.Background(), seeds); e == nil {
				t.Fatal("failed attachment retried")
			}
		})
	}
}
