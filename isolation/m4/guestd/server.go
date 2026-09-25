// guestd: the per-app SNP guest manager, on the HOST.
//
// WHY IT EXISTS. On a metal node every app runs as a process inside ONE node CVM, and the supervisor there drives
// an app manager over the /vms contract (supervisor.js spawnContainer / stopContainer / listBackendInstances /
// instanceAlive / vouchTenants). The per-app isolation backend that is measured on this hardware (M4a:
// isolation/m4/build-app-guest.sh, test-m4.sh) runs each app in its OWN SNP guest - and an SNP guest cannot launch
// SNP guests, so that backend has to be driven from the host. guestd speaks the same /vms contract, so the seam the
// supervisor already names ("IMPLEMENT THESE for your CVM launch mechanism") is the only integration point.
//
// WHAT IT GUARANTEES, and what it does not:
//
//   - A guest is reported "running" only after the M4a client (isolation/m2/client.mjs, the judge the M4a suite
//     scores with) has ATTESTED it: AMD chain to the pinned root, the TCB floor, the launch measurement PREDICTED
//     from this very bundle, the AppID in report_data[32:64], and the TLS key bound in report_data[0:32]. Until
//     then it is "starting"; if that fails it is "failed" and already torn down.
//
//   - It refuses, rather than drops, every request feature it cannot honour inside the guest without weakening
//     the contract: GPU/shielded shares, owner secrets (they would cross this host in plaintext), egress, app
//     config, extra ports. A silently dropped secret is a leak; a silently dropped config is a wrong app.
//
//   - Each guest's end runs through contract.Lifecycle: exactly one reclamation, however it ends (delete, lease
//     lapse, guest death, failed start), and a delete during startup is honoured when startup finishes.
//
//   - The dead-man lease has the wasm-manager's semantics: inert until the first heartbeat, and silence is never
//     evidence about a tenant.
//
//   - It is NOT the trust anchor. It runs on the host, which the design treats as untrusted. The client's own
//     verification of the guest is what a user relies on; guestd's verification only keeps it from reporting a
//     guest as running that no client could accept.
//
//   - Guests OUTLIVE a guestd restart: the next guestd adopts each that verifies again as itself (persist.go).
//
//   - It is DISABLED unless GUESTD_ENABLE=1.
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/contract/catalog"
)

// Launcher is everything guestd does to the machine. The real one shells out to the M4a scripts; tests use a fake.
type Launcher interface {
	// Build makes the guest image for a bundle and returns the launch measurement predicted for it.
	Build(ctx context.Context, bundle, workdir string, vcpus int) (image, measurement string, err error)
	// Start boots the image as an SNP guest and returns its unit and vsock CID once its front serves. hostData (64 hex,
	// or "") becomes the guest's SEV-SNP HOST_DATA: signed into every report, outside the measurement.
	// cid is the vsock CID guestd chose for the guest (release.go), known before the guest boots.
	Start(ctx context.Context, image, tag, workdir string, vcpus, memMiB, cpuPct int, hostData string, cid uint32) (unit string, err error)
	// Forward exposes the guest's attested TLS endpoint on a host port. stop ends the forwarder.
	Forward(ctx context.Context, cid uint32, workdir string) (port int, stop func(), err error)
	// Verify attests the guest over that port against the predicted measurement and the AppID, and returns the
	// sha256 of the TLS key its OWN handshake saw (the key the verified report binds). The data plane admits a
	// splice only to a guest still presenting that identity (datapath.go).
	Verify(ctx context.Context, port int, measurement, appID, hostData, workdir string) (verdict, keySha256 string, err error)
	// Alive reports whether the guest's unit is still active.
	Alive(unit string) bool
	// Stop tears the guest down.
	Stop(tag, workdir string) error
	// Sweep stops every guest a previous guestd left behind, except the units adopted (keep), before this one serves.
	Sweep(keep map[string]bool) ([]string, error)
}

