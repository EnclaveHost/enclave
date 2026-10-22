package bootstrap

// The writer-authority fact of a deployment's CURRENT lease, read by the measured guest itself through its own RPC quorum
// (relay-free; storage writer fencing, work/storage-front-binding-interface.txt). The same rules as the relay's reader
// (relay/lease-generation.mjs), on the live rev-16d ledger (blob 3f3d2c3a):
//   - one FRESH agreed snapshot (read(): two peers identical on block, hash, schema 16 and the row), the lease current
//     (and, for an owner-committed startup, still that authorization's owner/runner/operator/appRef/envelope);
//   - only peers that hold that exact block hash read the logs; every one of them must return identical logs for each
//     range (Claimed, Renewed, Released for this id). Each peer's range shrinks on a range refusal (mainnet.base.org:
//     200 blocks), backs off on a rate limit, and an unserved history is an error, never an empty one;
//   - the last Claimed replays to the row: its runner and operator; no Released after it; every later Renewed names the
//     same runner; the last leaseUntil equals the row's. Omitted logs cannot produce an older, lower generation;
//   - the claim is at or below the peers' FINALIZED block (Base: ~20 minutes behind the head), its block hash canonical.
// The verified FINALIZED log coverage is kept in this process (Reader.cov), so a retry while the claim finalizes, or a
// long search spread over attempts, never re-reads it. Nothing persists across a guest boot.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"enclave.host/isolation/m2/appconfig"
)

const (
	topicClaimed  = "0xa8cc21eb0ec0b0b7328426babbe37866c627edfd2ae57aeaed4f54abc0534bc0" // Claimed(bytes32,bytes32,address,uint64,uint256)
	topicRenewed  = "0xc3f167f2092d6942fb4264b1759de5eda7eedc20287375c9eddd62e98a560b3e" // Renewed(bytes32,bytes32,uint64,uint256)
	topicReleased = "0x0e334fd11ab7bea6d2bda89338c0f25674e099b70dd28aaaee262fbecba48882" // Released(bytes32,bytes32,uint256)
)

// Bounds (variables for tests): the live 16d ledger's first block with code (no lease log is older), the first range
// asked per eth_getLogs, the smallest it shrinks to, and the eth_getLogs calls per peer per attempt.
var (
	leaseFromBlock   uint64 = 52_515_705
	leaseWindow      uint64 = 1_000
	leaseMinWindow   uint64 = 8
	leaseMaxRequests        = 400
	leaseBackoff            = 500 * time.Millisecond
)

var (
	rangeRE   = regexp.MustCompile(`(?i)range|block limit|too many (blocks|results|logs)|exceed|-32614|-32005|response size|query returned more than`)
	rateRE    = regexp.MustCompile(`(?i)rate.?limit|request limit|too many requests|HTTP 429|-32011|-32029|capacity|throttl`)
	historyRE = regexp.MustCompile(`(?i)archive|pruned|missing trie|header not found|not (available|supported) on free plan|personal token|history`)
)

// AuthorityError: no fact. Retry is true when the chain may answer later (quorum, finality, a lagging provider, a search
// still in progress).
type AuthorityError struct {
	Code  string
	Retry bool
	msg   string
}

func (e *AuthorityError) Error() string { return "writer authority " + e.Code + ": " + e.msg }
func authErr(code string, retry bool, format string, a ...any) error {
	return &AuthorityError{Code: code, Retry: retry, msg: fmt.Sprintf(format, a...)}
}

type rpcLog struct {
	Address         string   `json:"address"`
	Topics          []string `json:"topics"`
	Data            string   `json:"data"`
	BlockNumber     string   `json:"blockNumber"`
	BlockHash       string   `json:"blockHash"`
	TransactionHash string   `json:"transactionHash"`
	LogIndex        string   `json:"logIndex"`
	Removed         bool     `json:"removed"`
}
type leaseLog struct {
	block, index uint64
	blockHash    string
	topics       []string
	data         string
}

