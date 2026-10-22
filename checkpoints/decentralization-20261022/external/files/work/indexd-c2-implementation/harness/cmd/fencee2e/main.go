// Command fencee2e checks the indexd-fence writer fence and commit-ordered sequence listing end to end: REAL
// indexd-fence indexers (work/storage-real-indexd/indexd-fence via go.fence.mod; app/admin HTTP APIs, managers and
// the PostgreSQL store, one durable database per indexer) behind holding proxies, real RHP4 fixture hosts holding
// the sectors, and a fixture chain, all on loopback (see cluster.go for what is real and what is fixture).
//
// The DRIVER here is Go: several writer processes are simulated with indexd-fence's own app client (WithFence)
// sharing one app key, as the replicas of one deployment do. It is NOT the sia-s3/SDK candidate; it exercises the
// server side of the protocol (interface v3 + REVISIONS R1-R4) under delayed delivery, contention, cold recovery,
// an outage with restart on the durable database, and a membership change. The quorum rule (W = 2 of 3) is the
// driver's, as in the SDK: indexd enforces only the per-replica fence.
//
// Not proven by any of this: live Sia host retention, real contract funding and renewal, real network timing.
package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/api/app"
	"go.sia.tech/indexd/persist/postgres"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"lukechampine.com/frand"
)

// ---- results ----

type check struct {
	Scenario string `json:"scenario"`
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	Detail   string `json:"detail,omitempty"`
}

type e2e struct {
	*harness
	sk     types.PrivateKey // the deployment's app key: every writer process uses it
	checks []check
	slab   slabs.SlabPinParams
	data   map[types.Hash256][32]byte // sector root -> sha256 of the uploaded bytes
	cur    string
}

func (e *e2e) check(name string, ok bool, detail string, args ...any) bool {
	c := check{Scenario: e.cur, Name: name, OK: ok, Detail: fmt.Sprintf(detail, args...)}
	e.checks = append(e.checks, c)
	e.event("check", map[string]any{"scenario": c.Scenario, "name": c.Name, "ok": c.OK, "detail": c.Detail})
	status := "PASS"
	if !ok {
		status = "FAIL"
	}
	fmt.Printf("%s  %-22s %s: %s\n", status, e.cur, name, c.Detail)
	return ok
}

// ---- writers ----

func token(gen, counter uint64, iid byte) accounts.Fence {
	var f accounts.Fence
	binary.BigEndian.PutUint64(f[:8], gen)
	binary.BigEndian.PutUint64(f[8:16], counter)
	for i := 16; i < 32; i++ {
		f[i] = iid
	}
	return f
}

// writer is one writer process: its token and the credential (receipt) it obtained on each replica.
type writer struct {
	name  string
	fence accounts.Fence
	cred  map[int]*accounts.Credential
}

func (e *e2e) client(k int, cred *accounts.Credential) *app.Client {
	c := app.NewClient(e.slots[k].proxyURL, app.WithEnableCBOR(false))
	if cred != nil {
		c = c.WithFence(cred)
	}
	return c
}

// raise raises w's fence on the given replicas; it returns the heads of the replicas that installed it.
func (e *e2e) raise(w *writer, replicas ...int) map[int]uint64 {
	heads := map[int]uint64{}
	for _, k := range replicas {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		resp, err := e.client(k, nil).RaiseFence(ctx, e.sk, w.fence)
		cancel()
		if err != nil {
			e.event("raise", map[string]any{"writer": w.name, "replica": k, "error": err.Error()})
			continue
		}
		c := resp.Credential()
		w.cred[k] = &c
		heads[k] = resp.Seq
		e.event("raise", map[string]any{"writer": w.name, "replica": k, "head": resp.Seq})
	}
	return heads
}

// fencedOutcome classifies a mutation result: "ok", "fenced:<writer>" / "fenced:null", or "error:<...>".
func (e *e2e) outcome(err error, names map[accounts.Fence]string) string {
	if err == nil {
		return "ok"
	}
	var he *app.HTTPError
	if errors.As(err, &he) && he.StatusCode == http.StatusConflict {
		var body struct {
			Fence *accounts.Fence `json:"fence"`
		}
		if json.Unmarshal([]byte(he.Body), &body) == nil {
			if body.Fence == nil {
				return "fenced:null"
			}
			if n, ok := names[*body.Fence]; ok {
				return "fenced:" + n
			}
			return "fenced:" + body.Fence.String()
		}
	}
	msg := err.Error()
	if i := strings.Index(msg, "?"); i >= 0 { // never record a signed query (sc/ss/sf)
		if j := strings.IndexAny(msg[i:], "\" "); j >= 0 {
			msg = msg[:i] + "?<redacted>" + msg[i+j:]
		} else {
			msg = msg[:i] + "?<redacted>"
		}
	}
	return "error:" + msg[:min(len(msg), 160)]
}

