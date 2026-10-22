// Command harness runs REAL indexd v0.6.0 indexers (the unmodified application and admin HTTP APIs, account,
// contract, slab and pin managers, and the PostgreSQL store, from work/indexd via a module replace) against
// fixture hosts and a fixture chain, all on loopback, and serves a small control API so a sia-s3 test driver can
// stop and restart an indexer on its durable database, hold requests in flight (late pins), mine blocks and run
// fixed read-only evidence queries.
//
// What is real and what is fixture:
//
//	REAL     indexd application API (signed-request auth, objects, slabs, object events feed), admin API, account,
//	         contract, host, slab, sharing, pin, subscriber and stats managers, persist/postgres with its
//	         migrations, on an actual PostgreSQL server (one database per indexer, kept across restarts).
//	         Hosts run coreutils' real RHP4 server (rhp/v4) over siamux on loopback.
//	FIXTURE  the chain (coreutils testutil V2Network, an in-memory chain manager mined on demand), host contract
//	         state (testutil.EphemeralContractor), host sector storage (rtu.DiskSectorStore: files on the work
//	         disk), indexd's explorer and host online checker (testutils mocks), and the holding proxy in front of
//	         each indexer (it forwards bytes unchanged, or holds a request to deliver it late).
//	NOT PROVEN by any of it: live Sia host retention, real contract funding and renewal, real network timing.
package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/contracts"
	"go.sia.tech/indexd/persist/postgres"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"

	"sias3realindexd/rtu"
)

// ---- a testing.TB for a long-running program ----

// tb satisfies testing.TB for indexd's test utilities outside `go test`. Failures panic (the control handler
// recovers them as HTTP 500); Cleanup functions run when the lifecycle stops (an indexer outage) or at exit.
type tb struct {
	testing.TB // nil: any method not overridden below panics, which is a harness bug
	name       string
	ctx        context.Context
	cancel     context.CancelFunc
	mu         sync.Mutex
	cleanups   []func()
	stopped    atomic.Bool
}

func newTB(name string) *tb {
	ctx, cancel := context.WithCancel(context.Background())
	return &tb{name: name, ctx: ctx, cancel: cancel}
}

func (t *tb) Helper()                   {}
func (t *tb) Name() string              { return t.name }
func (t *tb) Context() context.Context  { return t.ctx }
func (t *tb) Failed() bool              { return false }
func (t *tb) Fatal(a ...any)            { panic(fmt.Sprint(a...)) }
func (t *tb) Fatalf(f string, a ...any) { panic(fmt.Sprintf(f, a...)) }
func (t *tb) Error(a ...any)            { log.Println("ERROR", t.name, fmt.Sprint(a...)) }
func (t *tb) Errorf(f string, a ...any) { log.Printf("ERROR %s "+f, append([]any{t.name}, a...)...) }
func (t *tb) Log(a ...any)              { log.Println(t.name, fmt.Sprint(a...)) }
func (t *tb) Logf(f string, a ...any)   { log.Printf(t.name+" "+f, a...) }
func (t *tb) Stopped() bool             { return t.stopped.Load() }
func (t *tb) Cleanup(f func())          { t.mu.Lock(); t.cleanups = append(t.cleanups, f); t.mu.Unlock() }

// stop marks the lifecycle stopped (its chain-sync callbacks are skipped from now on) and runs its cleanups in
// reverse order.
func (t *tb) stop() {
	t.stopped.Store(true)
	t.mu.Lock()
	fns := t.cleanups
	t.cleanups = nil
	t.mu.Unlock()
	for i := len(fns) - 1; i >= 0; i-- {
		fns[i]()
	}
	t.cancel()
}

// ---- the holding proxy (fixture network) ----

type heldRequest struct {
	Method, Path string
	query        string
	header       http.Header
	body         []byte
	HeldAt       time.Time
}

