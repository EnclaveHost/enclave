package bootstrap

// Attested history checkpoints, the producer (work/history-checkpoint-transport-interface.txt). A measured SEV-SNP guest
// that verified its lease's history keeps extending that verified coverage to the finalized head, states it
// (CheckpointStatement), binds the statement into a fresh report of its own (REPORT_DATA = CheckpointReportData) and
// serves the envelope at GET /.well-known/enclave-history-checkpoint: public chain data and the guest's own evidence,
// no secret. Anyone may copy it to the owner's committed mirrors (cli: enclave history checkpoint export/mirror); the
// copy is verified by whoever adopts it, never by whoever carried it. Only coverage this process verified is stated, and
// a refresh that fails keeps the last envelope: finalized history never changes, so it stays true.

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"
)

const CheckpointPath = "/.well-known/enclave-history-checkpoint"

type CheckpointProducer struct {
	reader *Reader
	id     [32]byte
	report func(rd []byte) (rep, certs []byte, err error)
	// extend reads the lease's logs to the finalized head into the verified coverage (leasegen.go); a variable for tests
	extend   func(ctx context.Context) error
	mu       sync.Mutex
	envelope []byte
	sum      [32]byte
}

// NewCheckpointProducer: for an owner-committed startup's deployment, reading through the same measured quorum and the
// package's history sources, with report asking this guest's PSP for a report over a REPORT_DATA.
func NewCheckpointProducer(a *Authorization, report func(rd []byte) (rep, certs []byte, err error)) (*CheckpointProducer, error) {
	if a == nil || !a.valid || a.reader == nil || report == nil {
		return nil, errors.New("checkpoint producer needs a verified startup and a report source")
	}
	p := &CheckpointProducer{reader: a.reader, id: a.snapshot.row.id, report: report}
	history := a.history
	p.extend = func(ctx context.Context) error {
		// the coverage is extended step by step even when the fact itself is refused (a later claim, a renewal in flight)
		_, err := a.reader.writerAuthority(ctx, p.id, func(snapshot) error { return nil }, history)
		return err
	}
	return p, nil
}

// Refresh: extend the verified coverage, then, when its statement changed, bind it into a fresh report. -> the read's
// error, if any (the envelope is still refreshed from what is verified).
func (p *CheckpointProducer) Refresh(ctx context.Context) error {
	readErr := p.extend(ctx)
	st, err := p.reader.CheckpointStatement(p.id)
	if err != nil {
		return fmt.Errorf("checkpoint: %v (read: %v)", err, readErr)
	}
	sum := sha256.Sum256(st)
	p.mu.Lock()
	same := p.envelope != nil && sum == p.sum
	p.mu.Unlock()
	if same {
		return readErr
	}
	rd := CheckpointReportData(st)
	rep, certs, err := p.report(rd[:])
	if err != nil {
		return fmt.Errorf("checkpoint report: %v", err)
	}
	env, err := EncodeCheckpoint(st, rep, certs, nil)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.envelope, p.sum = env, sum
	p.mu.Unlock()
	return readErr
}

// Run refreshes now and then every `every`, each attempt bounded, until ctx ends.
func (p *CheckpointProducer) Run(ctx context.Context, every time.Duration, logf func(string, ...any)) {
	for {
		c, cancel := context.WithTimeout(ctx, 30*time.Minute)
		err := p.Refresh(c)
		cancel()
		if logf != nil {
			if lo, hi := p.Range(); hi > 0 {
				logf("history checkpoint: serving blocks %d-%d (refresh: %v)", lo, hi, err)
			} else {
				logf("history checkpoint: none yet (%v)", err)
			}
		}
		t := time.NewTimer(every)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// Range: the served statement's blocks (0, 0: none yet).
func (p *CheckpointProducer) Range() (lo, hi uint64) {
	if p == nil {
		return 0, 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.envelope == nil {
		return 0, 0
	}
	var c struct {
		Statement checkpointStatement `json:"statement"`
	}
	if e := json.Unmarshal(p.envelope, &c); e != nil {
		return 0, 0
	}
	return c.Statement.Lo, c.Statement.Hi
}

// ServeHTTP: GET (or HEAD) the current envelope. Public data: any origin may read it (the site's export reads it).
func (p *CheckpointProducer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "GET only", http.StatusMethodNotAllowed)
		return
	}
	var env []byte
	if p != nil {
		p.mu.Lock()
		env = p.envelope
		p.mu.Unlock()
	}
	if env == nil {
		http.Error(w, "no history checkpoint yet", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(env)
}
