package bootstrap

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// The checkpoint transport's consumer and producer (checkpoint_transport.go, checkpoint_producer.go) without a chain:
// a producing guest's verified coverage, its real endpoint, untrusted carriers and mirrors, and consumers loading the
// owner-committed mirrors through a client that refuses every host the guest has not admitted.

type cpWorld struct {
	t           *testing.T
	s           *synthAMD
	id          [32]byte
	idHex       string
	measurement [48]byte
	claim       leaseLog
	renew       leaseLog
}

func newCPWorld(t *testing.T) *cpWorld {
	w := &cpWorld{t: t, s: newSynthAMD(t), id: [32]byte{0x0d, 0xe9}, measurement: [48]byte{0xab, 0xcd}}
	w.idHex = "0x" + hex.EncodeToString(w.id[:])
	w.claim = leaseLog{block: 120, index: 3, blockHash: "0x" + strings.Repeat("44", 32), topics: []string{topicClaimed, w.idHex, "0x" + strings.Repeat("22", 32), "0x" + strings.Repeat("0", 24) + strings.Repeat("33", 20)}, data: "0x" + strings.Repeat("0", 128)}
	w.renew = leaseLog{block: 900, index: 0, blockHash: "0x" + strings.Repeat("55", 32), topics: []string{topicRenewed, w.idHex, "0x" + strings.Repeat("22", 32)}, data: "0x" + strings.Repeat("0", 128)}
	from := leaseFromBlock
	leaseFromBlock = 1
	t.Cleanup(func() { leaseFromBlock = from })
	return w
}

func (w *cpWorld) reader() *Reader {
	return &Reader{chainID: 8453, ledger: "0x" + strings.Repeat("ab", 20), now: time.Now}
}

// signer: the producing guest's report source (the PSP over the REPORT_DATA it is given) for a build and deployment.
func (w *cpWorld) signer(m [48]byte, host [32]byte, calls *int) func([]byte) ([]byte, []byte, error) {
	return func(rd []byte) ([]byte, []byte, error) {
		if calls != nil {
			*calls++
		}
		var r64 [64]byte
		copy(r64[:], rd)
		return w.s.report(w.s.fields(r64, m, host), w.s.vcekKey), auxblob(w.s.vcek.Raw, w.s.ask.Raw, w.s.ark.Raw), nil
	}
}

// envelope: what a producer serves for coverage [lo, hi] (its evidence over that statement), with crl attached by a carrier.
func (w *cpWorld) envelope(lo, hi uint64, logs []leaseLog, m [48]byte, host [32]byte, crl []byte) []byte {
	r := w.reader()
	r.keep(w.id, coverage{lo, hi, logs})
	st, err := r.CheckpointStatement(w.id)
	if err != nil {
		w.t.Fatal(err)
	}
	rd := CheckpointReportData(st)
	rep, certs, _ := w.signer(m, host, nil)(rd[:])
	b, err := EncodeCheckpoint(st, rep, certs, crl)
	if err != nil {
		w.t.Fatal(err)
	}
	return b
}

func (w *cpWorld) fresh() []byte { return w.s.freshCRL(w.t) }
func (w *cpWorld) stale() []byte {
	return w.s.crl(w.t, nil, time.Now().Add(-48*time.Hour), time.Now().Add(-time.Hour), w.s.arkKey)
}

