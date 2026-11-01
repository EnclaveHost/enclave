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
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

// ownerIssued exists only after the ORIGINAL actor durably published its proof.
// No constructor accepts a caller's proof/journal as a replacement for this live
// process capability. Reopening old records never recreates continuation rights.
type ownerIssued struct {
	authorization *bootstrap.Authorization
	bundle        []byte
	request       Request
	consent       *bootstrap.RPCStorageConsent
	proof         []byte
}

// OwnerContinuation is an explicitly selected continuous owner session. It
// never starts another export or releases writers. The independently bounded
// process must kill itself on Context loss: cancellation cannot interrupt fsync
// or an arbitrary transport. No serving handoff is implemented here.
type OwnerContinuation struct {
	op                    sync.Mutex
	closed                atomic.Bool
	until                 atomic.Pointer[time.Time]
	ctx                   context.Context
	cancel                context.CancelFunc
	owner                 *OwnerIssuer
	issued                *ownerIssued
	chain                 *bootstrap.RPCContinuationChain
	keys                  [2]ed25519.PrivateKey
	sequence              uint64
	previous, requestHash string
	done                  chan struct{}
}

// BeginStartupContinuations can attach ONCE to this same successful live actor,
// before its original deadline and immutable acquisition consent expire. Seeds
// are explicitly supplied again by local owner provisioning; Issue still erases
// its own key copies. Nothing is rehydrated from a disk receipt after restart.
func (o *OwnerIssuer) BeginStartupContinuations(ctx context.Context, seeds [2][]byte) (c *OwnerContinuation, err error) {
	if o == nil || !o.continuationUsed.CompareAndSwap(false, true) {
		return nil, errors.New("owner continuation attachment consumed")
	}
	issued := o.issued.Load()
	if ctx == nil || ctx.Err() != nil || issued == nil || !time.Now().Before(o.deadline) {
		return nil, errors.New("successful live original owner required")
	}
	chain, err := issued.consent.NewContinuationChain()
	if err != nil {
		return nil, err
	}
	authorities, err := issued.authorization.RPCStorageAuthorities(issued.bundle, issued.request)
	if err != nil {
		return nil, err
	}
	c = &OwnerContinuation{owner: o, issued: issued, chain: chain, done: make(chan struct{})}
	defer func() {
		if err != nil {
			if c.cancel != nil {
				c.Close()
				<-c.done
			} else {
				for _, k := range c.keys {
					clear(k)
				}
			}
			c = nil
		}
	}()
	for i, seed := range seeds {
		if len(seed) != ed25519.SeedSize {
			return c, errors.New("exact local continuation seed required")
		}
		c.keys[i] = ed25519.NewKeyFromSeed(seed)
		if authorities[i].VolumeID != o.volumes[i] || authorities[i].PublicKey != hex.EncodeToString(c.keys[i].Public().(ed25519.PublicKey)) {
			return c, errors.New("continuation key differs from original owner authority")
		}
	}
	before := time.Now()
	until := before.Add(issued.consent.NotAfter().Sub(time.Now()))
	if !time.Now().Before(until) {
		return c, errors.New("original owner consent expired before attachment")
	}
	c.until.Store(&until)
	c.ctx, c.cancel = context.WithDeadline(ctx, o.deadline)
	raw, _ := json.Marshal(issued.request)
	h := sha256.Sum256(raw)
	c.requestHash = hex.EncodeToString(h[:])
	h = sha256.Sum256(issued.proof)
	c.previous = hex.EncodeToString(h[:])
	armed := make(chan struct{})
	go c.watch(armed)
	<-armed
	if err = c.check(); err != nil {
		c.Close()
		return c, err
	}
	return c, nil
}
func (c *OwnerContinuation) Context() context.Context { return c.ctx }

// Close is nonblocking. Key erasure follows any in-flight operation; the native
// owner process must terminate independently if that operation is stuck.
func (c *OwnerContinuation) Close() {
	if c != nil {
		c.closed.Store(true)
		if c.cancel != nil {
			c.cancel()
		}
	}
}
func (c *OwnerContinuation) check() error {
	if c.closed.Load() || c.ctx.Err() != nil || !time.Now().Before(c.owner.deadline) || !time.Now().Before(*c.until.Load()) {
		return errors.New("original owner continuation authority lost")
	}
	return nil
}
func (c *OwnerContinuation) watch(armed chan<- struct{}) {
	defer close(c.done)
	timer := time.NewTicker(5 * time.Millisecond)
	defer timer.Stop()
	close(armed)
	for {
		if c.check() != nil {
			break
		}
		select {
		case <-c.ctx.Done():
		case <-timer.C:
		}
	}
	c.Close()
	// Cancellation above does not wait for the signing/persistence lock.
	c.op.Lock()
	for i := range c.keys {
		clear(c.keys[i])
		c.keys[i] = nil
	}
	c.op.Unlock()
}