// coverage: the contiguous FINALIZED block range [lo, hi] whose lease logs two agreeing peers returned, with those logs.
type coverage struct {
	lo, hi uint64
	logs   []leaseLog
}

var covMu sync.Mutex

func (r *Reader) coverage(id [32]byte) (coverage, bool) {
	covMu.Lock()
	defer covMu.Unlock()
	c, ok := r.cov[id]
	return c, ok
}
func (r *Reader) keep(id [32]byte, c coverage) {
	covMu.Lock()
	defer covMu.Unlock()
	if r.cov == nil {
		r.cov = map[[32]byte]coverage{}
	}
	r.cov[id] = c
}

// WriterAuthority computes the fact for an owner-committed startup (the row must still be this authorization's).
func (a *Authorization) WriterAuthority(ctx context.Context) (appconfig.WriterAuthority, error) {
	if a == nil || !a.valid || a.reader == nil {
		return appconfig.WriterAuthority{}, errors.New("unverified startup authorization")
	}
	old := a.snapshot
	w, err := a.reader.writerAuthority(ctx, old.row.id, func(s snapshot) error {
		n, o := s.row, old.row
		if s.number < old.number || n.owner != o.owner || n.runner != o.runner || n.operator != o.operator || n.appRef != o.appRef || n.envelope != o.envelope {
			a.valid = false
			return errors.New("startup authorization changed")
		}
		return nil
	}, a.history)
	if err != nil {
		return w, err
	}
	// the lease this startup was authorized under, never a later one: a claim after the authorizing snapshot is a
	// re-claim (even by the same runner) and this guest restarts rather than adopting it
	if w.ClaimBlock > a.authorizedAt {
		a.valid = false
		return appconfig.WriterAuthority{}, authErr("lease_changed", false, "the lease was claimed again (block %d) after this startup was authorized (block %d)", w.ClaimBlock, a.authorizedAt)
	}
	return w, nil
}

// LeaseWriterAuthority computes the fact of the current lease of `id`, nothing else assumed.
func (r *Reader) LeaseWriterAuthority(ctx context.Context, id [32]byte) (appconfig.WriterAuthority, error) {
	return r.writerAuthority(ctx, id, func(snapshot) error { return nil }, nil)
}

// LeaseWriterAuthorityFor computes the fact for a deployment whose secrets came by a relay release: the current lease of
// `id`, which must be held by `runner` (the lease holder the release was authorized for), never a later holder's.
func (r *Reader) LeaseWriterAuthorityFor(ctx context.Context, id, runner [32]byte) (appconfig.WriterAuthority, error) {
	return r.writerAuthority(ctx, id, func(s snapshot) error {
		if s.row.runner != runner {
			return authErr("runner_mismatch", false, "the current lease is held by another runner than the release's")
		}
		return nil
	}, nil)
}

// WhenFinal waits (bounded) while the fact is only not available YET (the claim finalizing, a search in progress, a
// quorum briefly unavailable). A non-retryable answer, or the window ending, is the error.
func WhenFinal(ctx context.Context, window, interval time.Duration, attempt func(context.Context) (appconfig.WriterAuthority, error)) (appconfig.WriterAuthority, error) {
	ctx, cancel := context.WithTimeout(ctx, window)
	defer cancel()
	for {
		w, err := attempt(ctx)
		var ae *AuthorityError
		if err == nil || !errors.As(err, &ae) || !ae.Retry {
			return w, err
		}
		timer := time.NewTimer(interval)
		select {
		case <-ctx.Done():
			timer.Stop()
			return w, fmt.Errorf("writer authority wait ended (%v): %w", err, ctx.Err())
		case <-timer.C:
		}
	}
}

// WriterAuthorityWhenFinal: WhenFinal for an owner-committed startup.
func (a *Authorization) WriterAuthorityWhenFinal(ctx context.Context, window, interval time.Duration) (appconfig.WriterAuthority, error) {
	return WhenFinal(ctx, window, interval, a.WriterAuthority)
}

