package bootstrap

// Attested history checkpoints, the consumer's transport (work/history-checkpoint-transport-interface.txt). A cold-starting
// SEV-SNP guest fetches checkpoints from the mirror URLs its owner COMMITTED in the startup package (history.checkpoints),
// through its measured client, each host admitted to the dial allowlist only here, after Authorize verified the owner's
// on-chain commitment. Nothing a host supplies is fetched or read. A mirror is only a carrier: every envelope is verified
// (AdoptCheckpoint: AMD's chain to the pinned ARK, a fresh ARK-signed CRL, this guest's own measurement and TCB floor,
// HOST_DATA, the statement binding), so a lost, stale or lying mirror costs availability, never correctness. Certificate
// tables and CRLs any carrier brought are pooled: a refreshed CRL on one mirror completes a copy whose own CRL went stale.
// Loading never fails a startup: without an adopted checkpoint the lease's history is read from the sources as before.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// maxCheckpointBytes bounds one fetched envelope (AdoptCheckpoint's own bound); checkpointFetchTimeout one load.
const maxCheckpointBytes = 32 << 20

var checkpointFetchTimeout = 60 * time.Second

// CheckpointMirrors: the owner-committed mirror URLs of this authorization's package (nil: none).
func (a *Authorization) CheckpointMirrors() []string {
	if a == nil || !a.valid || a.manifest.History == nil {
		return nil
	}
	return append([]string(nil), a.manifest.History.Checkpoints...)
}

// CheckpointLoad: what a load did, for the guest's console. Hi is the adopted checkpoint's (0: none).
type CheckpointLoad struct {
	Lo, Hi  uint64
	Results []string
}

func (l CheckpointLoad) String() string {
	head := "none adopted"
	if l.Hi > 0 {
		head = fmt.Sprintf("adopted blocks %d-%d", l.Lo, l.Hi)
	}
	return head + " (" + strings.Join(l.Results, "; ") + ")"
}

// LoadCheckpoints: enable checkpoints with this guest's OWN SNP report (its measurement, product line and TCB are what a
// producer must match), fetch every committed mirror at once (bounded), and adopt what verifies.
func (a *Authorization) LoadCheckpoints(ctx context.Context, ownReport []byte) CheckpointLoad {
	mirrors := a.CheckpointMirrors()
	if len(mirrors) == 0 {
		return CheckpointLoad{Results: []string{"no mirrors committed"}}
	}
	r := a.reader
	if err := r.TrustCheckpointsFrom(ownReport); err != nil {
		return CheckpointLoad{Results: []string{"not enabled: " + err.Error()}}
	}
	id := a.snapshot.row.id
	ctx, cancel := context.WithTimeout(ctx, checkpointFetchTimeout)
	defer cancel()
	bodies, errs := make([][]byte, len(mirrors)), make([]error, len(mirrors))
	var wg sync.WaitGroup
	for i, u := range mirrors {
		host, ok := historyURL(u)
		if !ok { // Authorize validated it; never reached
			errs[i] = errors.New("not a mirror URL")
			continue
		}
		if r.allow != nil {
			r.allow(net.JoinHostPort(host, "443"))
		}
		wg.Add(1)
		go func(i int, u string) {
			defer wg.Done()
			bodies[i], errs[i] = r.fetchCheckpoint(ctx, u)
		}(i, u)
	}
	wg.Wait()
	var certPool, crlPool [][]byte
	for _, b := range bodies {
		if c, l := envelopeCollateral(b); c != nil || l != nil {
			certPool, crlPool = append(certPool, c), append(crlPool, l)
		}
	}
	var out CheckpointLoad
	for i, u := range mirrors {
		host, _ := historyURL(u)
		if errs[i] != nil {
			out.Results = append(out.Results, host+": unavailable: "+errs[i].Error())
			continue
		}
		if e := r.adoptCheckpoint(id, bodies[i], certPool, crlPool); e != nil {
			out.Results = append(out.Results, host+": refused: "+e.Error())
			continue
		}
		out.Results = append(out.Results, host+": verified")
	}
	checkpointMu.Lock()
	if cp := r.cps[id]; cp != nil {
		out.Lo, out.Hi = cp.lo, cp.hi
	}
	checkpointMu.Unlock()
	return out
}

// fetchCheckpoint: one mirror's envelope over the measured client (TLS to the measured roots, the guest's egress), HTTP
// 200 only, no redirect followed, at most maxCheckpointBytes.
func (r *Reader) fetchCheckpoint(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, errors.New("invalid mirror URL")
	}
	c := r.client
	c.Timeout = checkpointFetchTimeout
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse } // a mirror is its URL
	res, err := c.Do(req)
	if err != nil {
		return nil, errors.New("transport failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxCheckpointBytes+1))
	if err != nil {
		return nil, errors.New("transport failed")
	}
	if len(b) == 0 || len(b) > maxCheckpointBytes {
		return nil, errors.New("size outside the limit")
	}
	return b, nil
}

// envelopeCollateral: an envelope's certificate table and CRL as carried, unjudged (they count only once AMD's chain
// authenticates them in adoptCheckpoint); nil for anything unreadable.
func envelopeCollateral(b []byte) (certs, crl []byte) {
	if len(b) == 0 {
		return nil, nil
	}
	var e struct {
		Certs string `json:"certs"`
		CRL   string `json:"crl"`
	}
	if json.Unmarshal(b, &e) != nil {
		return nil, nil
	}
	certs, _ = base64.StdEncoding.DecodeString(e.Certs)
	crl, _ = base64.StdEncoding.DecodeString(e.CRL)
	return certs, crl
}