// consumer: a fresh guest whose package commits mirrors; its client reaches only admitted hosts, all served by srv
// (the requested name in X-Mirror-Host). -> its authorization and the hosts it admitted.
func (w *cpWorld) consumer(srv *httptest.Server, mirrors []string) (*Authorization, *[]string) {
	var mu sync.Mutex
	admitted, allowed := &[]string{}, map[string]bool{}
	u, _ := url.Parse(srv.URL)
	client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		mu.Lock()
		ok := allowed[r.URL.Hostname()]
		mu.Unlock()
		if !ok {
			return nil, errors.New("unmeasured origin")
		}
		r = r.Clone(r.Context())
		r.Header.Set("X-Mirror-Host", r.URL.Hostname())
		r.URL.Scheme, r.URL.Host, r.Host = u.Scheme, u.Host, u.Host
		return http.DefaultTransport.RoundTrip(r)
	})}
	r := w.reader()
	r.client = *client
	r.allow = func(hp string) {
		h, _, _ := net.SplitHostPort(hp)
		mu.Lock()
		allowed[h] = true
		*admitted = append(*admitted, h)
		mu.Unlock()
	}
	a := &Authorization{reader: r, snapshot: snapshot{row: ledgerRow{id: w.id}}, valid: true, manifest: Manifest{History: &History{Checkpoints: mirrors}}}
	return a, admitted
}

// mirrorServer: host -> body (nil: 503); "redirect": a 302 to another host.
func mirrorServer(bodies map[string][]byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("X-Mirror-Host")
		b, ok := bodies[h]
		switch {
		case ok && string(b) == "redirect":
			http.Redirect(w, r, "https://elsewhere.example/cp", http.StatusFound)
		case !ok || b == nil:
			http.Error(w, "gone", http.StatusServiceUnavailable)
		default:
			w.Write(b)
		}
	}))
}