// Request is the supervisor's POST /vms body, field for field (supervisor.js spawnContainer). Unknown fields are
// REFUSED: a field added later is a feature, and a feature this backend does not implement must not vanish.
type Request struct {
	Image     string            `json:"image"`
	Name      string            `json:"name"`
	CPUShare  float64           `json:"cpuShare"`
	GPUShare  float64           `json:"gpuShare"`
	GPUTflops float64           `json:"gpuTflops"`
	CPUGflops float64           `json:"cpuGflops"`
	CPUTflops float64           `json:"cpuTflops"`
	AppPort   int               `json:"appPort"`
	Ports     []json.RawMessage `json:"ports"`
	Config    string            `json:"config"`
	ConfigCid string            `json:"configCid"`
	Egress    string            `json:"egress"`
	Secrets   map[string]any    `json:"secrets"`
	Hosts     string            `json:"hosts"`
	Shielded  json.RawMessage   `json:"shielded"`
	// Ticket is a release ticket (base64, 32 bytes) for the deployment this guest serves: accepted only with -release,
	// and handed only to this guest (release.go). The config and secrets it releases never cross this host.
	Ticket string `json:"ticket"`
	// Derive is the catalog derivation record (contract/catalog/DERIVE.md) an ipfs:// image needs: the CID alone names
	// bytes, not a contract identity, and guestd will not invent one.
	Derive *catalog.Derivation `json:"derive"`
}

// unsupported names the first feature this backend cannot honour inside the guest, or "".
func unsupported(r *Request) string {
	switch {
	case r.GPUShare > 0 || len(r.Shielded) > 0:
		return "a GPU share: a per-app SNP guest has no GPU path"
	case len(r.Secrets) > 0:
		return "owner secrets: they would cross this host in plaintext, and attested in-guest delivery is not built"
	case r.Egress != "":
		return "dedicated egress: not wired into the guest"
	case r.Config != "" || r.ConfigCid != "":
		return "app config: not delivered into the guest yet"
	case len(r.Ports) > 0:
		return "extra ports: only the attested TLS endpoint is forwarded"
	}
	return ""
}

type vm struct {
	ID, Name, AppID, Measurement, Status, Error, Verdict string
	RecordSha256                                         string // the catalog derivation, when the app came from one
	TransportKeySha256                                   string // the key the verifying handshake saw
	HostData                                             string // SEV-SNP HOST_DATA the guest was launched with (hex), "" = none
	HostPort                                             int
	Vcpus, MemMiB, CPUPct                                int
	Created                                              time.Time
	unit, workdir                                        string
	cid                                                  uint32
	stopFwd                                              func()
	lc                                                   *contract.Lifecycle
	leaseUntil                                           time.Time
	splices                                              map[*splice]struct{} // open data-plane connections
	reclaimed                                            bool                 // its reclaim has finished: it holds no reservation (pool.go)
	ticket                                               chan [32]byte        // its one release ticket slot; nil = it takes none (release.go)
	awaitingTicket                                       bool                 // its guest is connected and waiting for the ticket
}

type server struct {
	L         Launcher
	Auth      *controlAuth // guestd-control/1; nil = the unauthenticated, loopback-only lab mode
	Store     *store       // catalog mappings; nil = only file:// bundles are accepted
	Root      string       // per-guest workdirs live under here, and nothing else does
	LeaseTTL  time.Duration
	Silence   time.Duration
	Now       func() time.Time
	Firmware  map[string]any
	RuntimeID string     // hex; the runtime identity every guest image here carries (the judge pins it)
	Data      *dataPlane // nil = no data plane (the default)
	Budget    poolBudget // the guest pool's budget; the zero value admits no guest (pool.go)
	// Release: deliver attested-release tickets and serve egress to deployment guests (release.go, -release).
	Release    bool
	TicketHold time.Duration // how long a guest's ticket connection is held; 0 = 5 minutes
	drawCID    func() uint32 // tests; nil = crypto/rand
	mu         sync.Mutex
	vms        map[string]*vm
	lastBeat   time.Time // zero = never heard one: the lease is INERT
	launching  sync.WaitGroup
}

func newServer(l Launcher, root string) *server {
	return &server{L: l, Root: root, LeaseTTL: 300 * time.Second, Silence: 180 * time.Second, Now: time.Now,
		vms: map[string]*vm{}}
}