// mutate runs fn against each replica with w's credential there and returns the outcome per replica.
func (e *e2e) mutate(w *writer, replicas []int, names map[accounts.Fence]string, fn func(ctx context.Context, c *app.Client) error) map[int]string {
	out := map[int]string{}
	for _, k := range replicas {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		var cred *accounts.Credential
		if w != nil {
			cred = w.cred[k]
		}
		out[k] = e.outcome(fn(ctx, e.client(k, cred)), names)
		cancel()
	}
	return out
}

func acks(out map[int]string) (n int) {
	for _, o := range out {
		if o == "ok" {
			n++
		}
	}
	return
}

func allEqual(out map[int]string, want string) bool {
	for _, o := range out {
		if o != want {
			return false
		}
	}
	return len(out) > 0
}

// state is a replica's object state reconstructed from its sequence listing: key -> metadata digest ("" deleted).
type state map[types.Hash256]string

func (e *e2e) listSeq(k int) (uint64, state, []slabs.SeqObjectEvent, error) {
	c := e.client(k, nil)
	st := state{}
	var all []slabs.SeqObjectEvent
	var after, head uint64
	for i := 0; ; i++ {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		page, err := c.ListObjectsSeq(ctx, e.sk, after, 3) // small pages on purpose
		cancel()
		if err != nil {
			return 0, nil, nil, err
		}
		if i == 0 {
			head = page.Head
		}
		if len(page.Events) == 0 {
			break
		}
		for _, ev := range page.Events {
			switch {
			case ev.Blocked:
				st[ev.Key] = "BLOCKED"
			case ev.Deleted:
				st[ev.Key] = ""
			default:
				h := sha256.Sum256(ev.Object.EncryptedMetadata)
				st[ev.Key] = fmt.Sprintf("%x", h[:6])
			}
		}
		all = append(all, page.Events...)
		after = page.Events[len(page.Events)-1].Seq
	}
	return head, st, all, nil
}

func (s state) live() []string {
	var out []string
	for k, v := range s {
		if v != "" {
			out = append(out, k.String()[:8])
		}
	}
	sort.Strings(out)
	return out
}

func (s state) String() string {
	var out []string
	for k, v := range s {
		if v == "" {
			v = "deleted"
		}
		out = append(out, k.String()[:8]+"="+v)
	}
	sort.Strings(out)
	return strings.Join(out, ",")
}

// ---- data ----

