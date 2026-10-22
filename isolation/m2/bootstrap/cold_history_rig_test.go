package bootstrap

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"enclave.host/isolation/m2/appconfig"
)

// TestColdHistoryRig: the relay-free guest's ACTUAL direct path (Reader.Authorize on the owner-committed startup package,
// then Authorization.WriterAuthority under WhenFinal, as front/bootstrap.go and shield_direct_custody.go call it) with a
// FRESH reader per check (no coverage, no cache), against the live rev-16d ledger bytecode on anvil. Driven by
// test/storage-front-cold-history.test.mjs, which mutates the chain and passes each run's checks in COLD_HISTORY_RIG;
// skipped without it. The transport refuses an owner history host until Authorize admits it (AllowOrigin), as the
// guest's dialer does (front/measured_reader.go).
func TestColdHistoryRig(t *testing.T) {
	raw := os.Getenv("COLD_HISTORY_RIG")
	if raw == "" {
		t.Skip("driven by test/storage-front-cold-history.test.mjs")
	}
	var in struct {
		Routes   map[string]string `json:"routes"`
		Measured []string          `json:"measured"`
		Ledger   string            `json:"ledger"`
		Offset   int64             `json:"clockOffsetSec"`
		Checks   []struct {
			Name      string          `json:"name"`
			ID        string          `json:"id"`
			Package   string          `json:"package"`
			AppID     string          `json:"appId"`
			RuntimeID string          `json:"runtimeId"`
			WindowMs  int             `json:"windowMs"`
			StepMs    int             `json:"intervalMs"`
			Pause     string          `json:"pause"`
			Fact      json.RawMessage `json:"fact"`
			Code      string          `json:"code"`
			Contains  string          `json:"contains"`
			AuthFails string          `json:"authorizeFails"`
			MaxReq    int             `json:"maxRequests"`
			AttemptMs int             `json:"attemptTimeoutMs"`
			// attested checkpoints (checkpoint_producer.go, checkpoint_transport.go): an earlier guest of the same build
			// (the PRODUCER: the same package, Authorize, its history sources) serves its checkpoint at CheckpointPath; a
			// carrier copies it (adding a CRL, as the owner's export does) to the package's committed mirror hosts, each
			// serving what Mirrors says; then the producer's endpoint is LOST. This guest loads the mirrors as the front does.
			//   copy | stale-crl (the copy, its CRL stale) | tamper (the statement altered after signing, a fresh CRL) |
			//   other-deployment (a genuine checkpoint of OtherID) | other-build (the statement, evidence of another
			//   measurement) | down
			Checkpoint *struct {
				Mirrors map[string]string `json:"mirrors"`
				OtherID string            `json:"otherId"`
				OtherPk string            `json:"otherPackage"`
			} `json:"checkpoint"`
			// the package's history sources are unreachable from THIS guest (the producer reached them)
			HistoryDown bool `json:"historyDown"`
			PauseBefore bool `json:"pauseBefore"` // pause before Authorize (after the checkpoint), not after it
		} `json:"checks"`
	}
	if err := json.Unmarshal([]byte(raw), &in); err != nil {
		t.Fatal(err)
	}
	from, backoff, maxReq, attempt := leaseFromBlock, leaseBackoff, leaseMaxRequests, leaseAttemptTimeout
	leaseFromBlock, leaseBackoff = 0, 10*time.Millisecond
	defer func() {
		leaseFromBlock, leaseBackoff, leaseMaxRequests, leaseAttemptTimeout = from, backoff, maxReq, attempt
	}()
	cp := &rigCheckpoints{measured: in.Measured, ledger: in.Ledger, offset: time.Duration(in.Offset) * time.Second, made: map[string][]byte{}}
	defer cp.close()
	measuredHosts := map[string]bool{}
	for _, m := range in.Measured {
		u, _ := url.Parse(m)
		measuredHosts[u.Hostname()] = true
	}
	for _, c := range in.Checks {
		leaseMaxRequests, leaseAttemptTimeout = maxReq, attempt
		if c.MaxReq > 0 { // a smaller per-attempt budget: the scan must resume across attempts
			leaseMaxRequests = c.MaxReq
		}
		if c.AttemptMs > 0 { // a shorter attempt deadline: its completed steps must survive it
			leaseAttemptTimeout = time.Duration(c.AttemptMs) * time.Millisecond
		}
		// a fresh guest: its own reader, its own allowlist (the measured origins), nothing cached
		var mu sync.Mutex
		allowed, admitted, down := map[string]bool{}, []string{}, map[string]bool{}
		for h := range measuredHosts {
			allowed[h] = true
		}
		client := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
			mu.Lock()
			ok, isDown := allowed[r.URL.Hostname()], down[r.URL.Hostname()]
			mu.Unlock()
			cp.routesMu.Lock()
			to, known := in.Routes[r.URL.Hostname()]
			cp.routesMu.Unlock()
			if !ok || !known {
				return nil, errors.New("unmeasured bootstrap RPC origin")
			}
			if isDown {
				return nil, errors.New("connection refused")
			}
			u, _ := url.Parse(to)
			r = r.Clone(r.Context())
			r.Header.Set("X-Mirror-Host", r.URL.Hostname())
			r.URL.Scheme, r.URL.Host, r.Host = u.Scheme, u.Host, u.Host
			return http.DefaultTransport.RoundTrip(r)
		})}
		reader, err := NewReader(Config{ChainID: 8453, Ledger: in.Ledger, RPCs: in.Measured, Confirmations: 2, MaxAge: 2 * time.Minute, Client: client,
			AllowOrigin: func(hostport string) {
				h, _, _ := net.SplitHostPort(hostport)
				mu.Lock()
				allowed[h] = true
				admitted = append(admitted, h)
				mu.Unlock()
			}})
		if err != nil {
			t.Fatal(err)
		}
		offset := time.Duration(in.Offset) * time.Second
		reader.now = func() time.Time { return time.Now().Add(offset) }
		var id, app, rt [32]byte
		b, _ := hex.DecodeString(strings.TrimPrefix(c.ID, "0x"))
		copy(id[:], b)
		b, _ = hex.DecodeString(c.AppID)
		copy(app[:], b)
		b, _ = hex.DecodeString(c.RuntimeID)
		copy(rt[:], b)
		pkg, _ := base64.StdEncoding.DecodeString(c.Package)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		var ownReport []byte
		if c.Checkpoint != nil {
			var err error
			if ownReport, err = cp.mirror(t, ctx, in.Routes, c.Name, id, pkg, Identity{AppID: app, RuntimeID: rt}, c.Checkpoint.Mirrors, c.Checkpoint.OtherID, c.Checkpoint.OtherPk); err != nil {
				cancel()
				t.Errorf("%s: %v", c.Name, err)
				continue
			}
		}
		if c.HistoryDown {
			var p Manifest
			json.Unmarshal(pkg, &p)
			mu.Lock()
			for _, u := range p.History.RPCs {
				h, _ := historyURL(u)
				down[h] = true
			}
			mu.Unlock()
		}
		if c.PauseBefore && c.Pause != "" { // the driver changes the chain before this guest starts
			os.WriteFile(filepath.Join(c.Pause, "authorized"), []byte("1"), 0o644)
			for i := 0; i < 600; i++ {
				if _, e := os.Stat(filepath.Join(c.Pause, "proceed")); e == nil {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		auth, err := reader.AuthorizeWhenConfirmed(ctx, id, pkg, Identity{AppID: app, RuntimeID: rt})
		if c.AuthFails != "" {
			cancel()
			mu.Lock()
			n := len(admitted)
			mu.Unlock()
			if err == nil || !strings.Contains(err.Error(), c.AuthFails) || n != 0 {
				t.Errorf("%s: want Authorize to fail with %q and admit no origin, got %v (admitted %d)", c.Name, c.AuthFails, err, n)
			}
			continue
		}
		if err != nil {
			cancel()
			t.Errorf("%s: authorize: %v", c.Name, err)
			continue
		}
		mu.Lock()
		fmt.Printf("ADMITTED %s %s\n", c.Name, strings.Join(admitted, ","))
		mu.Unlock()
		if ownReport != nil { // as front/bootstrap.go loadCheckpoints: the committed mirrors, this guest's own report
			fmt.Printf("LOAD %s %s\n", c.Name, auth.LoadCheckpoints(ctx, ownReport))
			mu.Lock()
			fmt.Printf("ADMITTED-AFTER-LOAD %s %s\n", c.Name, strings.Join(admitted, ","))
			mu.Unlock()
		}
		if c.Pause != "" && !c.PauseBefore { // the driver changes the chain between authorization and the writer authority
			os.WriteFile(filepath.Join(c.Pause, "authorized"), []byte("1"), 0o644)
			for i := 0; i < 600; i++ {
				if _, e := os.Stat(filepath.Join(c.Pause, "proceed")); e == nil {
					break
				}
				time.Sleep(100 * time.Millisecond)
			}
		}
		attempts := 0
		t0 := time.Now()
		w, err := WhenFinal(ctx, time.Duration(c.WindowMs)*time.Millisecond, time.Duration(c.StepMs)*time.Millisecond, func(x context.Context) (appconfig.WriterAuthority, error) {
			attempts++
			return auth.WriterAuthority(x)
		})
		cancel()
		fmt.Printf("ATTEMPTS %s %d %dms %v\n", c.Name, attempts, time.Since(t0).Milliseconds(), err)
		switch {
		case c.Code != "":
			var ae *AuthorityError
			if !errors.As(err, &ae) || ae.Code != c.Code {
				t.Errorf("%s: want %s, got %v", c.Name, c.Code, err)
			}
		case c.Contains != "":
			if err == nil || !strings.Contains(err.Error(), c.Contains) {
				t.Errorf("%s: want an error containing %q, got %v", c.Name, c.Contains, err)
			}
		case len(c.Fact) == 0: // the driver compares the fact itself (it changed the chain during the run)
			j, _ := w.JSON()
			fmt.Printf("FACT %s %s %v\n", c.Name, j, err)
		default:
			if err != nil {
				t.Errorf("%s: %v", c.Name, err)
				continue
			}
			j, _ := w.JSON()
			if j != string(c.Fact) {
				t.Errorf("%s: fact\n got %s\nwant %s", c.Name, j, c.Fact)
			}
		}
	}
}

// rigCheckpoints: the producer, the carrier and the mirrors of the checkpoint checks (one Go run).
type rigCheckpoints struct {
	measured []string
	ledger   string
	offset   time.Duration
	made     map[string][]byte // producer endpoint bytes by deployment id (one producer per deployment per run)
	servers  []*httptest.Server
	mu       sync.Mutex
	routesMu sync.Mutex
}

func (cp *rigCheckpoints) close() {
	for _, s := range cp.servers {
		s.Close()
	}
}

var cpMeasurement, cpOtherBuild = [48]byte{0xab, 0xcd}, [48]byte{0xab, 0xce}

// produce: a producing guest of this build for `id`: Authorize the committed package, then the REAL CheckpointProducer
// (its report source signing over the REPORT_DATA it is given, as the PSP does) until it serves; the bytes its endpoint
// serves, after which that endpoint is LOST (closed).
func (cp *rigCheckpoints) produce(t *testing.T, ctx context.Context, routes map[string]string, id [32]byte, pkg []byte, loaded Identity) ([]byte, error) {
	key := hex.EncodeToString(id[:])
	if b := cp.made[key]; b != nil {
		return b, nil
	}
	everything := &http.Client{Transport: roundTrip(func(r *http.Request) (*http.Response, error) {
		cp.routesMu.Lock()
		to, known := routes[r.URL.Hostname()]
		cp.routesMu.Unlock()
		if !known {
			return nil, errors.New("unrouted")
		}
		u, _ := url.Parse(to)
		r = r.Clone(r.Context())
		r.URL.Scheme, r.URL.Host, r.Host = u.Scheme, u.Host, u.Host
		return http.DefaultTransport.RoundTrip(r)
	})}
	producer, err := NewReader(Config{ChainID: 8453, Ledger: cp.ledger, RPCs: cp.measured, Confirmations: 2, MaxAge: 2 * time.Minute, Client: everything})
	if err != nil {
		return nil, err
	}
	producer.now = func() time.Time { return time.Now().Add(cp.offset) }
	auth, err := producer.AuthorizeWhenConfirmed(ctx, id, pkg, loaded)
	if err != nil {
		return nil, fmt.Errorf("the producing guest's Authorize: %v", err)
	}
	s := newSynthAMD(t)
	certs := auxblob(s.vcek.Raw, s.ask.Raw, s.ark.Raw) // the host loaded the certificate table (configfs-tsm auxblob)
	p, err := NewCheckpointProducer(auth, func(rd []byte) ([]byte, []byte, error) {
		var r64 [64]byte
		copy(r64[:], rd)
		return s.report(s.fields(r64, cpMeasurement, id), s.vcekKey), certs, nil
	})
	if err != nil {
		return nil, err
	}
	srv := httptest.NewServer(p)
	defer srv.Close() // the original host is lost once its checkpoint was copied
	for i := 0; ; i++ {
		e := p.Refresh(ctx)
		if _, hi := p.Range(); hi > 0 && e == nil {
			break
		}
		if i > 240 || ctx.Err() != nil {
			return nil, fmt.Errorf("the producing guest never verified the lease: %v", e)
		}
		time.Sleep(500 * time.Millisecond)
	}
	res, err := http.Get(srv.URL + CheckpointPath)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		return nil, fmt.Errorf("the producer endpoint answered %d", res.StatusCode)
	}
	lo, hi := p.Range()
	fmt.Printf("PRODUCED %x %d-%d %d bytes\n", id[:4], lo, hi, len(b))
	cp.made[key] = b
	return b, nil
}