type deliveryResult struct {
	Method, Path string
	HeldForMS    int64
	Status       int
	Body         string
}

// proxy forwards every request to the indexer's real application API unchanged (it is the indexer's advertised
// URL, because indexd signs requests over the hostname). A hold rule captures the next matching requests: the
// client gets no answer (it times out and abandons the call) and the request is delivered to indexd only on
// release, as an abandoned request a network or a slow server applies late.
type proxy struct {
	target string // host:port of the real application API

	mu       sync.Mutex
	method   string
	prefix   string
	holdNext int
	held     []heldRequest
	down     bool
	forwards int
}

func (p *proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "proxy: read body", http.StatusBadGateway)
		return
	}
	p.mu.Lock()
	if p.holdNext > 0 && r.Method == p.method && strings.HasPrefix(r.URL.Path, p.prefix) {
		p.holdNext--
		p.held = append(p.held, heldRequest{Method: r.Method, Path: r.URL.Path, query: r.URL.RawQuery, header: r.Header.Clone(), body: body, HeldAt: time.Now()})
		p.mu.Unlock()
		<-r.Context().Done() // never answered: the client abandons it
		return
	}
	down := p.down
	p.forwards++
	p.mu.Unlock()
	if down {
		// the indexer is stopped: refuse like a closed port would (hijack and close without an answer)
		if hj, ok := w.(http.Hijacker); ok {
			if c, _, err := hj.Hijack(); err == nil {
				c.Close()
				return
			}
		}
		http.Error(w, "indexer down", http.StatusBadGateway)
		return
	}
	status, hdr, resp, err := p.forward(r.Method, r.URL.Path, r.URL.RawQuery, r.Header, body)
	if err != nil {
		http.Error(w, "proxy: "+err.Error(), http.StatusBadGateway)
		return
	}
	for k, vs := range hdr {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(status)
	w.Write(resp)
}