func TestCheckpointMirrorsSurviveLossAndRefuseEveryBadCopy(t *testing.T) {
	w := newCPWorld(t)
	logs := []leaseLog{w.claim, w.renew}
	good := w.envelope(120, 5000, logs, w.measurement, w.id, w.fresh())
	staleCopy := w.envelope(120, 5000, logs, w.measurement, w.id, w.stale())
	noCRL := w.envelope(120, 5000, logs, w.measurement, w.id, nil)
	// a log dropped after signing: the statement claims an absence the evidence does not bind
	var c Checkpoint
	json.Unmarshal(good, &c)
	var st checkpointStatement
	json.Unmarshal(c.Statement, &st)
	st.Logs = st.Logs[:1]
	c.Statement, _ = json.Marshal(st)
	dropped, _ := json.Marshal(c)
	otherDeployment := func() []byte { // a genuine checkpoint of another deployment (its statement and HOST_DATA)
		o := &cpWorld{t: t, s: w.s, id: [32]byte{0x77}, measurement: w.measurement}
		o.idHex = "0x" + hex.EncodeToString(o.id[:])
		cl := w.claim
		cl.topics = []string{topicClaimed, o.idHex, cl.topics[2], cl.topics[3]}
		return o.envelope(120, 5000, []leaseLog{cl}, w.measurement, o.id, w.fresh())
	}()
	otherBuild := w.envelope(120, 5000, logs, [48]byte{0xab, 0xce}, w.id, w.fresh())
	own := w.s.report(w.s.fields([64]byte{}, w.measurement, w.id), w.s.vcekKey)
	M := []string{"https://a.mirror.example/cp", "https://b.mirror.example/cp", "https://c.mirror.example/cp", "https://d.mirror.example/cp"}
	host := func(u string) string { h, _ := historyURL(u); return h }
	cases := []struct {
		name    string
		bodies  map[string][]byte
		adopted bool
		want    []string
	}{
		{"every mirror lost", map[string][]byte{}, false, []string{"a.mirror.example: unavailable: HTTP 503", "d.mirror.example: unavailable: HTTP 503"}},
		{"three lost, one good", map[string][]byte{host(M[3]): good}, true, []string{"d.mirror.example: verified"}},
		{"a dropped log refused, a good copy adopted", map[string][]byte{host(M[0]): dropped, host(M[1]): good}, true, []string{"a.mirror.example: refused: checkpoint evidence: binding", "b.mirror.example: verified"}},
		{"stale CRL only", map[string][]byte{host(M[0]): staleCopy}, false, []string{"a.mirror.example: refused: checkpoint evidence: CRL is stale"}},
		{"no CRL anywhere", map[string][]byte{host(M[0]): noCRL}, false, []string{"a.mirror.example: refused: checkpoint evidence: CRL: required but none was supplied"}},
		// the refreshed CRL another carrier brought (here on a refused, tampered copy) completes the stale copy
		{"stale copy completed by another carrier's CRL", map[string][]byte{host(M[0]): staleCopy, host(M[1]): dropped}, true, []string{"a.mirror.example: verified", "b.mirror.example: refused: checkpoint evidence: binding"}},
		{"another deployment's checkpoint", map[string][]byte{host(M[0]): otherDeployment}, false, []string{"refused: checkpoint statement names another chain, ledger or deployment"}},
		{"another build's checkpoint", map[string][]byte{host(M[0]): otherBuild}, false, []string{"refused: checkpoint evidence: measurement"}},
		{"not JSON", map[string][]byte{host(M[0]): []byte("<html>")}, false, []string{"refused: checkpoint envelope"}},
		{"a redirect is not followed", map[string][]byte{host(M[0]): []byte("redirect")}, false, []string{"a.mirror.example: unavailable: HTTP 302"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := mirrorServer(tc.bodies)
			defer srv.Close()
			a, admitted := w.consumer(srv, M)
			if len(*admitted) != 0 {
				t.Fatal("admitted before loading")
			}
			load := a.LoadCheckpoints(context.Background(), own)
			if (load.Hi == 5000) != tc.adopted || (!tc.adopted && load.Hi != 0) {
				t.Fatalf("adopted=%v: %s", tc.adopted, load)
			}
			for _, want := range tc.want {
				if !strings.Contains(load.String(), want) {
					t.Fatalf("%q missing from %s", want, load)
				}
			}
			if strings.Join(*admitted, ",") != "a.mirror.example,b.mirror.example,c.mirror.example,d.mirror.example" {
				t.Fatalf("admitted %v", *admitted)
			}
		})
	}
	t.Run("no own report: nothing is fetched or adopted", func(t *testing.T) {
		srv := mirrorServer(map[string][]byte{host(M[0]): good})
		defer srv.Close()
		a, admitted := w.consumer(srv, M)
		if load := a.LoadCheckpoints(context.Background(), []byte("not a report")); load.Hi != 0 || len(*admitted) != 0 {
			t.Fatalf("%s, admitted %v", load, *admitted)
		}
	})
	t.Run("no mirrors committed: an older package", func(t *testing.T) {
		srv := mirrorServer(nil)
		defer srv.Close()
		a, admitted := w.consumer(srv, nil)
		a.manifest.History = nil
		if load := a.LoadCheckpoints(context.Background(), own); load.Hi != 0 || len(*admitted) != 0 || a.CheckpointMirrors() != nil {
			t.Fatalf("%s", load)
		}
	})
	t.Run("an oversized body", func(t *testing.T) {
		big := bytes.Repeat([]byte(" "), maxCheckpointBytes+1)
		srv := mirrorServer(map[string][]byte{host(M[0]): big})
		defer srv.Close()
		a, _ := w.consumer(srv, M)
		if load := a.LoadCheckpoints(context.Background(), own); load.Hi != 0 || !strings.Contains(load.String(), "size outside the limit") {
			t.Fatalf("%s", load)
		}
	})
}