// register adds the app key to replica k's account store, funds it and waits for the pools on every host.
func (e *e2e) register(k int) {
	s := e.slots[k]
	s.idx.Store().AddTestAccount(s.life, e.sk.PublicKey())
	if err := s.idx.Contracts().TriggerAccountFunding(); err != nil {
		panic(err)
	}
	attached := 0
	for _, host := range e.hosts {
		for i := 0; i < 300; i++ {
			ok, err := s.idx.Store().PoolAttached(context.Background(), e.sk.PublicKey(), host.PublicKey())
			if err != nil {
				panic(err)
			} else if ok {
				attached++
				break
			}
			if i%25 == 24 {
				e.cn.MineBlocks(e.root, types.VoidAddress, 1)
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	e.event("account-registered", map[string]any{"indexer": s.name, "attachedHosts": attached})
}

// uploadSlab writes 12 random sectors (3-of-12, the smallest layout indexd accepts) to 12 hosts with real RHP4.
func (e *e2e) uploadSlab() {
	e.slab = slabs.SlabPinParams{EncryptionKey: frand.Entropy256(), MinShards: 3}
	e.data = map[types.Hash256][32]byte{}
	sector := make([]byte, proto.SectorSize)
	for i := 0; i < 12; i++ {
		hk := e.hosts[i].PublicKey()
		frand.Read(sector)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		res, err := e.slots[0].idx.Client().WriteSector(ctx, e.sk, hk, sector)
		cancel()
		if err != nil {
			panic(fmt.Sprintf("write sector to host %d: %v", i, err))
		}
		now := time.Now()
		e.slab.Sectors = append(e.slab.Sectors, slabs.PinnedSector{Root: res.Root, HostKey: hk, UploadedAt: &now})
		e.data[res.Root] = sha256.Sum256(sector)
	}
	e.event("slab-uploaded", map[string]any{"sectors": len(e.slab.Sectors)})
}

// readBack downloads every sector of the slab from its host and compares it with what was uploaded.
func (e *e2e) readBack() (ok int, detail string) {
	for _, s := range e.slab.Sectors {
		var buf bytes.Buffer
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		_, err := e.slots[0].idx.Client().ReadSector(ctx, proto.NewAccountToken(e.sk, s.HostKey), s.Root, &buf, 0, proto.SectorSize)
		cancel()
		if err != nil {
			detail += fmt.Sprintf(" %s:%v", s.HostKey.String()[:16], err)
			continue
		}
		if sha256.Sum256(buf.Bytes()) == e.data[s.Root] {
			ok++
		} else {
			detail += " mismatch"
		}
	}
	return
}

// object returns the i-th object of the slab (distinct key per slice), metadata tagged so versions differ.
func (e *e2e) object(i int, tag string) slabs.SealedObject {
	o := slabs.SealedObject{
		EncryptedDataKey:     frand.Bytes(72),
		EncryptedMetadataKey: frand.Bytes(72),
		EncryptedMetadata:    []byte(fmt.Sprintf("object %d %s %x", i, tag, frand.Bytes(4))),
		Slabs:                []slabs.SlabSlice{e.slab.Slice(uint32(i)*4096, 4096)},
	}
	o.Sign(e.sk)
	return o
}

func meta(o slabs.SealedObject) string {
	h := sha256.Sum256(o.EncryptedMetadata)
	return fmt.Sprintf("%x", h[:6])
}

func id(o slabs.SealedObject) types.Hash256 { return o.ID() }

// ---- scenarios ----

func (e *e2e) run() {
	const g = 17<<48 | 1 // lease17 generation 1 (interface v3 section 5): every writer below holds the same lease
	A := &writer{name: "A", fence: token(g, 1, 0xa0), cred: map[int]*accounts.Credential{}}
	B := &writer{name: "B", fence: token(g, 2, 0xb0), cred: map[int]*accounts.Credential{}}
	C := &writer{name: "C", fence: token(g, 3, 0xc0), cred: map[int]*accounts.Credential{}}
	D := &writer{name: "D", fence: token(g, 4, 0xd0), cred: map[int]*accounts.Credential{}}
	names := map[accounts.Fence]string{A.fence: "A", B.fence: "B", C.fence: "C", D.fence: "D"}
	voters := []int{0, 1, 2}
	o := map[int]slabs.SealedObject{} // built after the slab upload (S0): an object is a slice of that slab
	pinSlab := func(ctx context.Context, c *app.Client) error {
		_, err := c.PinSlabs(ctx, e.sk, e.slab)
		return err
	}
	pin := func(obj slabs.SealedObject) func(context.Context, *app.Client) error {
		return func(ctx context.Context, c *app.Client) error { return c.PinObject(ctx, e.sk, obj) }
	}
	del := func(obj slabs.SealedObject) func(context.Context, *app.Client) error {
		return func(ctx context.Context, c *app.Client) error { return c.DeleteObject(ctx, e.sk, obj.ID()) }
	}

	// S0: A boots on a fresh account (unfenced: stock objects first, then the first raise backfills them)
	e.cur = "S0-first-raise"
	for _, k := range voters {
		e.register(k)
	}
	e.uploadSlab()
	for i := 0; i < 10; i++ {
		o[i] = e.object(i, "v1")
	}
	out := e.mutate(nil, voters, names, pinSlab)
	e.check("stock-pin-slab", allEqual(out, "ok"), "%v", out)
	out = e.mutate(nil, voters, names, pin(o[0]))
	e.check("stock-pin-object", allEqual(out, "ok"), "%v", out)
	heads := e.raise(A, voters...)
	e.check("A-installs-everywhere", len(heads) == 3, "heads %v", heads)
	e.check("backfill-head", heads[0] == 1 && heads[1] == 1 && heads[2] == 1, "heads %v (one stock event each)", heads)
	out = e.mutate(nil, voters, names, pin(o[9]))
	e.check("stock-writer-now-refused", allEqual(out, "fenced:A"), "%v", out)

	// S1: A writes and deletes (acknowledged on all), then a DELAYED A request is delivered after B's raise
	e.cur = "S1-delayed-old-writer"
	out = e.mutate(A, voters, names, pin(o[1]))
	e.check("A-pin-o1", allEqual(out, "ok"), "%v", out)
	out = e.mutate(A, voters, names, pin(o[2]))
	e.check("A-pin-o2", allEqual(out, "ok"), "%v", out)
	out = e.mutate(A, voters, names, del(o[0]))
	e.check("A-delete-o0", allEqual(out, "ok"), "%v", out)
	for _, k := range voters {
		p := e.slots[k].proxy
		p.mu.Lock()
		p.method, p.prefix, p.holdNext = http.MethodDelete, "/objects/", 1
		p.mu.Unlock()
	}
	for _, k := range voters {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := e.client(k, A.cred[k]).DeleteObject(ctx, e.sk, id(o[1]))
		cancel()
		e.event("held-request", map[string]any{"replica": k, "client": fmt.Sprint(err)})
	}
	time.Sleep(3 * time.Second) // A's DELETE o1 is now in flight at every replica, unanswered
	heads = e.raise(B, voters...)
	e.check("B-installs-everywhere", len(heads) == 3 && heads[0] == 4, "heads %v (backfill 1 + A's 3 mutations)", heads)
	var delivered []string
	allRefused := true
	for _, k := range voters {
		for _, d := range e.slots[k].proxy.release() {
			delivered = append(delivered, fmt.Sprintf("r%d %s %s -> %d %s (held %d ms)", k, d.Method, d.Path[:min(len(d.Path), 20)], d.Status, d.Body, d.HeldForMS))
			allRefused = allRefused && d.Status == http.StatusConflict && strings.Contains(d.Body, B.fence.String())
		}
	}
	e.check("late-A-delete-refused", allRefused && len(delivered) == 3, "%v", delivered)
	out = e.mutate(A, voters, names, pin(o[3]))
	e.check("A-pin-after-raise-refused", allEqual(out, "fenced:B"), "%v", out)

	// S2: B's boot listing is exactly A's acknowledged state; B then writes and deletes
	e.cur = "S2-fresh-contender"
	want := state{id(o[0]): "", id(o[1]): meta(o[1]), id(o[2]): meta(o[2])}
	for _, k := range voters {
		head, st, _, err := e.listSeq(k)
		e.check(fmt.Sprintf("r%d-boot-listing", k), err == nil && head == 4 && st.String() == want.String(), "head %d %v err %v (want %v)", head, st, err, want)
	}
	o2v2 := e.object(2, "v2")
	out = e.mutate(B, voters, names, pin(o2v2))
	e.check("B-overwrite-o2", allEqual(out, "ok"), "%v", out)
	out = e.mutate(B, voters, names, pin(o[4]))
	e.check("B-pin-o4", allEqual(out, "ok"), "%v", out)
	out = e.mutate(B, voters, names, del(o[1]))
	e.check("B-delete-o1", allEqual(out, "ok"), "%v", out)

	// S3: a cold owner process raises higher and recovers every acknowledged write and delete, data included
	e.cur = "S3-cold-recovery"
	heads = e.raise(C, voters...)
	e.check("C-installs-everywhere", len(heads) == 3 && heads[0] == 7, "heads %v", heads)
	want = state{id(o[0]): "", id(o[1]): "", id(o[2]): meta(o2v2), id(o[4]): meta(o[4])}
	var states []string
	for _, k := range voters {
		head, st, evs, err := e.listSeq(k)
		states = append(states, st.String())
		e.check(fmt.Sprintf("r%d-cold-listing", k), err == nil && head == 7 && st.String() == want.String(), "head %d events %d %v err %v", head, len(evs), st, err)
	}
	e.check("replicas-agree", states[0] == states[1] && states[1] == states[2], "%d states", len(states))
	n, detail := e.readBack()
	e.check("sectors-read-back", n == len(e.slab.Sectors), "%d/%d sectors match the uploaded bytes%s", n, len(e.slab.Sectors), detail)
	out = e.mutate(B, voters, names, pin(o[5]))
	e.check("B-refused-after-C", allEqual(out, "fenced:C"), "%v", out)

	// S4: r2 is down while D raises: D gets a quorum (2 of 3); the stale C is refused by the quorum; after r2
	// restarts on its durable database it still holds C's fence until D raises there
	e.cur = "S4-outage"
	e.stopIndexer(e.slots[2])
	e.event("indexer-stopped", map[string]any{"indexer": "r2"})
	heads = e.raise(D, voters...)
	e.check("D-installs-on-quorum", len(heads) == 2 && heads[2] == 0, "heads %v (r2 down)", heads)
	out = e.mutate(D, []int{0, 1}, names, pin(o[5]))
	e.check("D-pin-o5-quorum", allEqual(out, "ok"), "%v", out)
	out = e.mutate(C, voters, names, pin(o[6]))
	e.check("C-stale-not-acknowledged", out[0] == "fenced:D" && out[1] == "fenced:D" && strings.HasPrefix(out[2], "error:") && acks(out) == 0, "%v", out)
	e.startIndexer(e.slots[2])
	e.event("indexer-restarted", map[string]any{"indexer": "r2"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	fs, err := e.client(2, nil).Fence(ctx, e.sk)
	cancel()
	e.check("r2-durable-fence", err == nil && fs.Fence != nil && *fs.Fence == C.fence && fs.Seq == 7, "fence %v seq %d err %v", fs.Fence, fs.Seq, err)
	// the documented limit: a replica that missed the raise still accepts the stale writer, but only 1 of 3 acks
	out = e.mutate(C, voters, names, pin(o[7]))
	e.check("C-minority-write", out[2] == "ok" && acks(out) == 1, "%v (1 ack < W=2: never acknowledged to a client)", out)
	heads = e.raise(D, 2)
	e.check("D-raise-r2-after-restart", len(heads) == 1 && heads[2] == 8, "heads %v", heads)
	head, st, _, err := e.listSeq(2)
	e.check("r2-listing-shows-stray-write", err == nil && head == 8 && st[id(o[7])] == meta(o[7]), "head %d %v err %v (D must reconcile it before serving)", head, st, err)
	out = e.mutate(D, []int{2}, names, del(o[7]))
	e.check("D-repairs-r2", allEqual(out, "ok"), "%v", out)
	out = e.mutate(D, []int{2}, names, pin(o[5]))
	e.check("D-mirrors-o5-to-r2", allEqual(out, "ok"), "%v", out)
	out = e.mutate(C, voters, names, pin(o[8]))
	e.check("C-refused-everywhere", allEqual(out, "fenced:D"), "%v", out)

	// S5: membership: replica r3 joins; D installs there (no fence yet: backfill of nothing) and mirrors its state
	e.cur = "S5-membership"
	e.register(3)
	// a credential from another replica means nothing here: sf on an account without a fence is refused
	stale := &writer{name: "C@r0", cred: map[int]*accounts.Credential{3: C.cred[0]}}
	out = e.mutate(stale, []int{3}, names, pin(o[1]))
	e.check("r3-sf-before-install", out[3] == "fenced:null", "%v", out)
	heads = e.raise(D, 3)
	e.check("D-installs-on-r3", len(heads) == 1 && heads[3] == 0, "heads %v", heads)
	out = e.mutate(D, []int{3}, names, pinSlab)
	e.check("D-pins-slab-r3", allEqual(out, "ok"), "%v", out)
	for _, obj := range []slabs.SealedObject{o2v2, o[4], o[5]} {
		out = e.mutate(D, []int{3}, names, pin(obj))
		e.check("D-mirror-"+obj.ID().String()[:8], allEqual(out, "ok"), "%v", out)
	}
	_, st0, _, _ := e.listSeq(0)
	_, st3, _, err := e.listSeq(3)
	e.check("r3-live-equals-r0-live", err == nil && strings.Join(st3.live(), ",") == strings.Join(st0.live(), ","), "r0 %v r3 %v", st0.live(), st3.live())
	// the older writers, presenting the credentials they hold (issued by r0), are refused on r3
	for _, w := range []*writer{A, B, C} {
		moved := &writer{name: w.name, cred: map[int]*accounts.Credential{3: w.cred[0]}}
		out = e.mutate(moved, []int{3}, names, pin(o[9]))
		e.check(w.name+"-refused-on-r3", allEqual(out, "fenced:D"), "%v", out)
	}
	out = e.mutate(nil, []int{3}, names, pin(o[9]))
	e.check("stock-refused-on-r3", allEqual(out, "fenced:D"), "%v", out)

	// S6: two processes holding the SAME ballot raise it concurrently on the voters: each replica issues exactly one
	// receipt, so at most one process can reach W = 2
	e.cur = "S6-same-ballot-race"
	E1 := &writer{name: "E1", fence: token(g, 5, 0xe0), cred: map[int]*accounts.Credential{}}
	E2 := &writer{name: "E2", fence: E1.fence, cred: map[int]*accounts.Credential{}}
	var wg sync.WaitGroup
	var mu sync.Mutex
	for _, w := range []*writer{E1, E2} {
		for _, k := range voters {
			wg.Add(1)
			go func() {
				defer wg.Done()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				resp, err := e.client(k, nil).RaiseFence(ctx, e.sk, w.fence)
				cancel()
				if err == nil {
					c := resp.Credential()
					mu.Lock()
					w.cred[k] = &c
					mu.Unlock()
				}
			}()
		}
	}
	wg.Wait()
	e.check("one-receipt-per-replica", len(E1.cred)+len(E2.cred) == 3, "E1 %d, E2 %d receipts", len(E1.cred), len(E2.cred))
	e.check("at-most-one-quorum", !(len(E1.cred) >= 2 && len(E2.cred) >= 2), "E1 %d, E2 %d", len(E1.cred), len(E2.cred))
	o1 := e.mutate(E1, voters, names, pin(o[6]))
	o2 := e.mutate(E2, voters, names, pin(o[6]))
	e.check("writes-follow-receipts", acks(o1) == len(E1.cred) && acks(o2) == len(E2.cred), "E1 %v E2 %v", o1, o2)
}

func main() {
	dir := flag.String("dir", "", "run directory on the work disk (must not exist)")
	indexd := flag.String("indexd", "", "indexd source directory (geoip database)")
	nHosts := flag.Int("hosts", 14, "hosts")
	pgPort := flag.Int("pg-port", 5432, "PostgreSQL port (loopback)")
	pgEnv := flag.String("pg-env", "", "KEY=VALUE file with POSTGRES_USER and POSTGRES_PASSWORD (read privately, never logged)")
	runID := flag.String("run", "", "run id (database name suffix)")
	logLevel := flag.String("log-level", "info", "indexd log level")
	flag.Parse()
	if *dir == "" || *indexd == "" || *runID == "" || *pgEnv == "" {
		log.Fatal("-dir, -indexd, -run and -pg-env are required")
	}
	if err := os.Mkdir(*dir, 0o700); err != nil {
		log.Fatal(err)
	}
	var user, pass string
	b, err := os.ReadFile(*pgEnv)
	if err != nil {
		log.Fatal("pg-env: ", err)
	}
	for _, line := range strings.Split(string(b), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		switch {
		case !ok:
		case k == "POSTGRES_USER":
			user = v
		case k == "POSTGRES_PASSWORD":
			pass = v
		}
	}
	if user == "" || pass == "" {
		log.Fatal("pg-env: POSTGRES_USER or POSTGRES_PASSWORD missing")
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
	h := &harness{
		dir: *dir, indexd: *indexd, log: zap.New(zapcore.NewCore(zapcore.NewJSONEncoder(enc), zapcore.AddSync(lf), lvl)), root: newTB("root"), events: ev,
		ci:       postgres.ConnectionInfo{Host: "127.0.0.1", Port: *pgPort, User: user, Password: pass, Database: "postgres", SSLMode: "disable"},
		accounts: map[int][]types.PublicKey{},
	}
	e := &e2e{harness: h, sk: types.GeneratePrivateKey()}
	code := 0
	func() {
		defer func() {
			if p := recover(); p != nil {
				log.Printf("panic: %v\n%s", p, debug.Stack())
				fmt.Printf("PANIC in %s: %v\n", e.cur, p)
				code = 2
			}
		}()
		e.cur = "setup"
		h.setup(4, *nHosts, *runID)
		e.run()
	}()
	failed := 0
	for _, c := range e.checks {
		if !c.OK {
			failed++
		}
	}
	sum, _ := json.MarshalIndent(map[string]any{"checks": e.checks, "failed": failed, "total": len(e.checks)}, "", "  ")
	os.WriteFile(filepath.Join(*dir, "summary.json"), sum, 0o600)
	fmt.Printf("%d checks, %d failed\n", len(e.checks), failed)
	h.shutdown()
	h.dropDatabases()
	if failed > 0 && code == 0 {
		code = 1
	}
	os.Exit(code)
}
