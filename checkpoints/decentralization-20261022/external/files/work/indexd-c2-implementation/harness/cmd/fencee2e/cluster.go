// Cluster plumbing for fencee2e, copied from cmd/harness/main.go (the U1 harness, unchanged; sha256 recorded in
// work/claude-indexd-fencing-implementation-result.md): the testing.TB shim, the holding proxy, indexer slots and
// the cluster setup. Only the package clause differs; the control API and main are not copied.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
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