type budget struct{ used, max int }

var winMu sync.Mutex

// window: the eth_getLogs range to ask `name` for: the one its own refusals shrank it to, else leaseWindow.
func (r *Reader) window(name string) uint64 {
	winMu.Lock()
	defer winMu.Unlock()
	if w, ok := r.win[name]; ok && w >= leaseMinWindow && w <= leaseWindow {
		return w
	}
	return leaseWindow
}
func (r *Reader) learn(name string, w uint64) {
	winMu.Lock()
	defer winMu.Unlock()
	if r.win == nil {
		r.win = map[string]uint64{}
	}
	r.win[name] = w
}

// peerLogs: one peer's lease logs for [lo, hi], split as that peer's range limit requires.
func (r *Reader) peerLogs(ctx context.Context, p endpoint, id string, lo, hi uint64, b *budget) ([]leaseLog, error) {
	var out []leaseLog
	for a := lo; a <= hi; {
		w := r.window(p.name) // a window clipped at the range's end is never learned
		if w > hi-a+1 {
			w = hi - a + 1
		}
		tries := 0
		for {
			if until, cool := r.cooling(p.name); cool {
				return nil, &coolingError{until}
			}
			if b.used >= b.max {
				return nil, errBudget
			}
			b.used++
			end := a + w - 1
			q := map[string]any{"address": r.ledger, "fromBlock": fmt.Sprintf("0x%x", a), "toBlock": fmt.Sprintf("0x%x", end),
				"topics": []any{[]string{topicClaimed, topicRenewed, topicReleased}, id}}
			var got []rpcLog
			err := p.call(ctx, "eth_getLogs", []any{q}, &got)
			if err == nil {
				norm, e := normalizeLogs(got, r.ledger, id, a, end)
				if e != nil {
					return nil, e
				}
				r.answered(p.name)
				out = append(out, norm...)
				a = end + 1
				break
			}
			m := err.Error()
			if rateRE.MatchString(m) && tries >= leaseRateRetries {
				r.rateRefused(p.name) // this source sits out its cooldown; the step goes on with the others
				return nil, err
			}
			if rateRE.MatchString(m) {
				t := time.NewTimer(leaseBackoff << tries)
				tries++
				select {
				case <-ctx.Done():
					t.Stop()
					return nil, ctx.Err()
				case <-t.C:
				}
				continue
			}
			if rangeRE.MatchString(m) && !rateRE.MatchString(m) && w > leaseMinWindow {
				if w /= 2; w < leaseMinWindow {
					w = leaseMinWindow
				}
				r.learn(p.name, w) // only this source's own refusal teaches its window
				continue
			}
			if historyRE.MatchString(m) {
				return nil, &historyError{m}
			}
			return nil, err
		}
	}
	return out, nil
}

var errBudget = errors.New("request budget spent")

type historyError struct{ m string }

func (e *historyError) Error() string { return "history unavailable: " + e.m }