// IssueStartup consumes one sequential intent before producing signatures, then
// persists the exact signed reply before returning. Any refusal poisons the
// WHOLE live session. A lost response never authorizes a retry or fresh actor.
func (c *OwnerContinuation) IssueStartup(p bootstrap.RPCContinuation) (raw []byte, err error) {
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
	if p.Schema != bootstrap.RPCContinuationSchema || p.Phase != "startup" || p.ReadinessSHA256 != "" || p.Sequence != c.sequence+1 || p.PreviousSHA256 != c.previous {
		return nil, errors.New("exact next startup continuation required; serving unavailable")
	}
	// The SAME owner-authorized deployment is independently refreshed, under the
	// prior permit deadline. Refresh alone does not extend the active permit.
	ctx, cancel := context.WithDeadline(c.ctx, *c.until.Load())
	defer cancel()
	if err = c.issued.authorization.Revalidate(ctx); err != nil {
		return nil, err
	}
	payloads, err := c.issued.authorization.RPCContinuationSigningPayloads(c.issued.bundle, c.issued.consent, p)
	if err != nil {
		return nil, err
	}
	intent, _ := json.Marshal(struct {
		Schema        string                    `json:"schema"`
		RequestSHA256 string                    `json:"requestSha256"`
		Permit        bootstrap.RPCContinuation `json:"permit"`
	}{"enclave-rpc-owner-continuation-submit/1", c.requestHash, p})
	name := fmt.Sprintf("continuation-%s-%016x", c.requestHash, p.Sequence)
	if err = c.check(); err != nil {
		return nil, err
	}
	held, err := consumeRecord(c.owner.journal, name+"-submit", intent)
	if err != nil {
		return nil, err
	}
	defer held.Close()
	if err = c.check(); err != nil {
		return nil, err
	}
	proof := bootstrap.RPCContinuationSignatures{Permit: p, L1: hex.EncodeToString(ed25519.Sign(c.keys[0], payloads[0])), Base: hex.EncodeToString(ed25519.Sign(c.keys[1], payloads[1]))}
	raw, err = json.Marshal(proof)
	if err != nil {
		return nil, err
	}
	accepted, err := c.chain.Accept(c.issued.bundle, raw)
	if err != nil {
		return nil, err
	}
	receipt, err := consumeRecord(c.owner.journal, name+"-proof", raw)
	if err != nil {
		return nil, err
	}
	defer receipt.Close()
	if err = c.check(); err != nil {
		return nil, err
	}
	until := accepted.NotAfter()
	if !time.Now().Before(until) {
		return nil, errors.New("continuation expired during persistence")
	}
	c.until.Store(&until)
	c.sequence, c.previous = p.Sequence, accepted.Digest()
	// Watchdog may have observed the previous bound concurrently. Never undo it.
	if err = c.check(); err != nil {
		return nil, err
	}
	return raw, nil
}

// ServeStartupContinuations handles bounded length-prefixed requests on the
// SAME owner-authenticated connection. The caller has already sent the initial
// proof. It must close the connection/kill its process on c.Context loss even if
// Read/Write/fsync blocks. EOF, bad frames, lost/short writes and all errors end
// the whole session; there is no reconnect or request retry. No serving phase.
func (c *OwnerContinuation) ServeStartupContinuations(r io.Reader, w io.Writer) (err error) {
	defer c.Close()
	for {
		if err = c.check(); err != nil {
			return err
		}
		raw, e := readOwnerFrame(r, 1024)
		if e != nil {
			return e
		}
		var p bootstrap.RPCContinuation
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if d.Decode(&p) != nil {
			return errors.New("invalid continuation request")
		}
		canonical, e := json.Marshal(p)
		if e != nil || !bytes.Equal(raw, canonical) {
			return errors.New("exact canonical continuation request required")
		}
		proof, e := c.IssueStartup(p)
		if e != nil {
			return e
		}
		if e = writeOwnerFrame(w, proof); e != nil {
			return e
		}
	}
}
