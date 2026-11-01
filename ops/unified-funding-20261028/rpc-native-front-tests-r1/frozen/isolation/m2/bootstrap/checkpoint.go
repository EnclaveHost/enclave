package bootstrap

// Attested history checkpoints (work/history-owner-tools-interface.txt section 6). A guest that has VERIFIED a lease's
// finalized history (its coverage: every lease log of [lo, hi], from two independent operators, finalized, replayed)
// can state it and bind the statement into its own SEV-SNP report. Another guest of the SAME measured build, for the
// SAME deployment, on a chip at or above its own TCB, with AMD's chain to the pinned ARK and a fresh ARK-signed CRL,
// may then adopt [lo, hi] as its own coverage and read only the blocks after hi, under the unchanged quorum, finality
// and replay rules. Nothing else is trusted: a host cache or one provider's transcript is NOT a checkpoint.
//
// Threat binding:
//   - forged or altered statement: REPORT_DATA[0:32] = sha256("enclave-history-checkpoint-v1\0" || statement bytes),
//     [32:64] zero; the statement must be in its canonical form;
//   - another deployment's checkpoint: HOST_DATA (PSP-signed launch word) must equal this deployment, and so must the
//     statement;
//   - another image (a build that would state anything): MEASUREMENT must equal this guest's own;
//   - a weaker or revoked platform: reported AND committed TCB >= this guest's own, ASK not on a FRESH CRL, VCEK chain to
//     the pinned ARK, DEBUG/MIGRATE_MA off, VMPL0;
//   - an OLD checkpoint (withheld newer ones): finalized history never changes, so it is still true; the tail after hi
//     is read under quorum, so a later same-runner release + reclaim is still found;
//   - a checkpoint past this guest's finalized view: not adopted until its hi is finalized here;
//   - expired or stale collateral: the certificates' and the CRL's window must hold at adoption (this guest's clock) AND
//     at the agreed chain block's own timestamp when it is used (seedFromCheckpoint);
//   - a gap: coverage is one contiguous range; a checkpoint extends it only when contiguous with it, else replaces it,
//     and the search below its lo and the tail above its hi are read as before (leasegen.go). Its statement holds EVERY
//     lease log of the deployment in [lo, hi] (Reader.keep keeps complete ranges), so it states no absence it did not read.
// Transport (checkpoint_transport.go, checkpoint_producer.go): any carrier; the evidence authenticates itself.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const checkpointDomain = "enclave-history-checkpoint-v1\x00"

type checkpointLog struct {
	Block     uint64   `json:"block"`
	Index     uint64   `json:"index"`
	BlockHash string   `json:"blockHash"`
	Topics    []string `json:"topics"`
	Data      string   `json:"data"`
}
type checkpointStatement struct {
	V          int             `json:"v"`
	ChainID    uint64          `json:"chainId"`
	Ledger     string          `json:"ledger"`
	Deployment string          `json:"deployment"`
	Lo         uint64          `json:"lo"`
	Hi         uint64          `json:"hi"`
	Logs       []checkpointLog `json:"logs"`
}

// Checkpoint is the portable envelope: the statement's exact bytes, the producing guest's report and certificate table,
// and an ARK-signed CRL (anyone may attach a fresher one: it is authenticated by the ARK, not by who carries it).
type Checkpoint struct {
	Statement json.RawMessage `json:"statement"`
	Report    string          `json:"report"`
	Certs     string          `json:"certs"`
	CRL       string          `json:"crl,omitempty"`
}

const maxCheckpointLogs = 100000