// agreedLogs: every answering peer identical, at least two.
// unreached: operators of sources that could not be reached this attempt (admitHistory); they may answer later.
func (r *Reader) agreedLogs(ctx context.Context, peers []endpoint, id string, lo, hi uint64, budgets map[string]*budget, unreached map[string]bool) ([]leaseLog, error) {
	type res struct {
		logs []leaseLog
		key  string
		err  error
		op   string
	}
	// Every source's answer is awaited and inspected: two independent operators must match and ANY answering source
	// that differs refuses the step. A source only skips a step while it cools down after its own explicit rate
	// refusal (cooldown below), never because others answered first.
	results := make([]res, len(peers))
	var wg sync.WaitGroup
	for i, p := range peers {
		wg.Add(1)
		go func(i int, p endpoint) {
			defer wg.Done()
			l, e := r.peerLogs(ctx, p, id, lo, hi, budgets[p.name])
			if e != nil {
				results[i] = res{err: e, op: operatorOf(p.name)}
				return
			}
			sort.Slice(l, func(x, y int) bool {
				return l[x].block < l[y].block || l[x].block == l[y].block && l[x].index < l[y].index
			})
			k, _ := json.Marshal(logsKey(l))
			results[i] = res{l, string(k), nil, operatorOf(p.name)}
		}(i, p)
	}
	wg.Wait()
	// independent answers: distinct OPERATORS (history.go operatorOf), not merely distinct hosts
	var ok []res
	okOps, possibleOps := map[string]bool{}, map[string]bool{}
	for op := range unreached {
		possibleOps[op] = true
	}
	spent := false
	for _, x := range results {
		if x.err == nil {
			ok = append(ok, x)
			okOps[x.op], possibleOps[x.op] = true, true
			continue
		}
		if errors.Is(x.err, errBudget) {
			spent = true
		}
		var h *historyError
		if !errors.As(x.err, &h) {
			possibleOps[x.op] = true // a source that may answer later
		}
	}
	if len(okOps) < 2 {
		// each failing source's reason, bounded (provider text is already printable and <= 160 bytes): which provider
		// refused what is the operator's diagnosis
		var why []string
		for i, x := range results {
			if x.err != nil {
				m := x.err.Error()
				if len(m) > 90 {
					m = m[:90]
				}
				why = append(why, peers[i].name+": "+m)
			}
		}
		reasons := strings.Join(why, "; ")
		if len(reasons) > 600 {
			reasons = reasons[:600]
		}
		if spent {
			return nil, authErr("scanning", true, "the lease's history is being read (blocks %d-%d pending; %s)", lo, hi, reasons)
		}
		if len(possibleOps) < 2 {
			return nil, authErr("history_unavailable", false, "fewer than two independent RPCs serve the lease's logs of blocks %d-%d; log-capable RPCs are needed for a claim this old (%s)", lo, hi, reasons)
		}
		return nil, authErr("quorum_unavailable", true, "fewer than two independent RPCs returned the lease's logs of blocks %d-%d (%s)", lo, hi, reasons)
	}
	for _, x := range ok[1:] {
		if x.key != ok[0].key {
			return nil, authErr("disagree", true, "the RPCs disagree about the lease's logs in blocks %d-%d", lo, hi)
		}
	}
	return ok[0].logs, nil
}

func logsKey(l []leaseLog) []any {
	v := make([]any, 0, len(l))
	for _, x := range l {
		v = append(v, []any{x.block, x.index, x.blockHash, x.topics, x.data})
	}
	return v
}

func sortLogs(l []leaseLog) {
	sort.SliceStable(l, func(i, j int) bool {
		return l[i].block < l[j].block || l[i].block == l[j].block && l[i].index < l[j].index
	})
}

