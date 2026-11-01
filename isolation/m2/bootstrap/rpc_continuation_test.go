package bootstrap

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func continuationRig(t *testing.T) (storageRig, *RPCStorageConsent, *RPCContinuationChain, RPCContinuation) {
	t.Helper()
	x := newStorageRig(t)
	raw := x.exportProof(t, exportFixture())
	c, err := x.auth.VerifyRPCStorage(x.bundle, x.request, raw)
	if err != nil {
		t.Fatal(err)
	}
	chain, err := c.NewContinuationChain()
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(raw)
	now := x.auth.reader.now().Unix()
	p := RPCContinuation{Schema: RPCContinuationSchema, Phase: "startup", Sequence: 1, PreviousSHA256: hex.EncodeToString(h[:]), IssuedAt: now, NotAfter: now + 30}
	return x, c, chain, p
}

func signContinuation(t *testing.T, x storageRig, c *RPCStorageConsent, p RPCContinuation) []byte {
	t.Helper()
	payloads, err := x.auth.RPCContinuationSigningPayloads(x.bundle, c, p)
	if err != nil {
		t.Fatal(err)
	}
	proof := RPCContinuationSignatures{Permit: p, L1: hex.EncodeToString(ed25519.Sign(x.keys[0], payloads[0])), Base: hex.EncodeToString(ed25519.Sign(x.keys[1], payloads[1]))}
	raw, err := json.Marshal(proof)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestRPCContinuationExplicitSequenceAndOneWayPhase(t *testing.T) {
	x, c, chain, p := continuationRig(t)
	originalExpiry := c.NotAfter()
	first, err := chain.Accept(x.bundle, signContinuation(t, x, c, p))
	if err != nil {
		t.Fatal(err)
	}
	if first.Permit() != p || first.Digest() == "" || time.Until(first.NotAfter()) > 30*time.Second {
		t.Fatal(first)
	}
	p.Sequence++
	p.PreviousSHA256 = first.Digest()
	p.Phase = "serving"
	p.ReadinessSHA256 = strings.Repeat("f", 64)
	next, err := chain.Accept(x.bundle, signContinuation(t, x, c, p))
	if err != nil {
		t.Fatal(err)
	}
	if c.NotAfter() != originalExpiry {
		t.Fatal("silently changed original acquisition consent")
	}
	p.Sequence++
	p.PreviousSHA256 = next.Digest()
	if _, err = chain.Accept(x.bundle, signContinuation(t, x, c, p)); err != nil {
		t.Fatal(err)
	}
	p.Sequence++
	p.PreviousSHA256 = chain.previous
	p.Phase = "startup"
	p.ReadinessSHA256 = ""
	if _, err = chain.Accept(x.bundle, signContinuation(t, x, c, p)); err == nil {
		t.Fatal("serving reverted to startup")
	}
}

func TestRPCContinuationRejectsTamperAndPoisonsReplay(t *testing.T) {
	for _, mode := range []string{"role", "signature", "key", "phase", "sequence", "previous", "readiness", "issued", "expiry", "oversize", "duplicate", "alias", "trailing", "space", "runtime", "owner", "chain", "ledger", "export", "epoch"} {
		t.Run(mode, func(t *testing.T) {
			x, c, chain, p := continuationRig(t)
			valid := signContinuation(t, x, c, p)
			var proof RPCContinuationSignatures
			json.Unmarshal(valid, &proof)
			switch mode {
			case "role":
				proof.Base = proof.L1
			case "signature":
				proof.Base = strings.Repeat("00", 64)
			case "key":
				x.auth.manifest.RPCStorage.Base.PublicKey = x.auth.manifest.RPCStorage.L1.PublicKey
			case "phase":
				proof.Permit.Phase = "serving"
			case "sequence":
				proof.Permit.Sequence++
			case "previous":
				proof.Permit.PreviousSHA256 = strings.Repeat("0", 64)
			case "readiness":
				proof.Permit.ReadinessSHA256 = strings.Repeat("1", 64)
			case "issued":
				proof.Permit.IssuedAt++
			case "expiry":
				proof.Permit.NotAfter++
			case "runtime":
				x.auth.manifest.RuntimeID = strings.Repeat("8", 64)
			case "owner":
				x.auth.snapshot.row.owner = "0x" + strings.Repeat("9", 40)
			case "chain":
				x.auth.manifest.ChainID++
			case "ledger":
				x.auth.manifest.Ledger = "0x" + strings.Repeat("a", 40)
			case "export":
				c.export.Port++
			case "epoch":
				c.l1Epoch = strings.Repeat("f", 64)
			}
			raw, _ := json.Marshal(proof)
			switch mode {
			case "oversize":
				raw = []byte(strings.Repeat("x", 2049))
			case "duplicate":
				raw = []byte(strings.Replace(string(raw), `"phase":`, `"phase":"startup","phase":`, 1))
			case "alias":
				raw = []byte(strings.Replace(string(raw), `"phase":`, `"Phase":`, 1))
			case "trailing":
				raw = append(raw, []byte(`{}`)...)
			case "space":
				raw = append(raw, ' ')
			}
			if _, err := chain.Accept(x.bundle, raw); err == nil {
				t.Fatal("invalid continuation accepted")
			}
			if _, err := chain.Accept(x.bundle, valid); err == nil {
				t.Fatal("failed chain revived")
			}
		})
	}
}

func TestRPCContinuationNoExpiredOrClockRollbackRevival(t *testing.T) {
	for _, mode := range []string{"expired", "rollback", "revoked", "replay", "adoption-change"} {
		t.Run(mode, func(t *testing.T) {
			x, c, chain, p := continuationRig(t)
			p.Phase = "serving"
			p.ReadinessSHA256 = strings.Repeat("e", 64)
			raw := signContinuation(t, x, c, p)
			first, err := chain.Accept(x.bundle, raw)
			if err != nil {
				t.Fatal(err)
			}
			p.Sequence++
			p.PreviousSHA256 = first.Digest()
			next := signContinuation(t, x, c, p)
			switch mode {
			case "expired":
				chain.until = time.Now().Add(-time.Nanosecond)
			case "rollback":
				now := x.auth.reader.now()
				x.auth.reader.now = func() time.Time { return now.Add(-time.Second) }
			case "revoked":
				for _, peer := range x.peers {
					peer.row.Store(commit(t, x.vectors.Variants["owner"], x.vectors.Manifest, x.raw))
				}
				if x.auth.Revalidate(context.Background()) == nil {
					t.Fatal("owner change not observed")
				}
			case "replay":
				next = raw
			case "adoption-change":
				p.ReadinessSHA256 = strings.Repeat("f", 64)
				next = signContinuation(t, x, c, p)
			}
			if _, err = chain.Accept(x.bundle, next); err == nil {
				t.Fatal("lost consent revived")
			}
		})
	}
}

func TestRPCContinuationClockMappingAndImmutableOriginal(t *testing.T) {
	x, c, chain, p := continuationRig(t)
	first, err := chain.Accept(x.bundle, signContinuation(t, x, c, p))
	if err != nil {
		t.Fatal(err)
	}
	p.Sequence++
	p.PreviousSHA256 = first.Digest()
	// The rig's wall clock is fixed. A later read must not give the same absolute
	// expiry a fresh30s interval, even with a valid new signed sequence.
	time.Sleep(15 * time.Millisecond)
	next, err := chain.Accept(x.bundle, signContinuation(t, x, c, p))
	if err != nil {
		t.Fatal(err)
	}
	if next.NotAfter() != first.NotAfter() {
		t.Fatal("same absolute expiry was refreshed")
	}
	p.Sequence++
	p.PreviousSHA256 = next.Digest()
	p.NotAfter = p.IssuedAt + 31
	if _, err = x.auth.RPCContinuationSigningPayloads(x.bundle, c, p); err == nil {
		t.Fatal("oversized lifetime signed")
	}
	legacy, err := x.auth.VerifyRPCStorage(x.bundle, x.request, x.proof(t))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = legacy.NewContinuationChain(); err == nil {
		t.Fatal("legacy unbound export accepted")
	}
	if _, err = (&RPCStorageConsent{}).NewContinuationChain(); err == nil {
		t.Fatal("fabricated consent accepted")
	}
}