// CheckpointStatement: this guest's verified coverage of id, as canonical bytes. Only coverage this process verified
// (r.keep: complete, finalized, quorum-agreed) can be stated.
func (r *Reader) CheckpointStatement(id [32]byte) ([]byte, error) {
	cov, ok := r.coverage(id)
	if !ok || cov.lo == 0 || cov.lo > cov.hi {
		return nil, errors.New("no verified coverage to state")
	}
	st := checkpointStatement{V: 1, ChainID: r.chainID, Ledger: r.ledger, Deployment: "0x" + hex.EncodeToString(id[:]), Lo: cov.lo, Hi: cov.hi, Logs: []checkpointLog{}}
	for _, l := range cov.logs {
		st.Logs = append(st.Logs, checkpointLog{l.block, l.index, l.blockHash, l.topics, l.data})
	}
	return json.Marshal(st)
}

// CheckpointReportData: the REPORT_DATA a statement is bound with.
func CheckpointReportData(statement []byte) [64]byte {
	var rd [64]byte
	h := sha256.Sum256(append([]byte(checkpointDomain), statement...))
	copy(rd[:32], h[:])
	return rd
}

// EncodeCheckpoint: the envelope for a statement, the report over CheckpointReportData(statement) and its certificate
// table (and a CRL when the producer has one).
func EncodeCheckpoint(statement, report, certs, crl []byte) ([]byte, error) {
	c := Checkpoint{Statement: statement, Report: base64.StdEncoding.EncodeToString(report), Certs: base64.StdEncoding.EncodeToString(certs)}
	if len(crl) > 0 {
		c.CRL = base64.StdEncoding.EncodeToString(crl)
	}
	return json.Marshal(c)
}

// checkpointTrust: the verifying guest's own identity, from its OWN report (read from its PSP): what a checkpoint's
// producer must match or exceed.
type checkpointTrust struct {
	product     string
	measurement []byte
	minTCB      map[string]int
}

type verifiedCheckpoint struct {
	lo, hi uint64
	logs   []leaseLog
	window snpWindow // when its collateral holds (snpverify.go)
}

var checkpointMu sync.Mutex

// TrustCheckpointsFrom enables checkpoints, with this guest's own SNP report as the reference (its measurement, product
// line and reported TCB). Without it no checkpoint is ever adopted.
func (r *Reader) TrustCheckpointsFrom(ownReport []byte) error {
	p, err := parseSNPReport(ownReport)
	if err != nil {
		return fmt.Errorf("own report: %v", err)
	}
	product, err := snpProduct(p)
	if err != nil {
		return fmt.Errorf("own report: %v", err)
	}
	checkpointMu.Lock()
	defer checkpointMu.Unlock()
	r.cpTrust = &checkpointTrust{product: product, measurement: append([]byte(nil), p.measurement...), minTCB: decodeTCB(product, p.reportedTCB)}
	return nil
}

// AdoptCheckpoint verifies a checkpoint for id and keeps it for writerAuthority, which seeds coverage from it once its
// hi is finalized in this guest's own view. A refusal says why; the read itself is unaffected (it scans as before).
func (r *Reader) AdoptCheckpoint(id [32]byte, raw []byte) error {
	return r.adoptCheckpoint(id, raw, nil, nil)
}