// history: an authorized startup's owner-named log sources (history.go), nil otherwise.
func (r *Reader) writerAuthority(ctx context.Context, id [32]byte, expect func(snapshot) error, history []endpoint) (appconfig.WriterAuthority, error) {
	var none appconfig.WriterAuthority
	s, e := r.read(ctx, id)
	if e != nil {
		return none, authErr("quorum_unavailable", true, "%v", e)
	}
	if e = r.leaseCurrent(s); e != nil {
		return none, authErr("lease_not_current", true, "%v", e)
	}
	if e = expect(s); e != nil {
		return none, e
	}
	n := s.row
	ctx, cancel := context.WithTimeout(ctx, leaseAttemptTimeout)
	defer cancel()
	tag := fmt.Sprintf("0x%x", s.number)
	// the peers that hold the agreed block itself, and the lowest finalized block among them
	var peers []endpoint
	finalized := s.number
	for _, p := range r.peers {
		var b, f block
		if p.call(ctx, "eth_getBlockByNumber", []any{tag, false}, &b) != nil || strings.ToLower(b.Hash) != s.hash {
			continue
		}
		if p.call(ctx, "eth_getBlockByNumber", []any{"finalized", false}, &f) != nil {
			continue
		}
		fn, err := quantity(f.Number)
		if err != nil {
			continue
		}
		if fn < finalized {
			finalized = fn
		}
		peers = append(peers, p)
	}
	if len(peers) < 2 {
		return none, authErr("quorum_unavailable", true, "fewer than two RPCs hold the agreed block %d with a finalized block", s.number)
	}
	// the LOG sources: those measured peers, and the owner's history sources anchored to the same agreed block. Finality
	// above is the measured peers' alone.
	admitted, unreached := r.admitHistory(ctx, s, history)
	sources := append(append([]endpoint(nil), peers...), admitted...)
	idHex := "0x" + hex.EncodeToString(id[:])
	budgets := map[string]*budget{}
	for _, p := range sources {
		budgets[p.name] = &budget{max: leaseMaxRequests}
	}
	cov, have := r.coverage(id)
	if have && !(cov.lo >= leaseFromBlock && cov.hi <= s.number && cov.lo <= cov.hi+1) {
		have = false
	}
	var logs []leaseLog
	lo := s.number + 1
	// coverage is saved only from complete, finalized reads, and never once the read is cancelled (ctx done)
	keepFinal := func(lo2 uint64, ls []leaseLog) {
		hi := finalized
		if hi < lo2 || ctx.Err() != nil {
			return
		}
		var f []leaseLog
		for _, l := range ls {
			if l.block <= hi {
				f = append(f, l)
			}
		}
		r.keep(id, coverage{lo2, hi, f})
	}
	hasClaim := func(ls []leaseLog) bool {
		for _, l := range ls {
			if l.topics[0] == topicClaimed {
				return true
			}
		}
		return false
	}
	if have {
		lo, logs = cov.lo, append([]leaseLog(nil), cov.logs...)
		// upward in steps, each finalized step kept: a gap longer than one attempt's budget still closes over attempts
		for a := cov.hi + 1; a <= s.number; {
			b := a + leaseWindow - 1 // one window per step: at most leaseWindow/leaseMinWindow requests
			if b > s.number {
				b = s.number
			}
			top, err := r.agreedLogs(ctx, sources, idHex, a, b, budgets, unreached)
			if err != nil {
				return none, err
			}
			logs = append(logs, top...)
			if hi := min(b, finalized); hi > cov.hi && ctx.Err() == nil {
				var f []leaseLog
				for _, l := range logs {
					if l.block <= hi {
						f = append(f, l)
					}
				}
				r.keep(id, coverage{lo, hi, f})
			}
			a = b + 1
		}
	} else {
		top := leaseFromBlock
		if s.number+1 > leaseWindow && s.number+1-leaseWindow > top {
			top = s.number + 1 - leaseWindow
		}
		got, err := r.agreedLogs(ctx, sources, idHex, top, s.number, budgets, unreached)
		if err != nil {
			return none, err
		}
		logs, lo = got, top
		if lo <= finalized && !hasClaim(logs) { // the search continues below: this complete window is kept first
			keepFinal(lo, logs)
		}
	}
	for !hasClaim(logs) {
		if lo <= leaseFromBlock {
			return none, authErr("no_claim", false, "no Claimed log for the lease since the ledger's first block %d", leaseFromBlock)
		}
		a := leaseFromBlock
		if lo > leaseWindow && lo-leaseWindow > a { // one window per step: every attempt progresses
			a = lo - leaseWindow
		}
		older, err := r.agreedLogs(ctx, sources, idHex, a, lo-1, budgets, unreached)
		if err != nil {
			return none, err
		}
		logs, lo = append(older, logs...), a
		if lo <= finalized { // each COMPLETE step is kept at once: an attempt's deadline loses only the step in flight
			sortLogs(logs)
			keepFinal(lo, logs)
		}
	}
	sortLogs(logs)
	ci := -1
	for i, l := range logs {
		if l.topics[0] == topicClaimed {
			ci = i
		}
	}
	c := logs[ci]
	if c.block <= finalized {
		keepFinal(c.block, logs[ci:]) // nothing older than the claim matters again
	}
	runner := "0x" + hex.EncodeToString(n.runner[:])
	if len(c.topics) != 4 || c.topics[2] != runner || c.topics[3] != "0x"+strings.Repeat("0", 24)+strings.TrimPrefix(n.operator, "0x") {
		return none, authErr("inconsistent_logs", true, "the last claim does not name the lease's runner and operator")
	}
	until, err := logLeaseUntil(c.data)
	if err != nil {
		return none, authErr("bad_answer", true, "%v", err)
	}
	for _, l := range logs[ci+1:] {
		switch l.topics[0] {
		case topicReleased:
			return none, authErr("inconsistent_logs", true, "the lease was released after its last claim")
		case topicRenewed:
			if len(l.topics) != 3 || l.topics[2] != runner {
				return none, authErr("inconsistent_logs", true, "a renewal names another runner")
			}
			if until, err = logLeaseUntil(l.data); err != nil {
				return none, authErr("bad_answer", true, "%v", err)
			}
		}
	}
	if until != n.leaseUntil {
		return none, authErr("inconsistent_logs", true, "the claim and its renewals do not replay to the row's leaseUntil")
	}
	if c.block > finalized && !(have && c.block <= cov.hi) {
		return none, authErr("claim_not_final", true, "the lease's claim (block %d) is not finalized yet (finalized %d; Base is typically 15-30 minutes behind)", c.block, finalized)
	}
	// the claim's block: the same canonical hash from >= 2 independent sources, and none saying otherwise
	canonical := map[string]bool{}
	for _, p := range sources {
		var b block
		if p.call(ctx, "eth_getBlockByNumber", []any{fmt.Sprintf("0x%x", c.block), false}, &b) != nil {
			continue
		}
		if strings.ToLower(b.Hash) != c.blockHash {
			return none, authErr("disagree", true, "the claim's block is not canonical on %s", p.name)
		}
		canonical[operatorOf(p.name)] = true
	}
	if len(canonical) < 2 {
		return none, authErr("quorum_unavailable", true, "fewer than two independent RPCs confirmed the claim's block")
	}
	w := appconfig.WriterAuthority{Source: "lease16", ChainID: r.chainID, Ledger: r.ledger, Deployment: idHex, ClaimBlock: c.block, ClaimLogIndex: c.index}
	if e := w.Validate(); e != nil {
		return none, authErr("out_of_range", false, "%v", e)
	}
	return w, nil
}

func normalizeLogs(in []rpcLog, ledger, id string, lo, hi uint64) ([]leaseLog, error) {
	out := make([]leaseLog, 0, len(in))
	for _, l := range in {
		b, e1 := quantity(l.BlockNumber)
		i, e2 := quantity(l.LogIndex)
		if e1 != nil || e2 != nil || l.Removed || strings.ToLower(l.Address) != ledger || b < lo || b > hi || len(l.Topics) < 2 || strings.ToLower(l.Topics[1]) != id {
			return nil, errors.New("a log outside the query")
		}
		t := make([]string, len(l.Topics))
		for k, v := range l.Topics {
			t[k] = strings.ToLower(v)
		}
		out = append(out, leaseLog{block: b, index: i, blockHash: strings.ToLower(l.BlockHash), topics: t, data: strings.ToLower(l.Data)})
	}
	return out, nil
}

func logLeaseUntil(data string) (uint64, error) {
	b, err := hex.DecodeString(strings.TrimPrefix(data, "0x"))
	if err != nil || len(b) < 32 {
		return 0, errors.New("a lease log's data is malformed")
	}
	return wordUint(b[:32], 64)
}