// Replay and rollback: the furthest-reaching verified checkpoint is kept, an older one never replaces it, seeding never
// shrinks coverage, and an old checkpoint is still TRUE (finalized history) so it only lengthens the tail that is read.
func TestCheckpointReplayNeverRollsBackCoverage(t *testing.T) {
	w := newCPWorld(t)
	logs := []leaseLog{w.claim, w.renew}
	newer := w.envelope(120, 5000, logs, w.measurement, w.id, w.fresh())
	older := w.envelope(120, 3000, logs, w.measurement, w.id, w.fresh())
	own := w.s.report(w.s.fields([64]byte{}, w.measurement, w.id), w.s.vcekKey)
	r := w.reader()
	r.TrustCheckpointsFrom(own)
	if e := r.AdoptCheckpoint(w.id, newer); e != nil {
		t.Fatal(e)
	}
	if e := r.AdoptCheckpoint(w.id, older); e != nil { // verified, true, and not kept: it reaches less far
		t.Fatal(e)
	}
	now := uint64(time.Now().Unix())
	if hi := r.seedFromCheckpoint(w.id, 6000, 6000, now); hi != 5000 {
		t.Fatalf("seeded %d, want the newer 5000", hi)
	}
	// this guest has since read further itself: a replayed checkpoint never shrinks that
	r.keep(w.id, coverage{120, 7000, logs})
	if hi := r.seedFromCheckpoint(w.id, 8000, 8000, now); hi != 0 {
		t.Fatalf("a checkpoint below the coverage was seeded (%d)", hi)
	}
	if cov, _ := r.coverage(w.id); cov.hi != 7000 {
		t.Fatalf("coverage rolled back to %d", cov.hi)
	}
}

// The window: collateral must hold at the agreed chain block's own time and at this guest's clock when it is USED, not
// only when it was adopted; and seeding keeps coverage one range with no unread gap.
func TestCheckpointSeedIsTimeBoundAndGapFree(t *testing.T) {
	w := newCPWorld(t)
	logs := []leaseLog{w.renew}
	shortCRL := w.s.crl(t, nil, time.Now().Add(-time.Hour), time.Now().Add(10*time.Minute), w.s.arkKey)
	own := w.s.report(w.s.fields([64]byte{}, w.measurement, w.id), w.s.vcekKey)
	mk := func(lo, hi uint64, crl []byte) *Reader {
		r := w.reader()
		r.TrustCheckpointsFrom(own)
		if e := r.AdoptCheckpoint(w.id, w.envelope(lo, hi, logs, w.measurement, w.id, crl)); e != nil {
			t.Fatal(e)
		}
		return r
	}
	now := time.Now()
	r := mk(800, 5000, shortCRL)
	if r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Add(time.Hour).Unix())) != 0 {
		t.Fatal("seeded at a chain time past the CRL's nextUpdate")
	}
	if r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Add(-2*time.Hour).Unix())) != 0 {
		t.Fatal("seeded at a chain time before the CRL's thisUpdate")
	}
	r.now = func() time.Time { return now.Add(time.Hour) }
	if r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Unix())) != 0 {
		t.Fatal("seeded with this guest's clock past the CRL's nextUpdate")
	}
	r.now = time.Now
	if r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Unix())) != 5000 {
		t.Fatal("not seeded inside its window")
	}
	// contiguous with what this guest verified: extended, the verified blocks below kept
	r = mk(801, 5000, w.fresh())
	r.keep(w.id, coverage{120, 800, []leaseLog{w.claim}})
	r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Unix()))
	if cov, _ := r.coverage(w.id); cov.lo != 120 || cov.hi != 5000 || len(cov.logs) != 2 || cov.logs[0].block != 120 || cov.logs[1].block != 900 {
		t.Fatalf("contiguous: %+v", cov)
	}
	// overlapping: the checkpoint's own logs for its range, the older verified ones below it
	r = mk(500, 5000, w.fresh())
	r.keep(w.id, coverage{120, 1000, []leaseLog{w.claim, w.renew}})
	r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Unix()))
	if cov, _ := r.coverage(w.id); cov.lo != 120 || cov.hi != 5000 || len(cov.logs) != 2 {
		t.Fatalf("overlapping: %+v", cov)
	}
	// a gap between them: never bridged; the checkpoint's range replaces it and the search below its lo reads the gap
	r = mk(802, 5000, w.fresh())
	r.keep(w.id, coverage{120, 800, []leaseLog{w.claim}})
	r.seedFromCheckpoint(w.id, 6000, 6000, uint64(now.Unix()))
	if cov, _ := r.coverage(w.id); cov.lo != 802 || cov.hi != 5000 || len(cov.logs) != 1 {
		t.Fatalf("gap: %+v", cov)
	}
}