// adoptCheckpoint: AdoptCheckpoint, where the evidence's certificate table and CRL may also come from other carriers
// (certPool, crlPool: another mirror's copy, a refreshed CRL). They are judged exactly as the envelope's own: chained to
// the pinned ARK, the CRL ARK-signed and fresh. Its own collateral is tried first; its refusal is the one reported.
func (r *Reader) adoptCheckpoint(id [32]byte, raw []byte, certPool, crlPool [][]byte) error {
	checkpointMu.Lock()
	trust := r.cpTrust
	checkpointMu.Unlock()
	if trust == nil {
		return errors.New("checkpoints are not enabled (no own report)")
	}
	if len(raw) == 0 || len(raw) > 32<<20 {
		return errors.New("checkpoint size")
	}
	// the envelope: unique keys, exactly its members (the statement kept as its own bytes: the binding covers them)
	var c Checkpoint
	var members map[string]json.RawMessage
	if e := uniqueJSON(raw); e != nil || json.Unmarshal(raw, &members) != nil {
		return errors.New("checkpoint envelope: not an unambiguous JSON object")
	}
	for k := range members {
		if k != "statement" && k != "report" && k != "certs" && k != "crl" {
			return fmt.Errorf("checkpoint envelope: unknown member %q", k)
		}
	}
	str := func(k string, out *string, required bool) error {
		v, ok := members[k]
		if !ok {
			if required {
				return fmt.Errorf("checkpoint envelope: %s missing", k)
			}
			return nil
		}
		if json.Unmarshal(v, out) != nil {
			return fmt.Errorf("checkpoint envelope: %s is not a string", k)
		}
		return nil
	}
	if e := str("report", &c.Report, true); e != nil {
		return e
	}
	if e := str("certs", &c.Certs, true); e != nil {
		return e
	}
	if e := str("crl", &c.CRL, false); e != nil {
		return e
	}
	if c.Statement = members["statement"]; len(c.Statement) == 0 {
		return errors.New("checkpoint envelope: statement missing")
	}
	var st checkpointStatement
	if e := strictJSON(c.Statement, &st); e != nil {
		return fmt.Errorf("checkpoint statement: %v", e)
	}
	if canon, _ := json.Marshal(st); !bytes.Equal(canon, c.Statement) {
		return errors.New("checkpoint statement is not in canonical form")
	}
	idHex := "0x" + hex.EncodeToString(id[:])
	if st.V != 1 || st.ChainID != r.chainID || st.Ledger != r.ledger || st.Deployment != idHex {
		return errors.New("checkpoint statement names another chain, ledger or deployment")
	}
	if st.Lo < 1 || st.Lo < leaseFromBlock || st.Lo > st.Hi || len(st.Logs) > maxCheckpointLogs {
		return errors.New("checkpoint statement range is invalid")
	}
	logs := make([]leaseLog, 0, len(st.Logs))
	var prevB, prevI uint64
	for i, l := range st.Logs {
		if l.Block < st.Lo || l.Block > st.Hi || (i > 0 && (l.Block < prevB || l.Block == prevB && l.Index <= prevI)) {
			return errors.New("checkpoint logs are outside the range or out of order")
		}
		if len(l.Topics) < 2 || l.Topics[1] != idHex || !(l.Topics[0] == topicClaimed || l.Topics[0] == topicRenewed || l.Topics[0] == topicReleased) {
			return errors.New("checkpoint holds a log that is not this deployment's lease log")
		}
		if !lowerHexWord(l.BlockHash) || l.Data != strings.ToLower(l.Data) || !strings.HasPrefix(l.Data, "0x") {
			return errors.New("checkpoint log is not canonical")
		}
		for _, t := range l.Topics {
			if !lowerHexWord(t) {
				return errors.New("checkpoint log topic is not canonical")
			}
		}
		prevB, prevI = l.Block, l.Index
		logs = append(logs, leaseLog{block: l.Block, index: l.Index, blockHash: l.BlockHash, topics: l.Topics, data: l.Data})
	}
	report, e1 := base64.StdEncoding.DecodeString(c.Report)
	certs, e2 := base64.StdEncoding.DecodeString(c.Certs)
	crl, e3 := base64.StdEncoding.DecodeString(c.CRL)
	if e1 != nil || e2 != nil || e3 != nil {
		return errors.New("checkpoint evidence is not base64")
	}
	rd := CheckpointReportData(c.Statement)
	pol := snpPolicy{Product: trust.product, MinTCB: trust.minTCB, Measurements: [][]byte{trust.measurement}, HostData: id[:], ReportData: rd[:], Now: r.now()}
	win, tried, err := func() (snpWindow, int, error) {
		var first error
		tried := 0
		for _, cs := range distinct(append([][]byte{certs}, certPool...)) {
			for _, cr := range distinct(append([][]byte{crl}, crlPool...)) {
				if tried++; tried > maxCollateralTries {
					return snpWindow{}, tried - 1, first
				}
				w, e := checkSNPEvidence(report, cs, cr, pol)
				if e == nil {
					return w, tried, nil
				}
				if first == nil {
					first = e
				}
			}
		}
		return snpWindow{}, tried, first
	}()
	if err != nil && tried > 1 {
		return fmt.Errorf("checkpoint evidence: %v (and with every other carrier's certificates and CRL)", err)
	}
	if err != nil {
		return fmt.Errorf("checkpoint evidence: %v", err)
	}
	checkpointMu.Lock()
	defer checkpointMu.Unlock()
	if r.cps == nil {
		r.cps = map[[32]byte]*verifiedCheckpoint{}
	}
	// the furthest-reaching checkpoint is kept: an older one adopted later (replayed, rolled back) never replaces it
	if old, ok := r.cps[id]; !ok || old.hi < st.Hi {
		r.cps[id] = &verifiedCheckpoint{lo: st.Lo, hi: st.Hi, logs: logs, window: win}
	}
	return nil
}