var forwardClient = &http.Client{Timeout: 10 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (p *proxy) forward(method, path, query string, header http.Header, body []byte) (int, http.Header, []byte, error) {
	u := "http://" + p.target + path
	if query != "" {
		u += "?" + query
	}
	req, err := http.NewRequest(method, u, bytes.NewReader(body))
	if err != nil {
		return 0, nil, nil, err
	}
	for k, vs := range header {
		if strings.EqualFold(k, "Content-Length") || strings.EqualFold(k, "Connection") {
			continue
		}
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	resp, err := forwardClient.Do(req)
	if err != nil {
		return 0, nil, nil, err
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, out, err
}

func (p *proxy) release() []deliveryResult {
	p.mu.Lock()
	held := p.held
	p.held = nil
	p.mu.Unlock()
	var out []deliveryResult
	for _, h := range held {
		status, _, body, err := p.forward(h.Method, h.Path, h.query, h.header, h.body)
		d := deliveryResult{Method: h.Method, Path: h.Path, HeldForMS: time.Since(h.HeldAt).Milliseconds(), Status: status}
		if err != nil {
			d.Body = "forward error: " + err.Error()
		} else {
			d.Body = string(body[:min(len(body), 300)])
		}
		out = append(out, d)
	}
	return out
}

// ---- the cluster ----

type indexerSlot struct {
	name     string
	spec     rtu.StoreSpec
	wallet   types.PrivateKey
	appAddr  string // fixed after the first start, so a restart keeps the URL
	admAddr  string
	proxy    *proxy
	proxyURL string

	life *tb
	idx  *rtu.Indexer
}

type harness struct {
	mu       sync.Mutex // serializes every control action
	dir      string
	indexd   string
	log      *zap.Logger
	root     *tb
	cn       *rtu.ConsensusNode
	hosts    []*rtu.Host
	slots    []*indexerSlot
	ci       postgres.ConnectionInfo
	events   *os.File
	accounts map[int][]types.PublicKey
}

// event appends one line of evidence (JSON) to events.jsonl.
func (h *harness) event(kind string, fields map[string]any) {
	fields["t"] = time.Now().UTC().Format(time.RFC3339Nano)
	fields["event"] = kind
	b, _ := json.Marshal(fields)
	h.events.Write(append(b, '\n'))
}

func (h *harness) startIndexer(s *indexerSlot) {
	s.life = newTB("indexer-" + s.name)
	appAddr, admAddr := s.appAddr, s.admAddr
	if appAddr == "" {
		appAddr, admAddr = "127.0.0.1:0", "127.0.0.1:0"
	}
	ms := rtu.MaintenanceSettings
	ms.WantedContracts = uint64(len(h.hosts))
	if len(h.hosts) == 0 {
		ms.WantedContracts = 30
	}
	s.idx = rtu.NewIndexer(s.life, h.cn, h.log.Named("indexer-"+s.name),
		rtu.WithStore(s.spec), rtu.WithWalletKey(s.wallet), rtu.WithListen(appAddr, admAddr),
		rtu.WithGeoIPDir(h.indexd), rtu.WithAdvertiseURL(s.proxyURL), rtu.WithMaintenanceSettings(ms),
		// FIXTURE TUNING: indexd's test intervals run slab health and integrity checks every 500 ms, each
		// downloading whole 4 MiB sectors from every host; three indexers doing so exhausted the 640 MiB scope
		// (OOM kill, run full1). Checks and repair migrations are not under test here, so they run hourly/never.
		rtu.WithSlabOptions(slabs.WithHealthCheckInterval(time.Hour), slabs.WithIntegrityCheckIntervals(24*time.Hour, 24*time.Hour), slabs.WithMigrations(false)))
	s.appAddr = strings.TrimPrefix(s.idx.AppURL, "http://")
	s.admAddr = strings.TrimPrefix(s.idx.AdminURL, "http://")
	s.proxy.mu.Lock()
	s.proxy.target, s.proxy.down = s.appAddr, false
	s.proxy.mu.Unlock()
	for _, host := range h.hosts {
		if err := host.Connect(context.Background(), s.idx.SyncerAddr()); err != nil {
			log.Printf("host connect to %s: %v", s.name, err)
		}
	}
}

func (h *harness) stopIndexer(s *indexerSlot) {
	s.proxy.mu.Lock()
	s.proxy.down = true
	s.proxy.mu.Unlock()
	s.life.stop()
	s.idx = nil
}

// waitContracts waits until the indexer has good contracts with at least `need` hosts (an upload of 3 + 9 shards
// needs 12). Real contract formation can leave a host out for a while, so the harness runs spare hosts and mines a
// block every 10 s while it waits (formation spends confirmed outputs).
func (h *harness) waitContracts(s *indexerSlot, need int) int {
	lastMine := time.Now()
	for start := time.Now(); ; {
		if time.Since(lastMine) > 10*time.Second {
			h.cn.MineBlocks(h.root, types.VoidAddress, 1)
			lastMine = time.Now()
		}
		cs, err := s.idx.Contracts().Contracts(context.Background(), 0, math.MaxInt, contracts.WithGood(true), contracts.WithRevisable(true))
		if err != nil {
			panic(err)
		}
		unique := map[types.PublicKey]bool{}
		for _, c := range cs {
			unique[c.HostKey] = true
		}
		if len(unique) >= need {
			h.cn.MineBlocks(h.root, types.VoidAddress, 1)
			time.Sleep(time.Second)
			return len(unique)
		}
		if time.Since(start) > 3*time.Minute {
			panic(fmt.Sprintf("indexer %s formed %d of %d contracts", s.name, len(unique), need))
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (h *harness) setup(nIndexers, nHosts int, runID string) {
	h.cn = rtu.NewConsensusNode(h.root, h.log.Named("chain"))
	for k := 0; k < nIndexers; k++ {
		name := fmt.Sprintf("r%d", k)
		ln, err := net.Listen("tcp4", "127.0.0.1:0")
		if err != nil {
			panic(err)
		}
		p := &proxy{down: true}
		go http.Serve(ln, p)
		s := &indexerSlot{
			name:     name,
			spec:     rtu.StoreSpec{CI: h.ci, Database: fmt.Sprintf("sias3_real_%s_%s", runID, name)},
			wallet:   types.GeneratePrivateKey(),
			proxy:    p,
			proxyURL: "http://" + ln.Addr().String(),
		}
		h.slots = append(h.slots, s)
		h.startIndexer(s)
		h.cn.MineBlocks(h.root, s.idx.WalletAddr(), 50)
		h.event("indexer-funded", map[string]any{"indexer": name})
		h.event("indexer-started", map[string]any{"indexer": name, "database": s.spec.Database, "app": s.appAddr, "advertised": s.proxyURL})
	}
	for i := 0; i < nHosts; i++ {
		pk := types.GeneratePrivateKey()
		host := h.cn.NewHost(h.root, pk, h.log.Named(fmt.Sprintf("host-%d", i)), filepath.Join(h.dir, "hosts", strconv.Itoa(i)))
		for _, s := range h.slots {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			err := host.Connect(ctx, s.idx.SyncerAddr())
			cancel()
			if err != nil {
				panic(fmt.Sprintf("host %d syncer connect to %s: %v", i, s.name, err))
			}
		}
		h.hosts = append(h.hosts, host)
		h.event("host-created", map[string]any{"host": i, "addr": host.Addr()})
	}
	for _, host := range h.hosts {
		h.cn.MineBlocks(h.root, host.WalletAddress(), 5)
	}
	h.event("hosts-funded", map[string]any{})
	h.cn.MineBlocks(h.root, types.VoidAddress, h.cn.Network().MaturityDelay)
	h.event("funds-matured", map[string]any{})
	for _, host := range h.hosts {
		if err := host.Announce(); err != nil {
			panic(err)
		}
	}
	h.cn.MineBlocks(h.root, types.VoidAddress, 1)
	for _, s := range h.slots {
		for t0 := time.Now(); ; {
			known, err := s.idx.Store().Hosts(0, math.MaxInt)
			if err != nil {
				panic(err)
			}
			if len(known) >= len(h.hosts) {
				h.event("hosts-announced", map[string]any{"indexer": s.name, "known": len(known)})
				break
			}
			if time.Since(t0) > time.Minute {
				panic(fmt.Sprintf("indexer %s knows %d of %d hosts", s.name, len(known), len(h.hosts)))
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	for _, s := range h.slots {
		h.cn.MineBlocks(h.root, s.idx.WalletAddr(), 15)
	}
	for _, s := range h.slots {
		n := h.waitContracts(s, min(12, len(h.hosts)))
		h.event("contracts-formed", map[string]any{"indexer": s.name, "hosts": n})
	}
}

// ---- control API ----

func (h *harness) slot(r *http.Request) *indexerSlot {
	k, err := strconv.Atoi(r.URL.Query().Get("idx"))
	if err != nil || k < 0 || k >= len(h.slots) {
		panic("bad idx")
	}
	return h.slots[k]
}

// evidence queries: fixed, read-only, about the given account's rows (no free-form SQL)
var queries = map[string]string{
	"objects":            `SELECT COUNT(*) FROM objects o JOIN accounts a ON a.id = o.account_id WHERE a.public_key = $1`,
	"events":             `SELECT COUNT(*) FROM object_events e JOIN accounts a ON a.id = e.account_id WHERE a.public_key = $1`,
	"events_unpublished": `SELECT COUNT(*) FROM object_events e JOIN accounts a ON a.id = e.account_id WHERE a.public_key = $1 AND e.updated_at IS NULL`,
	"events_deleted":     `SELECT COUNT(*) FROM object_events e JOIN accounts a ON a.id = e.account_id WHERE a.public_key = $1 AND e.was_deleted`,
}

func (h *harness) handle(w http.ResponseWriter, r *http.Request) {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("control %s panicked: %v\n%s", r.URL.Path, p, debug.Stack())
			http.Error(w, fmt.Sprint(p), http.StatusInternalServerError)
		}
	}()
	h.mu.Lock()
	defer h.mu.Unlock()
	q := r.URL.Query()
	reply := map[string]any{}
	switch r.URL.Path {
	case "/manifest":
		var idx []map[string]any
		for _, s := range h.slots {
			idx = append(idx, map[string]any{"name": s.name, "url": s.proxyURL, "database": s.spec.Database, "up": s.idx != nil})
		}
		reply["indexers"], reply["hosts"] = idx, len(h.hosts)
	case "/register":
		s := h.slot(r)
		var pk types.PublicKey
		if err := pk.UnmarshalText([]byte(q.Get("pk"))); err != nil {
			raw, err2 := hex.DecodeString(q.Get("pk"))
			if err2 != nil || len(raw) != 32 {
				panic(fmt.Sprintf("bad pk: %v", err))
			}
			copy(pk[:], raw)
		}
		s.idx.Store().AddTestAccount(s.life, pk)
		if err := s.idx.Contracts().TriggerAccountFunding(); err != nil {
			panic(err)
		}
		attached := 0
		for _, host := range h.hosts {
			for i := 0; i < 300; i++ {
				ok, err := s.idx.Store().PoolAttached(context.Background(), pk, host.PublicKey())
				if err != nil {
					panic(err)
				} else if ok {
					attached++
					break
				}
				if i%25 == 24 {
					h.cn.MineBlocks(h.root, types.VoidAddress, 1)
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		h.accounts[indexOf(h.slots, s)] = append(h.accounts[indexOf(h.slots, s)], pk)
		reply["attachedHosts"] = attached
		h.event("account-registered", map[string]any{"indexer": s.name, "account": pk.String(), "attachedHosts": attached})
	case "/stop":
		s := h.slot(r)
		h.stopIndexer(s)
		h.event("indexer-stopped", map[string]any{"indexer": s.name})
	case "/start":
		s := h.slot(r)
		h.startIndexer(s)
		h.event("indexer-restarted", map[string]any{"indexer": s.name, "app": s.appAddr, "database": s.spec.Database})
	case "/mine":
		n, _ := strconv.Atoi(q.Get("n"))
		h.cn.MineBlocks(h.root, types.VoidAddress, uint64(max(n, 1)))
	case "/hold":
		s := h.slot(r)
		n, _ := strconv.Atoi(q.Get("n"))
		s.proxy.mu.Lock()
		s.proxy.method, s.proxy.prefix, s.proxy.holdNext = q.Get("method"), q.Get("path"), max(n, 1)
		s.proxy.mu.Unlock()
		h.event("hold", map[string]any{"indexer": s.name, "method": q.Get("method"), "path": q.Get("path"), "n": max(n, 1)})
	case "/held":
		s := h.slot(r)
		s.proxy.mu.Lock()
		reply["held"] = len(s.proxy.held)
		s.proxy.mu.Unlock()
	case "/release":
		s := h.slot(r)
		res := s.proxy.release()
		reply["delivered"] = res
		h.event("release", map[string]any{"indexer": s.name, "delivered": res})
	case "/stall-publish":
		// FIXTURE: indexd stalls object-event publication while its last published second is ahead of the database
		// clock (persist/postgres/objects.go publishObjectEvents). Setting it ahead by N seconds holds every new
		// event unpublished for N seconds, deterministically: the window a listing can miss acknowledged pins.
		s := h.slot(r)
		n, _ := strconv.Atoi(q.Get("seconds"))
		if _, err := s.idx.Store().Exec(context.Background(), `UPDATE global_settings SET object_events_last_published = date_trunc('second', NOW()) + make_interval(secs => $1)`, max(n, 1)); err != nil {
			panic(err)
		}
		h.event("stall-publish", map[string]any{"indexer": s.name, "seconds": max(n, 1)})
	case "/resume-publish":
		s := h.slot(r)
		if _, err := s.idx.Store().Exec(context.Background(), `UPDATE global_settings SET object_events_last_published = date_trunc('second', NOW()) - interval '1 second'`); err != nil {
			panic(err)
		}
		h.event("resume-publish", map[string]any{"indexer": s.name})
	case "/block-object", "/unblock-object":
		// TEST CONTROL (sia-s3 blocked-listing driver, PATCH U1-B): the indexer operator blocks (or unblocks) one
		// object key through indexd's REAL admin API (PUT/DELETE /objects/blocklist/:key), as a takedown would
		s := h.slot(r)
		var key types.Hash256
		if err := key.UnmarshalText([]byte(q.Get("key"))); err != nil {
			panic("bad key")
		}
		var err error
		if r.URL.Path == "/block-object" {
			err = s.idx.Admin.ObjectBlocklistAdd(context.Background(), key, "sia-s3 blocked-listing driver")
		} else {
			err = s.idx.Admin.ObjectBlocklistRemove(context.Background(), key)
		}
		if err != nil {
			panic(err)
		}
		reply["key"] = key.String()
		h.event(strings.TrimPrefix(r.URL.Path, "/"), map[string]any{"indexer": s.name, "key": key.String()})
	case "/evidence":
		// READ-ONLY EVIDENCE (indexd replica rollout, worker 6b7af721): per running indexer and per account registered
		// on it, straight from that indexer's database: its object keys (with blocked flags), its whole blocklist,
		// the installed fence, the event-seq head and event counts. No mutation; no credential in the reply.
		out := map[string]any{}
		for k, s := range h.slots {
			if s.idx == nil {
				out[s.name] = "down"
				continue
			}
			per := map[string]any{}
			var blocked []string
			rows, err := s.idx.Store().Query(context.Background(), `SELECT encode(object_key, 'hex') FROM blocked_objects ORDER BY 1`)
			if err != nil {
				panic(err)
			}
			for rows.Next() {
				var x string
				rows.Scan(&x)
				blocked = append(blocked, x)
			}
			rows.Close()
			per["blocklist"] = blocked
			accts := map[string]any{}
			for _, pk := range h.accounts[k] {
				var objs []string
				rows, err := s.idx.Store().Query(context.Background(), `SELECT encode(o.object_key, 'hex') || CASE WHEN EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key) THEN ':blocked' ELSE '' END
					FROM objects o JOIN accounts a ON a.id = o.account_id WHERE a.public_key = $1 ORDER BY 1`, pk[:])
				if err != nil {
					panic(err)
				}
				for rows.Next() {
					var x string
					rows.Scan(&x)
					objs = append(objs, x)
				}
				rows.Close()
				var fence *string
				var seq, events, deleted int64
				if err := s.idx.Store().QueryRow(context.Background(), `SELECT encode(a.fence, 'hex'), a.event_seq,
					(SELECT COUNT(*) FROM object_events e WHERE e.account_id = a.id), (SELECT COUNT(*) FROM object_events e WHERE e.account_id = a.id AND e.was_deleted)
					FROM accounts a WHERE a.public_key = $1`, pk[:]).Scan(&fence, &seq, &events, &deleted); err != nil {
					panic(err)
				}
				accts[pk.String()] = map[string]any{"objects": objs, "fence": fence, "eventSeq": seq, "events": events, "deletedEvents": deleted}
			}
			per["accounts"] = accts
			out[s.name] = per
		}
		reply["evidence"] = out
		h.event("evidence", map[string]any{"evidence": out})
	case "/query":
		s := h.slot(r)
		sql, ok := queries[q.Get("q")]
		if !ok {
			panic("unknown query")
		}
		var pk types.PublicKey
		if err := pk.UnmarshalText([]byte(q.Get("pk"))); err != nil {
			raw, _ := hex.DecodeString(q.Get("pk"))
			copy(pk[:], raw)
		}
		var n int64
		if err := s.idx.Store().QueryRow(context.Background(), sql, pk[:]).Scan(&n); err != nil {
			panic(err)
		}
		reply["count"] = n
		h.event("query", map[string]any{"indexer": s.name, "query": q.Get("q"), "count": n})
	case "/exit":
		reply["exiting"] = true
		drop := q.Get("drop") == "1"
		go func() {
			time.Sleep(200 * time.Millisecond)
			h.shutdown()
			if drop {
				h.dropDatabases()
			}
			os.Exit(0)
		}()
	default:
		http.NotFound(w, r)
		return
	}
	json.NewEncoder(w).Encode(reply)
}

func indexOf(s []*indexerSlot, x *indexerSlot) int {
	for i, v := range s {
		if v == x {
			return i
		}
	}
	return -1
}

// dropDatabases removes this run's own databases (sias3_real_<run>_*) and nothing else, after the evidence has
// been written (events.jsonl, harness.log).
func (h *harness) dropDatabases() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	conn, err := pgx.Connect(ctx, h.ci.String())
	if err != nil {
		log.Printf("drop databases: %v", err)
		return
	}
	defer conn.Close(ctx)
	for _, s := range h.slots {
		if !strings.HasPrefix(s.spec.Database, "sias3_real_") {
			continue
		}
		_, err := conn.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %q WITH (FORCE)", s.spec.Database))
		h.event("database-dropped", map[string]any{"database": s.spec.Database, "error": fmt.Sprint(err)})
	}
}

func (h *harness) shutdown() {
	for _, s := range h.slots {
		if s.idx != nil {
			h.stopIndexer(s)
		}
	}
	h.root.stop()
	h.event("shutdown", map[string]any{})
}

func main() {
	dir := flag.String("dir", "", "run directory on the work disk (must not exist)")
	indexd := flag.String("indexd", "", "indexd source directory (geoip database)")
	nIdx := flag.Int("indexers", 3, "indexers")
	nHosts := flag.Int("hosts", 12, "hosts (sia-s3 tests use 3+9 shards)")
	pgHost := flag.String("pg-host", "127.0.0.1", "PostgreSQL host (loopback)")
	pgPort := flag.Int("pg-port", 5432, "PostgreSQL port")
	pgUser := flag.String("pg-user", "", "PostgreSQL user")
	pgPassFile := flag.String("pg-password-file", "", "file holding the PostgreSQL password (generated, disposable)")
	pgEnv := flag.String("pg-env", "", "KEY=VALUE file with POSTGRES_USER and POSTGRES_PASSWORD (read privately, never logged)")
	runID := flag.String("run", "", "run id (database name suffix)")
	logLevel := flag.String("log-level", "info", "indexd log level (debug, info, warn)")
	listOwn := flag.Bool("list-own", false, "only list databases named sias3_real_* (cleanup evidence) and exit")
	dropOnly := flag.Bool("drop-only", false, "only drop this run's databases (sias3_real_<run>_r0..) and exit (cleanup after a failed run)")
	flag.Parse()
	if *dir == "" || *indexd == "" || *runID == "" {
		log.Fatal("-dir, -indexd and -run are required")
	}
	if *pgHost != "127.0.0.1" && *pgHost != "localhost" && *pgHost != "::1" {
		log.Fatal("PostgreSQL must be on loopback")
	}
	if !*dropOnly {
		if err := os.Mkdir(*dir, 0o700); err != nil {
			log.Fatal(err)
		}
	}
	pass := ""
	if *pgPassFile != "" {
		b, err := os.ReadFile(*pgPassFile)
		if err != nil {
			log.Fatal(err)
		}
		pass = strings.TrimSpace(string(b))
	}
	if *pgEnv != "" {
		b, err := os.ReadFile(*pgEnv)
		if err != nil {
			log.Fatal("pg-env: ", err)
		}
		for _, line := range strings.Split(string(b), "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
			if !ok {
				continue
			}
			switch k {
			case "POSTGRES_USER":
				*pgUser = v
			case "POSTGRES_PASSWORD":
				pass = v
			}
		}
		if *pgUser == "" || pass == "" {
			log.Fatal("pg-env: POSTGRES_USER or POSTGRES_PASSWORD missing")
		}
	}
	if *listOwn {
		ci := postgres.ConnectionInfo{Host: *pgHost, Port: *pgPort, User: *pgUser, Password: pass, Database: "postgres", SSLMode: "disable"}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, ci.String())
		if err != nil {
			log.Fatal("list-own: connect failed")
		}
		rows, err := conn.Query(ctx, `SELECT datname FROM pg_database WHERE datname LIKE 'sias3\_real\_%' ORDER BY datname`)
		if err != nil {
			log.Fatal("list-own: query failed")
		}
		n := 0
		for rows.Next() {
			var name string
			rows.Scan(&name)
			fmt.Println("own database:", name)
			n++
		}
		fmt.Printf("%d own databases\n", n)
		conn.Close(ctx)
		return
	}
	if *dropOnly {
		ci := postgres.ConnectionInfo{Host: *pgHost, Port: *pgPort, User: *pgUser, Password: pass, Database: "postgres", SSLMode: "disable"}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		conn, err := pgx.Connect(ctx, ci.String())
		if err != nil {
			log.Fatal("drop-only: connect failed")
		}
		for k := 0; k < *nIdx; k++ {
			db := fmt.Sprintf("sias3_real_%s_r%d", *runID, k)
			_, err := conn.Exec(ctx, fmt.Sprintf("DROP DATABASE IF EXISTS %q WITH (FORCE)", db))
			fmt.Printf("dropped %s: %v\n", db, err)
		}
		conn.Close(ctx)
		return
	}
	lf, err := os.Create(filepath.Join(*dir, "harness.log"))
	if err != nil {
		log.Fatal(err)
	}
	log.SetOutput(lf)
	ev, err := os.Create(filepath.Join(*dir, "events.jsonl"))
	if err != nil {
		log.Fatal(err)
	}
	enc := zap.NewProductionEncoderConfig()
	enc.EncodeTime = zapcore.ISO8601TimeEncoder
	lvl, err := zapcore.ParseLevel(*logLevel)
	if err != nil {
		log.Fatal(err)
	}
	core := zapcore.NewCore(zapcore.NewJSONEncoder(enc), zapcore.AddSync(lf), lvl)

	h := &harness{
		dir: *dir, indexd: *indexd, log: zap.New(core), root: newTB("root"), events: ev,
		ci:       postgres.ConnectionInfo{Host: *pgHost, Port: *pgPort, User: *pgUser, Password: pass, Database: "postgres", SSLMode: "disable"},
		accounts: map[int][]types.PublicKey{},
	}
	func() {
		defer func() {
			if p := recover(); p != nil {
				log.Printf("setup failed: %v\n%s", p, debug.Stack())
				fmt.Fprintf(os.Stderr, "setup failed: %v\n", p)
				os.Exit(1)
			}
		}()
		h.setup(*nIdx, *nHosts, *runID)
	}()
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	ctl := "http://" + ln.Addr().String()
	if err := os.WriteFile(filepath.Join(*dir, "ctl.url"), []byte(ctl), 0o600); err != nil {
		log.Fatal(err)
	}
	h.event("ready", map[string]any{"ctl": ctl})
	fmt.Println(ctl)
	if err := http.Serve(ln, http.HandlerFunc(h.handle)); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
