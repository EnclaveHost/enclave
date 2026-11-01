//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"

	"enclave.host/isolation/m2/bootstrap"
)

const servingCommitSchema = "enclave-rpc-serving-commit/1"

// The original authenticated stream is the only production caller. The exact
// prepared proof identifies a LIVE preparation, never a reconstructed grant.
// Permit links to the CURRENT chain, which may have advanced after preparation.
type servingCommitRequest struct {
	Schema         string                    `json:"schema"`
	PreparedSHA256 string                    `json:"preparedSha256"`
	Permit         bootstrap.RPCContinuation `json:"permit"`
}

// IssueServing persists a consumed commit intent and exact dual-signed permit
// before changing THIS owner's independently watched cutoff. It cannot adopt
// the exporter/host/guest, start work, release writers, or bypass their guards.
// Subsequent calls renew the SAME original serving binding and chain. Any lost
// or refused request poisons the session; neither replies nor intents replay.
func (c *OwnerContinuation) IssueServing(raw []byte) ([]byte, error) {
	var p servingCommitRequest
	if len(raw) == 0 || len(raw) > 1024 {
		c.Close()
		return nil, errors.New("bounded serving commit required")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&p); e != nil {
		c.Close()
		return nil, e
	}
	canonical, e := json.Marshal(p)
	if e != nil || !bytes.Equal(raw, canonical) || p.Schema != servingCommitSchema {
		c.Close()
		return nil, errors.New("canonical serving commit required")
	}
	return c.issueContinuation(p.Permit, &p, raw)
}

// Caller holds the operation lock; the watchdog never takes that lock before
// cancelling. The owner's kernel epoch differs from the guest's: only the
// measured guest coordinator can check raw observation age against that clock.
func (c *OwnerContinuation) validateServingCommit(p servingCommitRequest, prior *ownerContinuationBound) error {
	if c.prepared == nil || c.sequence == 0 || p.Permit.Phase != "serving" {
		return errors.New("live original preparation required for serving")
	}
	prepared := sha256.Sum256(c.prepared.raw)
	observed := sha256.Sum256(c.prepared.request.Observation)
	if p.PreparedSHA256 != hex.EncodeToString(prepared[:]) || p.Permit.ReadinessSHA256 != hex.EncodeToString(observed[:]) {
		return errors.New("serving commit substituted preparation or private observation")
	}
	if !prior.serving && (!time.Now().Before(c.owner.deadline) || !time.Now().Before(c.prepared.until)) {
		return errors.New("first serving commit missed original preparation window")
	}
	return nil
}