// maxCollateralTries bounds the (certificate table x CRL) combinations one checkpoint is verified with.
const maxCollateralTries = 16

// distinct: the non-empty byte strings of in, first occurrence kept.
func distinct(in [][]byte) [][]byte {
	var out [][]byte
	seen := map[string]bool{}
	for _, b := range in {
		if len(b) == 0 || seen[string(b)] {
			continue
		}
		seen[string(b)] = true
		out = append(out, b)
	}
	if len(out) == 0 {
		out = [][]byte{nil} // still judged, so the refusal names what is missing
	}
	return out
}

func lowerHexWord(s string) bool {
	if len(s) != 66 || !strings.HasPrefix(s, "0x") || s != strings.ToLower(s) {
		return false
	}
	_, e := hex.DecodeString(s[2:])
	return e == nil
}

// seedFromCheckpoint (writerAuthority): an adopted checkpoint becomes coverage once its hi is finalized in THIS view, its
// collateral still holds at the agreed block's own timestamp and at this guest's clock, and it reaches further than what
// is already covered. Contiguous with the existing coverage, it extends it (the verified blocks below its lo are kept);
// otherwise it replaces it, so coverage stays ONE range with no unread gap. -> the checkpoint's hi when seeded (its claim
// needs no re-check of canonicality: the producing guest checked it, and it is final), else 0.
func (r *Reader) seedFromCheckpoint(id [32]byte, finalized, agreed, chainTime uint64) uint64 {
	checkpointMu.Lock()
	cp := r.cps[id]
	checkpointMu.Unlock()
	if cp == nil || cp.hi > finalized || cp.hi > agreed {
		return 0
	}
	if !cp.window.holds(time.Unix(int64(chainTime), 0)) || !cp.window.holds(r.now()) {
		return 0
	}
	cov, ok := r.coverage(id)
	if ok && cov.hi >= cp.hi {
		return 0
	}
	next := coverage{cp.lo, cp.hi, append([]leaseLog(nil), cp.logs...)}
	if ok && cov.lo < cp.lo && cp.lo <= cov.hi+1 {
		var below []leaseLog
		for _, l := range cov.logs {
			if l.block < cp.lo {
				below = append(below, l)
			}
		}
		next = coverage{cov.lo, cp.hi, append(below, next.logs...)}
	}
	r.keep(id, next)
	return cp.hi
}

// checkpointAttests: is c exactly one of an adopted checkpoint's logs (same block, index, hash, topics, data)?
func (r *Reader) checkpointAttests(id [32]byte, c leaseLog) bool {
	checkpointMu.Lock()
	defer checkpointMu.Unlock()
	cp := r.cps[id]
	if cp == nil || c.block > cp.hi || c.block < cp.lo {
		return false
	}
	for _, l := range cp.logs {
		if l.block == c.block && l.index == c.index && l.blockHash == c.blockHash && l.data == c.data && strings.Join(l.topics, ",") == strings.Join(c.topics, ",") {
			return true
		}
	}
	return false
}