// withCRL: the carrier's copy with a CRL attached (the owner's export / refresh-crl does this with AMD's CRL).
func withCRL(raw, crl []byte) []byte {
	var c Checkpoint
	json.Unmarshal(raw, &c)
	c.CRL = base64.StdEncoding.EncodeToString(crl)
	b, _ := json.Marshal(c)
	return b
}

// mirror: produce, carry, serve the mirrors; -> this guest's own report (the same build on the same platform).
func (cp *rigCheckpoints) mirror(t *testing.T, ctx context.Context, routes map[string]string, name string, id [32]byte, pkg []byte, loaded Identity, modes map[string]string, otherID, otherPkg string) ([]byte, error) {
	served, err := cp.produce(t, ctx, routes, id, pkg, loaded)
	if err != nil {
		return nil, err
	}
	s := newSynthAMD(t)
	at := time.Now().Add(cp.offset) // the guest's clock (the rig's chain runs a month ahead of the wall clock)
	fresh := s.crl(t, nil, at.Add(-time.Hour), at.Add(24*time.Hour), s.arkKey)
	stale := s.crl(t, nil, at.Add(-48*time.Hour), at.Add(-time.Hour), s.arkKey)
	bodies := map[string][]byte{}
	for host, mode := range modes {
		switch mode {
		case "copy":
			bodies[host] = withCRL(served, fresh)
		case "stale-crl":
			bodies[host] = withCRL(served, stale)
		case "tamper": // a log dropped after signing (an absence manufactured): still canonical, no longer what is bound
			var c Checkpoint
			json.Unmarshal(served, &c)
			var st checkpointStatement
			json.Unmarshal(c.Statement, &st)
			if len(st.Logs) == 0 {
				return nil, errors.New("nothing to drop")
			}
			st.Logs = st.Logs[:len(st.Logs)-1]
			c.Statement, _ = json.Marshal(st)
			b, _ := json.Marshal(c)
			bodies[host] = withCRL(b, fresh)
		case "other-build": // the same statement, evidence from another measured image
			var c Checkpoint
			json.Unmarshal(served, &c)
			rep := s.report(s.fields(CheckpointReportData(c.Statement), cpOtherBuild, id), s.vcekKey)
			c.Report = base64.StdEncoding.EncodeToString(rep)
			b, _ := json.Marshal(c)
			bodies[host] = withCRL(b, fresh)
		case "other-deployment": // a genuine checkpoint of another deployment of the same owner and build
			var oid [32]byte
			ob, _ := hex.DecodeString(strings.TrimPrefix(otherID, "0x"))
			copy(oid[:], ob)
			opkg, _ := base64.StdEncoding.DecodeString(otherPkg)
			other, err := cp.produce(t, ctx, routes, oid, opkg, loaded)
			if err != nil {
				return nil, err
			}
			bodies[host] = withCRL(other, fresh)
		case "down":
		default:
			return nil, fmt.Errorf("unknown mirror mode %q", mode)
		}
	}
	mirrors := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cp.mu.Lock()
		b := bodies[r.Header.Get("X-Mirror-Host")] // the name the guest asked for (its client routes every name here)
		cp.mu.Unlock()
		if b == nil {
			http.Error(w, "gone", http.StatusServiceUnavailable)
			return
		}
		w.Write(b)
	}))
	cp.servers = append(cp.servers, mirrors)
	cp.routesMu.Lock()
	for host := range modes {
		routes[host] = mirrors.URL
	}
	cp.routesMu.Unlock()
	fmt.Printf("MIRRORS %s %v\n", name, modes)
	return s.report(s.fields([64]byte{}, cpMeasurement, id), s.vcekKey), nil
}