// deploymentIDRE is the supervisor's name for an instance: the on-chain deployment id, bytes32.
var deploymentIDRE = regexp.MustCompile(`^0x[0-9a-fA-F]{64}$`)

// hostDataFor is the SEV-SNP HOST_DATA an instance is launched with: its deployment id's 32 raw bytes (hex here),
// so a client can check WHICH deployment it reached, not only which app (two instances of one version share a
// measurement and an AppID). A name that is not a deployment id (lab and test launches) gets none.
func hostDataFor(name string) string {
	if !deploymentIDRE.MatchString(name) {
		return ""
	}
	return strings.ToLower(name[2:])
}

func newID() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return "gd" + hex.EncodeToString(b)
}

func (s *server) json(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// public is what the supervisor sees: GET /vms needs id, name and createdAt (orphanInstancePlan), and
// instanceAlive reads status.
func (v *vm) public() map[string]any {
	m := map[string]any{"id": v.ID, "name": v.Name, "status": v.Status, "createdAt": v.Created.Unix(),
		"hostPort": v.HostPort, "appId": v.AppID, "measurement": v.Measurement, "vcpus": v.Vcpus,
		"memMiB": v.MemMiB, "backend": "snp-guest-per-app"}
	if v.holds() {
		m["reserved"] = v.reservation()
	}
	if v.Error != "" {
		m["error"] = v.Error
	}
	if v.Verdict != "" {
		m["verdict"] = v.Verdict
	}
	if v.RecordSha256 != "" {
		m["recordSha256"] = v.RecordSha256
	}
	if v.TransportKeySha256 != "" {
		m["transportKeySha256"] = v.TransportKeySha256
	}
	if v.HostData != "" {
		m["hostData"] = v.HostData
	}
	if v.awaitingTicket {
		m["awaitingTicket"] = true // its guest is booted and waiting: the supervisor fetches a ticket now (release.go)
	}
	if s := len(v.splices); s > 0 {
		m["openSplices"] = s
	}
	return m
}

// view is public() plus what is the same for every guest here: the runtime identity each image carries, so one
// answer about an instance states the whole identity a splice is admitted for (datapath.go). Called with s.mu held.
func (s *server) view(v *vm) map[string]any {
	m := v.public()
	if s.RuntimeID != "" {
		m["runtimeId"] = s.RuntimeID
	}
	return m
}

// ServeHTTP is the channel policy (auth.go). With a pairing key, only the handshake is unauthenticated and every
// other answer is signed; without one, this is the loopback-only LAB mode and the handshake endpoints refuse, so a
// client that expects guestd-control/1 fails closed instead of falling back to an unauthenticated manager.
func (s *server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	control := strings.HasPrefix(r.URL.Path, "/control/")
	switch {
	case s.Auth == nil && control:
		writeJSON(w, 404, map[string]any{"error": "this guestd has no control credentials configured (unauthenticated lab mode)"})
	case s.Auth == nil:
		s.route(w, r)
	case r.Method == http.MethodGet && r.URL.Path == "/control/hello":
		s.Auth.hello(w)
	case r.Method == http.MethodPost && r.URL.Path == "/control/session":
		s.Auth.openSession(w, r)
	case control:
		writeJSON(w, 404, map[string]any{"error": "not found"})
	default:
		s.Auth.serve(w, r, s.route)
	}
}

func (s *server) route(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/health":
		s.mu.Lock()
		n := len(s.vms)
		pool := s.poolLocked()
		s.mu.Unlock()
		cat := map[string]any{"derivations": []string{}}
		if s.Store != nil {
			cat = map[string]any{"derivations": []string{catalog.V1, catalog.V2}, "runtimeId": s.Store.RuntimeID}
		}
		s.json(w, 200, map[string]any{"ok": true, "backend": "snp-guest-per-app", "guests": n,
			"firmware": s.Firmware, "catalog": cat, "pool": pool,
			// what a tenant here does NOT get, so a claim gate can refuse deployments that need it
			// release: config and secrets reach a DEPLOYMENT guest only through the attested release, sealed to it, with
			// egress to its own allowlist (release.go); nothing of them crosses this host, so config/secrets stay false
			"supports": map[string]bool{"gpu": false, "secrets": false, "egress": false, "config": false,
				"ports": false, "configCid": false, "release": s.Release}})
	case r.Method == http.MethodPost && r.URL.Path == "/vms":
		s.create(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/prefetch":
		s.prefetch(w, r)
	case r.Method == http.MethodPost && r.URL.Path == "/vms/lease":
		s.lease(w, r)
	case r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/vms/") && strings.HasSuffix(r.URL.Path, "/ticket"):
		s.postTicket(w, r, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/vms/"), "/ticket"))
	case r.Method == http.MethodGet && r.URL.Path == "/vms":
		s.mu.Lock()
		out := []map[string]any{}
		for _, v := range s.vms {
			out = append(out, s.view(v))
		}
		s.mu.Unlock()
		sort.Slice(out, func(i, j int) bool { return out[i]["id"].(string) < out[j]["id"].(string) })
		s.json(w, 200, map[string]any{"vms": out})
	case strings.HasPrefix(r.URL.Path, "/vms/") && strings.HasSuffix(r.URL.Path, "/logs") && r.Method == http.MethodGet:
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/vms/"), "/logs")
		s.mu.Lock()
		v := s.vms[id]
		s.mu.Unlock()
		if v == nil {
			s.json(w, 404, map[string]any{"error": "no such instance"})
			return
		}
		out, err := s.logs(v, tailParam(r.URL.Query().Get("tail")))
		if err != nil {
			s.json(w, 404, map[string]any{"error": err.Error()})
			return
		}
		s.json(w, 200, out)
	case strings.HasPrefix(r.URL.Path, "/vms/") && (r.Method == http.MethodGet || r.Method == http.MethodDelete):
		id := strings.TrimPrefix(r.URL.Path, "/vms/")
		s.mu.Lock()
		v := s.vms[id]
		var pub map[string]any
		if v != nil {
			pub = s.view(v)
		}
		s.mu.Unlock()
		if v == nil {
			s.json(w, 404, map[string]any{"error": "no such instance"})
			return
		}
		if r.Method == http.MethodGet {
			s.json(w, 200, pub)
			return
		}
		s.destroy(w, v)
	default:
		s.json(w, 404, map[string]any{"error": "not found"})
	}
}

func (s *server) create(w http.ResponseWriter, r *http.Request) {
	var req Request
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		s.json(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	if req.Name == "" || req.Image == "" {
		s.json(w, 400, map[string]any{"error": "name and image are required"})
		return
	}
	if why := unsupported(&req); why != "" {
		s.json(w, 422, map[string]any{"error": "this backend refuses " + why})
		return
	}
	tk, err := s.ticketFromRequest(&req, hostDataFor(req.Name))
	if err != nil {
		s.json(w, 422, map[string]any{"error": "this backend refuses " + err.Error()})
		return
	}
	// The bundle is obtained and checked BEFORE anything is accepted, so a request for an app with no contract
	// identity is refused synchronously instead of surfacing later as a failed boot.
	raw, record, code, err := s.bundleFor(r.Context(), req.Image, req.Derive)
	if err != nil {
		s.json(w, code, map[string]any{"error": err.Error()})
		return
	}
	m, _, err := contract.Parse(raw)
	if err != nil {
		s.json(w, 422, map[string]any{"error": "not a contract bundle this backend can name: " + err.Error()})
		return
	}
	id := contract.AppID(raw)
	pol := contract.EffectivePolicy(&m, contract.Request{})
	mem := guestMemMiB(pol.MemMiB)
	s.mu.Lock()
	for _, o := range s.vms {
		if o.Name == req.Name && o.lc.State() != contract.Ended && o.Status != "failed" {
			s.mu.Unlock()
			s.json(w, 409, map[string]any{"error": "an instance for this name is live", "id": o.ID})
			return
		}
	}
	// the pool (pool.go): checked under the lock that inserts, so two creates cannot both take the last room
	if refusal := s.admitLocked(reservationFor(mem, pol.CPUPercent)); refusal != nil {
		s.mu.Unlock()
		s.json(w, http.StatusInsufficientStorage, refusal)
		return
	}
	cid, err := s.pickCIDLocked()
	if err != nil {
		s.mu.Unlock()
		s.json(w, 503, map[string]any{"error": err.Error()})
		return
	}
	v := &vm{ID: newID(), Name: req.Name, AppID: hex.EncodeToString(id[:]), Status: "starting", RecordSha256: record,
		HostData: hostDataFor(req.Name),
		Vcpus:    pol.Vcpus, MemMiB: mem, CPUPct: pol.CPUPercent, Created: s.Now(),
		lc: contract.NewLifecycle(contract.Starting), leaseUntil: s.Now().Add(s.LeaseTTL), cid: cid}
	if s.Release && v.HostData != "" {
		v.ticket = make(chan [32]byte, 1)
		if tk != nil {
			v.ticket <- *tk
		}
	}
	v.workdir = filepath.Join(s.Root, v.ID)
	s.vms[v.ID] = v
	pub := v.public()
	s.mu.Unlock()
	if err := os.MkdirAll(v.workdir, 0o700); err != nil {
		s.fail(v, fmt.Errorf("workdir: %w", err))
		s.json(w, 500, map[string]any{"error": err.Error()})
		return
	}
	if err := os.WriteFile(filepath.Join(v.workdir, "app.bundle"), raw, 0o600); err != nil {
		s.fail(v, fmt.Errorf("staging the bundle: %w", err))
		s.json(w, 500, map[string]any{"error": err.Error()})
		return
	}
	s.launching.Add(1)
	go s.launch(v)
	s.json(w, 201, pub)
}

// guestMemMiB is the guest's RAM: the bundle's share plus room for the guest kernel and the runtime. M4a boots
// the same kernel and a 45 MB runtime for every app, so a floor applies whatever the manifest asked for.
func guestMemMiB(policy int) int {
	if policy+guestRuntimeMiB < guestFloorMiB {
		return guestFloorMiB
	}
	return policy + guestRuntimeMiB
}

// bundleFor returns the bundle bytes an image reference names, the derivation record's digest when it came from
// the catalog, and the status a refusal deserves.
//
//   - file:///abs/path  a contract bundle on this host (lab and staging)
//   - ipfs://<cid>      a catalog component, ONLY with a derivation record naming that same CID: resolved through
//     the immutable mapping store, which fetches and verifies at most once. The CID alone names
//     bytes, not a contract identity, and guestd will not invent one.
func (s *server) bundleFor(ctx context.Context, image string, d *catalog.Derivation) ([]byte, string, int, error) {
	if p, ok := strings.CutPrefix(image, "file://"); ok && filepath.IsAbs(p) {
		if d != nil {
			return nil, "", 422, errors.New("a derivation record applies to an ipfs:// catalog component, not to a file bundle")
		}
		raw, err := os.ReadFile(p)
		if err != nil {
			return nil, "", 422, errors.New("reading the bundle: " + err.Error())
		}
		return raw, "", 0, nil
	}
	cid, ok := strings.CutPrefix(image, "ipfs://")
	switch {
	case !ok:
		return nil, "", 422, errors.New("the image must be file:///absolute/path or ipfs://<cid>")
	case s.Store == nil:
		return nil, "", 422, errors.New("this guestd has no catalog store: only file:// bundles are accepted")
	case d == nil:
		return nil, "", 422, errors.New("a catalog CID needs its derivation record (derive): the CID names bytes, not a contract identity")
	case d.CID != cid:
		return nil, "", 422, fmt.Errorf("the derivation record is for %s, not for the image %s", d.CID, cid)
	}
	m, b, err := s.Store.resolve(ctx, *d)
	if err != nil {
		var se *storeErr
		if errors.As(err, &se) {
			return nil, "", se.code, err
		}
		return nil, "", 502, err
	}
	return b, m.RecordSha256, 0, nil
}

// prefetch is the supervisor's POST /prefetch (supervisor.js tryClaim, switchTenantVersion): fetch and verify
// BEFORE a lease is burned or an old version stopped. Here it also derives and stores the mapping, so the launch
// that follows reads verified bytes and never the network.
func (s *server) prefetch(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Image  string              `json:"image"`
		Derive *catalog.Derivation `json:"derive"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<16))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&b); err != nil {
		s.json(w, 400, map[string]any{"error": "bad request: " + err.Error()})
		return
	}
	if !strings.HasPrefix(b.Image, "ipfs://") {
		s.json(w, 400, map[string]any{"error": "prefetch takes an ipfs://<cid> app reference"})
		return
	}
	t0 := time.Now()
	raw, record, code, err := s.bundleFor(r.Context(), b.Image, b.Derive)
	if err != nil {
		s.json(w, code, map[string]any{"error": err.Error()})
		return
	}
	id := contract.AppID(raw)
	_, comp, _ := contract.Parse(raw)
	s.json(w, 200, map[string]any{"ok": true, "bytes": len(comp), "seconds": time.Since(t0).Round(100 * time.Millisecond).Seconds(),
		"appId": hex.EncodeToString(id[:]), "recordSha256": record, "componentSha256": componentSha(comp),
		"bundleBytes": len(raw)})
}

func (s *server) set(v *vm, f func()) {
	s.mu.Lock()
	f()
	s.mu.Unlock()
}

// fail records why a start failed and reclaims whatever it had built. The record stays, status "failed", until
// the supervisor deletes it - instanceAlive must SEE the failure to act on it.
func (s *server) fail(v *vm, err error) {
	v.lc.FailStart()
	s.set(v, func() { v.Status, v.Error = "failed", err.Error() })
	v.lc.Reclaim(func() { s.reclaim(v) })
}

func (s *server) launch(v *vm) {
	defer s.launching.Done()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	image, meas, err := s.L.Build(ctx, filepath.Join(v.workdir, "app.bundle"), v.workdir, v.Vcpus)
	if err != nil {
		s.fail(v, fmt.Errorf("build: %w", err))
		return
	}
	s.set(v, func() { v.Measurement = meas })
	unit, err := s.L.Start(ctx, image, v.ID, v.workdir, v.Vcpus, v.MemMiB, v.CPUPct, v.HostData, v.cid)
	cid := v.cid // chosen at create (release.go), so the ticket service knows this guest before it serves
	s.set(v, func() { v.unit = unit })
	if err != nil {
		s.fail(v, fmt.Errorf("start: %w", err))
		return
	}
	port, stop, err := s.L.Forward(ctx, cid, v.workdir)
	s.set(v, func() { v.stopFwd = stop })
	if err != nil {
		s.fail(v, fmt.Errorf("forward: %w", err))
		return
	}
	s.set(v, func() { v.HostPort = port })
	verdict, keySha, err := s.L.Verify(ctx, port, meas, v.AppID, v.HostData, v.workdir)
	if err == nil && !isHex(keySha, 32) {
		err = fmt.Errorf("the verifier reported no transport key hash (%q)", keySha)
	}
	if err != nil {
		s.fail(v, fmt.Errorf("the guest did not attest as this app: %w", err))
		return
	}
	// A delete that arrived during startup was recorded by the lifecycle and is honoured NOW, before the guest
	// is ever reported running.
	if why := v.lc.FinishStart(); why != "" {
		if v.lc.RequestEnd(why) {
			v.lc.Reclaim(func() { s.reclaim(v) })
		}
		s.remove(v)
		return
	}
	s.set(v, func() { v.Status, v.Verdict, v.TransportKeySha256 = "running", verdict, keySha })
	s.persistRunning(v) // adoptable after a guestd restart (persist.go)
}

// reclaim is what an end DOES. The lifecycle decides when, exactly once.
func (s *server) reclaim(v *vm) {
	s.mu.Lock()
	stop, unit := v.stopFwd, v.unit
	open := v.splices
	v.splices = nil
	s.mu.Unlock()
	// every spliced connection ends with its guest: nothing keeps talking to an instance that is gone
	for sp := range open {
		sp.close("the instance ended")
	}
	if stop != nil {
		stop()
	}
	if unit != "" {
		_ = s.L.Stop(v.ID, v.workdir)
	}
	// a failed start keeps its reason (serial tail, build/launch/verify logs), bounded (persist.go)
	s.mu.Lock()
	failed := v.Status == "failed"
	s.mu.Unlock()
	if failed {
		s.preserveFailed(v)
	}
	// the bundle and the image are the tenant's; nothing of them stays on this host
	_ = os.RemoveAll(v.workdir)
	// only now is its room free again (pool.go): its unit is stopped, so nothing of it still runs on the host
	s.set(v, func() { v.reclaimed = true })
}

func (s *server) remove(v *vm) {
	s.mu.Lock()
	delete(s.vms, v.ID)
	s.mu.Unlock()
}

// destroy: 200 once the guest is gone (or already was), 202 while startup still owns it. The supervisor treats
// only 200/404 as a confirmed stop, so a 202 hands the rest to its reconciler, which finds the record gone.
func (s *server) destroy(w http.ResponseWriter, v *vm) {
	if v.lc.RequestEnd("deleted") {
		v.lc.Reclaim(func() { s.reclaim(v) })
		s.remove(v)
		s.json(w, 200, map[string]any{"id": v.ID, "status": "deleted"})
		return
	}
	switch v.lc.State() {
	case contract.Starting:
		s.json(w, 202, map[string]any{"id": v.ID, "status": "stopping",
			"note": "startup owns the guest and will end it when it finishes"})
	default: // failed, or ended by another path: its resources are already reclaimed
		v.lc.Reclaim(func() { s.reclaim(v) })
		s.remove(v)
		s.json(w, 200, map[string]any{"id": v.ID, "status": "deleted"})
	}
}

func (s *server) lease(w http.ResponseWriter, r *http.Request) {
	var b struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&b); err != nil {
		s.json(w, 400, map[string]any{"error": err.Error()})
		return
	}
	want := map[string]bool{}
	for _, id := range b.IDs {
		want[id] = true
	}
	now := s.Now()
	extended, unvouched := []string{}, []map[string]any{}
	s.mu.Lock()
	s.lastBeat = now
	for _, v := range s.vms {
		if v.Status != "starting" && v.Status != "running" {
			continue
		}
		if want[v.Name] {
			v.leaseUntil = now.Add(s.LeaseTTL)
			extended = append(extended, v.Name)
		} else {
			unvouched = append(unvouched, map[string]any{"id": v.Name,
				"expiresIn": v.leaseUntil.Sub(now).Round(100 * time.Millisecond).Seconds()})
		}
	}
	s.mu.Unlock()
	s.json(w, 200, map[string]any{"extended": extended, "unvouched": unvouched, "ttlSec": s.LeaseTTL.Seconds()})
}

// leaseExpired is the dead-man decision, with the wasm-manager's rules: nothing is reaped until the supervisor
// has been heard from at all, and nothing while it has been silent - silence is not evidence about any tenant.
func (s *server) leaseExpired(now time.Time) []*vm {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastBeat.IsZero() || now.Sub(s.lastBeat) > s.Silence {
		return nil
	}
	var out []*vm
	for _, v := range s.vms {
		if (v.Status == "starting" || v.Status == "running") && v.leaseUntil.Before(now) {
			out = append(out, v)
		}
	}
	return out
}

// tick runs the two things nobody asks for: guests that died, and leases nobody renewed.
func (s *server) tick() {
	s.mu.Lock()
	var running []*vm
	for _, v := range s.vms {
		if v.Status == "running" {
			running = append(running, v)
		}
	}
	s.mu.Unlock()
	for _, v := range running {
		if !s.L.Alive(v.unit) && v.lc.RequestEnd("the guest exited") {
			s.set(v, func() { v.Status, v.Error = "failed", "the guest exited" })
			v.lc.Reclaim(func() { s.reclaim(v) })
		}
	}
	for _, v := range s.leaseExpired(s.Now()) {
		if v.lc.RequestEnd("lease lapsed") {
			v.lc.Reclaim(func() { s.reclaim(v) })
			s.remove(v)
		}
	}
}