// The producer: it serves only what it verified, binds each new statement into a fresh report, keeps the last envelope
// when a read fails, and a consumer adopts what it serves.
func TestCheckpointProducerEndpoint(t *testing.T) {
	w := newCPWorld(t)
	r := w.reader()
	calls := 0
	auth := &Authorization{reader: r, snapshot: snapshot{row: ledgerRow{id: w.id}}, valid: true}
	if _, err := NewCheckpointProducer(auth, nil); err == nil {
		t.Fatal("a producer without a report source")
	}
	p, err := NewCheckpointProducer(auth, w.signer(w.measurement, w.id, &calls))
	if err != nil {
		t.Fatal(err)
	}
	var readErr error
	p.extend = func(context.Context) error { return readErr }
	get := func(method string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		p.ServeHTTP(rec, httptest.NewRequest(method, CheckpointPath, nil))
		return rec
	}
	if rec := get("GET"); rec.Code != 404 {
		t.Fatalf("served before any verified coverage: %d", rec.Code)
	}
	if p.Refresh(context.Background()) == nil {
		t.Fatal("refreshed with no verified coverage")
	}
	if rec := get("GET"); rec.Code != 404 || calls != 0 {
		t.Fatalf("an unverified statement was bound (%d, %d reports)", rec.Code, calls)
	}
	r.keep(w.id, coverage{120, 5000, []leaseLog{w.claim, w.renew}})
	if e := p.Refresh(context.Background()); e != nil {
		t.Fatal(e)
	}
	rec := get("GET")
	if rec.Code != 200 || rec.Header().Get("Access-Control-Allow-Origin") != "*" || rec.Header().Get("Cache-Control") != "no-store" || calls != 1 {
		t.Fatalf("%d %v, %d reports", rec.Code, rec.Header(), calls)
	}
	served := rec.Body.Bytes()
	if get("POST").Code != 405 {
		t.Fatal("POST accepted")
	}
	if p.Refresh(context.Background()); calls != 1 {
		t.Fatal("an unchanged statement was bound again")
	}
	// a read that fails keeps the last envelope (finalized history stays true) and says so
	readErr = errors.New("quorum unavailable")
	if e := p.Refresh(context.Background()); e == nil || !bytes.Equal(get("GET").Body.Bytes(), served) {
		t.Fatalf("a failed read: %v", e)
	}
	readErr = nil
	r.keep(w.id, coverage{120, 6000, []leaseLog{w.claim, w.renew}})
	p.Refresh(context.Background())
	if lo, hi := p.Range(); lo != 120 || hi != 6000 || calls != 2 {
		t.Fatalf("range %d-%d after %d reports", lo, hi, calls)
	}
	// what it serves is what a consumer adopts, once a carrier attached a CRL
	var c Checkpoint
	json.Unmarshal(get("GET").Body.Bytes(), &c)
	if c.CRL != "" {
		t.Fatal("the guest attached a CRL it never fetched")
	}
	c.CRL = base64.StdEncoding.EncodeToString(w.fresh())
	carried, _ := json.Marshal(c)
	consumer := w.reader()
	consumer.TrustCheckpointsFrom(w.s.report(w.s.fields([64]byte{}, w.measurement, w.id), w.s.vcekKey))
	if e := consumer.AdoptCheckpoint(w.id, carried); e != nil {
		t.Fatalf("the served checkpoint: %v", e)
	}
	var nilProducer *CheckpointProducer
	rec = httptest.NewRecorder()
	nilProducer.ServeHTTP(rec, httptest.NewRequest("GET", CheckpointPath, nil))
	if rec.Code != 404 {
		t.Fatal("a nil producer served")
	}
}
