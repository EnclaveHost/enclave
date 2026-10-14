package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/release"
)

func b64(b byte) string {
	return base64.StdEncoding.EncodeToString([]byte(strings.Repeat(string(rune(b)), 32)))
}

// the guests' side of the ticket service in these tests: each booting guest takes its ticket by the CID guestd gave
// it, as the front does over vsock (release.go takeTicket), and records what it got
type guests struct {
	mu  sync.Mutex
	got map[uint32]release.Ticket
}

func releaseRig(t *testing.T, hold time.Duration) (*rig, *guests) {
	r := newRig(t)
	r.s.Release, r.s.TicketHold = true, hold
	g := &guests{got: map[uint32]release.Ticket{}}
	r.f.guest = func(ctx context.Context, cid uint32, hostData string) error {
		if hostData == "" {
			return nil // a lab guest: no deployment, no ticket
		}
		tk, _, err := r.s.takeTicket(ctx, cid, nil)
		if err != nil {
			return err
		}
		g.mu.Lock()
		g.got[cid] = tk
		g.mu.Unlock()
		return nil
	}
	return r, g
}

// createRelease is the supervisor's create for a deployment the relay lists for the release
func (r *rig) createRelease(name, path string) (int, map[string]any) {
	return r.do("POST", "/vms", map[string]any{"image": "file://" + path, "name": name, "release": true})
}

func (r *rig) vm(id string) *vm {
	r.s.mu.Lock()
	defer r.s.mu.Unlock()
	return r.s.vms[id]
}

// enclave-99: a ticket goes ONLY to the guest guestd launched for that instance. Two deployments wait; the ticket
// posted for A reaches A's CID, bound to A's deployment id, and B - still waiting - never sees it.
func TestATicketGoesOnlyToItsOwnInstancesGuest(t *testing.T) {
	r, g := releaseRig(t, 400*time.Millisecond)
	p, _ := r.bundle("A", contract.Policy{})
	_, a := r.createRelease(name(1), p)
	_, b := r.createRelease(name(2), p)
	aID, bID := a["id"].(string), b["id"].(string)
	waitFor(t, func() bool {
		_, va := r.do("GET", "/vms/"+aID, nil)
		_, vb := r.do("GET", "/vms/"+bID, nil)
		return va["awaitingTicket"] == true && vb["awaitingTicket"] == true
	})
	if code, _ := r.do("POST", "/vms/"+aID+"/ticket", map[string]any{"ticket": b64('a')}); code != 202 {
		t.Fatalf("posting A's ticket: %d", code)
	}
	r.s.launching.Wait()
	va, vb := r.vm(aID), r.vm(bID)
	g.mu.Lock()
	defer g.mu.Unlock()
	ta, gotA := g.got[va.cid]
	if !gotA || hex.EncodeToString(ta.ID[:]) != va.HostData || ta.Ticket[0] != 'a' {
		t.Fatalf("A's guest got %+v (want A's deployment and A's ticket)", ta)
	}
	if _, gotB := g.got[vb.cid]; gotB || vb.Status != "failed" {
		t.Fatalf("B's guest got a ticket, or B did not end without one: %v %s", gotB, vb.Status)
	}
	if va.Status != "running" {
		t.Fatalf("A: %s %s", va.Status, va.Error)
	}
	// a CID guestd did not launch (the control CVM, another VM) gets nothing, at once
	if _, _, err := r.s.takeTicket(context.Background(), 4242, nil); err == nil {
		t.Fatal("a CID guestd did not launch was served")
	}
}

// the ticket may also come with the create request, for a guest that then takes it at boot without waiting
func TestATicketInTheCreateRequestIsHandedAtBoot(t *testing.T) {
	r, g := releaseRig(t, time.Second)
	p, _ := r.bundle("A", contract.Policy{})
	body := map[string]any{"image": "file://" + p, "name": name(3), "release": true, "ticket": b64('c')}
	code, v := r.do("POST", "/vms", body)
	if code != 201 {
		t.Fatalf("%d %v", code, v)
	}
	r.s.launching.Wait()
	x := r.vm(v["id"].(string))
	g.mu.Lock()
	defer g.mu.Unlock()
	if x.Status != "running" || g.got[x.cid].Ticket[0] != 'c' {
		t.Fatalf("%s %+v", x.Status, g.got[x.cid])
	}
	// a guest reads one ticket, at boot: a later one is refused, not queued
	if code, _ := r.do("POST", "/vms/"+x.ID+"/ticket", map[string]any{"ticket": b64('d')}); code != 409 {
		t.Fatalf("a ticket for a running guest: %d", code)
	}
}

func TestTicketRefusals(t *testing.T) {
	off := newRig(t)
	p, _ := off.bundle("A", contract.Policy{})
	for what, body := range map[string]map[string]any{
		"a release guest with -release off": {"image": "file://" + p, "name": name(1), "release": true},
		"a ticket with -release off":        {"image": "file://" + p, "name": name(1), "release": true, "ticket": b64('a')},
	} {
		if code, _ := off.do("POST", "/vms", body); code != 422 {
			t.Fatalf("%s: %d", what, code)
		}
	}
	if code, _ := off.do("POST", "/vms/gd00000000/ticket", map[string]any{"ticket": b64('a')}); code != 422 {
		t.Fatalf("POST ticket with -release off: %d", code)
	}
	// no legacy tree: a deployment that is not a release guest cannot be built at all
	nolegacy, _ := releaseRig(t, time.Second)
	if code, _ := nolegacy.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": name(2)}); code != 422 {
		t.Fatalf("a non-release deployment with no legacy image: %d", code)
	}
	// with one, so each refusal below is refused for ITS reason and not for the missing legacy tree
	r, _ := releaseRig(t, time.Second)
	r.s.Legacy = newFake()
	for what, body := range map[string]map[string]any{
		"a release guest for a name that is no deployment id": {"image": "file://" + p, "name": "lab-guest", "release": true},
		"a ticket for a guest that is not a release guest":    {"image": "file://" + p, "name": name(2), "ticket": b64('a')},
		"a short ticket":          {"image": "file://" + p, "name": name(2), "release": true, "ticket": base64.StdEncoding.EncodeToString([]byte("short"))},
		"a ticket not base64":     {"image": "file://" + p, "name": name(2), "release": true, "ticket": "%%%"},
		"config beside a ticket":  {"image": "file://" + p, "name": name(2), "release": true, "ticket": b64('a'), "config": `{"a":1}`},
		"secrets beside a ticket": {"image": "file://" + p, "name": name(2), "release": true, "ticket": b64('a'), "secrets": map[string]any{"K": "v"}},
	} {
		if code, _ := r.do("POST", "/vms", body); code != 422 {
			t.Fatalf("%s: %d", what, code)
		}
	}
	if code, _ := r.do("POST", "/vms/gdnothere/ticket", map[string]any{"ticket": b64('a')}); code != 404 {
		t.Fatalf("a ticket for no instance: %d", code)
	}
}

// enclave-63's invariant 4: the CID guestd chooses avoids every guest it holds, ADOPTED ones included, is the CID the
// guest is started with, lies in guestd's own band (never the lab band run-domain.sh draws from), and is not reused
// within the quarantine after it was freed (enclave-99)
func TestTheCIDAvoidsEveryHeldGuest(t *testing.T) {
	r, _ := releaseRig(t, 50*time.Millisecond)
	r.s.mu.Lock()
	r.s.vms["gdadopted"] = &vm{ID: "gdadopted", Name: name(9), Status: "running", cid: 140000, HostData: hostDataFor(name(9)),
		lc: contract.NewLifecycle(contract.Running)}
	r.s.freedCIDs = map[uint32]time.Time{140002: r.s.Now().Add(-time.Minute), 140003: r.s.Now().Add(-11 * time.Minute)}
	// held, lab band, held, freed a minute ago, freed long ago (reusable)
	draws := []uint32{140000, 70000, 140000, 140002, 140003}
	r.s.drawCID = func() uint32 { c := draws[0]; draws = draws[1:]; return c }
	r.s.mu.Unlock()
	p, _ := r.bundle("A", contract.Policy{})
	_, v := r.createRelease(name(4), p)
	r.s.launching.Wait()
	if x := r.vm(v["id"].(string)); x.cid != 140003 {
		t.Fatalf("chose CID %d (140000 is held, 70000 is the lab band, 140002 is quarantined)", x.cid)
	}
	r.f.mu.Lock()
	defer r.f.mu.Unlock()
	if len(r.f.cids) != 1 || r.f.cids[0] != 140003 {
		t.Fatalf("the guest was started with %v", r.f.cids)
	}
}

func TestEgressAdmitsOnlyLiveDeploymentGuests(t *testing.T) {
	r, _ := releaseRig(t, 50*time.Millisecond)
	r.s.mu.Lock()
	r.s.vms["a"] = &vm{ID: "a", Status: "running", cid: 70010, HostData: hostDataFor(name(1)), release: true, lc: contract.NewLifecycle(contract.Running)}
	r.s.vms["legacy"] = &vm{ID: "legacy", Status: "running", cid: 70014, HostData: hostDataFor(name(4)), legacy: true, lc: contract.NewLifecycle(contract.Running)}
	r.s.vms["lab"] = &vm{ID: "lab", Status: "running", cid: 70011, lc: contract.NewLifecycle(contract.Running)}
	ended := contract.NewLifecycle(contract.Running)
	ended.RequestEnd("test")
	r.s.vms["gone"] = &vm{ID: "gone", Status: "running", cid: 70012, HostData: hostDataFor(name(2)), release: true, lc: ended}
	r.s.vms["failed"] = &vm{ID: "failed", Status: "failed", cid: 70013, HostData: hostDataFor(name(3)), release: true, lc: contract.NewLifecycle(contract.Starting)}
	r.s.mu.Unlock()
	for cid, want := range map[uint32]bool{70010: true, 70011: false, 70012: false, 70013: false, 70014: false, 99999: false, 0: false} {
		if r.s.admitCID(cid) != want {
			t.Fatalf("CID %d: admit %v", cid, !want)
		}
	}
}

// the ticket service on a socket: one ticket-v1 line to the guest at the CID, nothing to any other, and it will not
// start without a way to tell guests apart
func TestTheTicketServiceWritesTheLineToThatGuestOnly(t *testing.T) {
	r, _ := releaseRig(t, 300*time.Millisecond)
	r.f.guest = nil                     // the guest's boot is the socket below
	r.f.startGate = make(chan struct{}) // and the instance stays "starting" until it has read its ticket
	p, _ := r.bundle("A", contract.Policy{})
	_, v := r.createRelease(name(5), p)
	x := r.vm(v["id"].(string))
	if code, _ := r.do("POST", "/vms/"+x.ID+"/ticket", map[string]any{"ticket": b64('e')}); code != 202 {
		t.Fatalf("post: %d", code)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	next := uint32(4242) // the first connection comes from a CID guestd did not launch
	cidOf := func(net.Conn) uint32 { mu.Lock(); defer mu.Unlock(); c := next; next = x.cid; return c }
	var lg strings.Builder
	var lgMu sync.Mutex
	go r.s.serveTickets(ctx, l, cidOf, logTo(&lg, &lgMu))
	read := func() (release.Ticket, error) {
		c, err := net.Dial("tcp", l.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer c.Close()
		c.SetDeadline(time.Now().Add(5 * time.Second))
		return release.ReadTicket(c)
	}
	if _, err := read(); err == nil {
		t.Fatal("a CID guestd did not launch read a ticket")
	}
	tk, err := read()
	if err != nil || tk.Ticket[0] != 'e' || hex.EncodeToString(tk.ID[:]) != x.HostData {
		t.Fatalf("the guest's ticket: %+v %v", tk, err)
	}
	close(r.f.startGate)
	r.s.launching.Wait()
	lgMu.Lock()
	logged := lg.String()
	lgMu.Unlock()
	if strings.Contains(logged, b64('e')) || strings.Contains(logged, strings.Repeat("65", 32)) {
		t.Fatalf("the ticket service logged a ticket: %s", logged)
	}
	// no way to tell guests apart: it must refuse at once (bounded, so a service that starts anyway fails this test
	// instead of hanging it)
	l2, _ := net.Listen("tcp", "127.0.0.1:0")
	defer l2.Close()
	bounded, stop := context.WithTimeout(ctx, 300*time.Millisecond)
	defer stop()
	if err := r.s.serveTickets(bounded, l2, nil, logTo(&lg, &lgMu)); err == nil {
		t.Fatal("a ticket service with no cidOf started")
	}
}

func TestHealthStatesReleaseAndLegacy(t *testing.T) {
	for _, c := range []struct{ release, legacy, wantLegacy bool }{{false, false, false}, {true, false, false}, {true, true, true}, {false, true, false}} {
		r := newRig(t)
		r.s.Release = c.release
		if c.legacy {
			r.s.Legacy = newFake()
		}
		_, h := r.do("GET", "/health", nil)
		sup := h["supports"].(map[string]any)
		if sup["release"] != c.release || sup["legacyImage"] != c.wantLegacy || sup["config"] != false || sup["secrets"] != false {
			t.Fatalf("%+v: supports %v", c, sup)
		}
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type logWriter func([]byte) (int, error)

func (w logWriter) Write(p []byte) (int, error) { return w(p) }

func logTo(b *strings.Builder, mu *sync.Mutex) *log.Logger {
	return log.New(logWriter(func(p []byte) (int, error) { mu.Lock(); defer mu.Unlock(); return b.Write(p) }), "", 0)
}

// d1's rollout option (i): on a -release guestd the image is chosen PER DEPLOYMENT. A deployment the supervisor marks
// release is built from this tree and gets a ticket slot and egress; any other deployment is built by the LEGACY
// launcher (the previous tree's image, unchanged) and gets neither; a lab guest (no deployment id) is this tree's,
// with no release. Adoption keeps what each one is.
func TestTheImageIsChosenPerDeployment(t *testing.T) {
	r, _ := releaseRig(t, 200*time.Millisecond)
	old := newFake()
	r.s.Legacy = old
	r.f.guest = nil // no boots here: which launcher built what, and what each instance is, is the point
	p, _ := r.bundle("A", contract.Policy{})
	_, rel := r.createRelease(name(1), p)
	_, leg := r.create(name(2), p)
	_, lab := r.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": "lab-guest"})
	r.s.launching.Wait()
	x, y, z := r.vm(rel["id"].(string)), r.vm(leg["id"].(string)), r.vm(lab["id"].(string))
	r.f.mu.Lock()
	newBuilds := r.f.builds
	r.f.mu.Unlock()
	old.mu.Lock()
	oldBuilds, oldCIDs := old.builds, append([]uint32(nil), old.cids...)
	old.mu.Unlock()
	if newBuilds != 2 || oldBuilds != 1 || len(oldCIDs) != 1 || oldCIDs[0] != y.cid {
		t.Fatalf("this tree built %d (want the release and the lab guest), the legacy tree %d with CIDs %v (want the other deployment, on its chosen CID %d)",
			newBuilds, oldBuilds, oldCIDs, y.cid)
	}
	if !x.release || x.legacy || x.ticket == nil || y.release || !y.legacy || y.ticket != nil || z.release || z.legacy || z.ticket != nil {
		t.Fatalf("release %+v / legacy %+v / lab %+v", [3]bool{x.release, x.legacy, x.ticket != nil},
			[3]bool{y.release, y.legacy, y.ticket != nil}, [3]bool{z.release, z.legacy, z.ticket != nil})
	}
	if _, v := r.do("GET", "/vms/"+x.ID, nil); v["release"] != true || v["legacyImage"] != nil {
		t.Fatalf("the release guest's view: %v", v)
	}
	if _, v := r.do("GET", "/vms/"+y.ID, nil); v["legacyImage"] != true || v["release"] != nil {
		t.Fatalf("the legacy guest's view: %v", v)
	}
	// only the release guest may use egress; the legacy one has no allowlist of its own
	x.Status, y.Status = "running", "running"
	if r.s.admitCID(y.cid) {
		t.Fatal("a legacy guest was admitted to egress")
	}
	// a restart adopts each as what it was: the release guest keeps its egress, the legacy one its label. (One systemd
	// holds both trees' units; the two fakes stand in for it separately, so the legacy unit is marked alive in both.)
	r.f.mu.Lock()
	r.f.alive["unit-"+y.ID] = true
	r.f.mu.Unlock()
	r.s.persistRunning(x)
	r.s.persistRunning(y)
	s2, _, _, _ := r.restart(t)
	s2.mu.Lock()
	ax, ay := s2.vms[x.ID], s2.vms[y.ID]
	s2.mu.Unlock()
	if ax == nil || ay == nil || !ax.release || ax.legacy || ay.release || !ay.legacy {
		t.Fatalf("adoption lost what each guest is: %+v %+v", ax, ay)
	}
	if !s2.admitCID(ax.cid) || s2.admitCID(ay.cid) {
		t.Fatal("after a restart, egress admission changed")
	}
}

// enclave-99's review of 21b41ff6, finding 1: a DELETE during startup only RECORDS the end (startup still owns the
// guest), and from that moment nothing new reaches the guest - not its create-time ticket, not a POSTed one, not egress.
func TestADeleteDuringStartupStopsTicketsAndEgress(t *testing.T) {
	r, g := releaseRig(t, 300*time.Millisecond)
	r.f.startGate = make(chan struct{})
	p, _ := r.bundle("A", contract.Policy{})
	_, a := r.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": name(1), "release": true, "ticket": b64('a')})
	_, b := r.createRelease(name(2), p)
	x, y := r.vm(a["id"].(string)), r.vm(b["id"].(string))
	for _, v := range []*vm{x, y} {
		if code, _ := r.do("DELETE", "/vms/"+v.ID, nil); code != 202 {
			t.Fatalf("a delete during startup: %d", code)
		}
	}
	if _, _, err := r.s.takeTicket(context.Background(), x.cid, nil); err == nil {
		t.Fatal("a deleted guest was handed its create-time ticket")
	}
	if code, _ := r.do("POST", "/vms/"+y.ID+"/ticket", map[string]any{"ticket": b64('b')}); code != 409 {
		t.Fatalf("a ticket for a deleted guest: %d", code)
	}
	x.release, y.release = true, true
	if r.s.admitCID(x.cid) || r.s.admitCID(y.cid) {
		t.Fatal("a deleted guest was admitted to egress")
	}
	close(r.f.startGate)
	r.s.launching.Wait()
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.got) != 0 {
		t.Fatalf("tickets reached deleted guests: %v", g.got)
	}
}

// finding 2: a guest that has left takes nothing - a ticket waiting in its slot stays there, never written to a dead
// socket
func TestAGuestThatLeftTakesNothing(t *testing.T) {
	r, _ := releaseRig(t, time.Second)
	r.f.guest, r.f.startGate = nil, make(chan struct{})
	defer close(r.f.startGate)
	p, _ := r.bundle("A", contract.Policy{})
	_, a := r.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": name(1), "release": true, "ticket": b64('a')})
	x := r.vm(a["id"].(string))
	gone := make(chan struct{})
	close(gone)
	// A ticket in the slot AND a closed connection are both ready at once, and a select picks among ready cases at
	// random, so one call would catch a missing pre-check only by chance (enclave-d1: 14 of 20). Fifty calls must ALL
	// refuse and leave the ticket where it is; without the pre-check that holds with probability about 2^-50.
	for i := 0; i < 50; i++ {
		if _, _, err := r.s.takeTicket(context.Background(), x.cid, gone); err == nil || !strings.Contains(err.Error(), "closed") {
			t.Fatalf("call %d, a guest that had left: %v", i, err)
		}
		r.s.mu.Lock()
		pending, taken, waiting := len(x.ticket), x.ticketTaken, x.awaitingTicket
		r.s.mu.Unlock()
		if pending != 1 || taken || waiting {
			t.Fatalf("call %d: slot %d, taken %v, waiting %v: the ticket must stay in the slot and nothing wait", i, pending, taken, waiting)
		}
	}
	// and a guest that leaves WHILE waiting ends its hold at once, not at TicketHold
	gone2 := make(chan struct{})
	_, b := r.createRelease(name(2), p)
	y := r.vm(b["id"].(string))
	done := make(chan error, 1)
	go func() { _, _, err := r.s.takeTicket(context.Background(), y.cid, gone2); done <- err }()
	waitFor(t, func() bool { r.s.mu.Lock(); defer r.s.mu.Unlock(); return y.awaitingTicket })
	t0 := time.Now()
	close(gone2)
	if err := <-done; err == nil || time.Since(t0) > 500*time.Millisecond {
		t.Fatalf("a guest that left while waiting: %v after %s", err, time.Since(t0))
	}
}

// finding 3: one held connection per guest, one ticket per guest, and a global cap on held connections
func TestOneConnectionAndOneTicketPerGuest(t *testing.T) {
	r, _ := releaseRig(t, 2*time.Second)
	r.f.guest, r.f.startGate = nil, make(chan struct{})
	defer close(r.f.startGate)
	p, _ := r.bundle("A", contract.Policy{})
	_, a := r.createRelease(name(1), p)
	x := r.vm(a["id"].(string))
	first := make(chan error, 1)
	go func() { _, _, err := r.s.takeTicket(context.Background(), x.cid, nil); first <- err }()
	waitFor(t, func() bool { r.s.mu.Lock(); defer r.s.mu.Unlock(); return x.awaitingTicket })
	if _, _, err := r.s.takeTicket(context.Background(), x.cid, nil); err == nil || !strings.Contains(err.Error(), "already holds") {
		t.Fatalf("a second connection for the same guest: %v", err)
	}
	if code, _ := r.do("POST", "/vms/"+x.ID+"/ticket", map[string]any{"ticket": b64('a')}); code != 202 {
		t.Fatalf("post: %d", code)
	}
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if code, _ := r.do("POST", "/vms/"+x.ID+"/ticket", map[string]any{"ticket": b64('b')}); code != 409 {
		t.Fatalf("a second ticket after the first was taken: %d", code)
	}
	if _, _, err := r.s.takeTicket(context.Background(), x.cid, nil); err == nil || !strings.Contains(err.Error(), "already took") {
		t.Fatalf("a connection after the ticket was taken: %v", err)
	}
	// the global cap
	_, b := r.createRelease(name(2), p)
	y := r.vm(b["id"].(string))
	r.s.mu.Lock()
	r.s.held = maxHeld
	r.s.mu.Unlock()
	if _, _, err := r.s.takeTicket(context.Background(), y.cid, nil); err == nil || !strings.Contains(err.Error(), "too many") {
		t.Fatalf("past the global cap: %v", err)
	}
}

// finding 4: a transient accept failure does not end the ticket service (guestd would log.Fatal, and its restart's
// boot sweep would end every starting guest)
type flakyTicketListener struct {
	net.Listener
	fails int
}

func (f *flakyTicketListener) Accept() (net.Conn, error) {
	if f.fails > 0 {
		f.fails--
		return nil, &net.OpError{Op: "accept", Net: "tcp", Err: os.NewSyscallError("accept4", syscall.EMFILE)}
	}
	return f.Listener.Accept()
}

func TestATransientAcceptFailureDoesNotEndTheTicketService(t *testing.T) {
	r, _ := releaseRig(t, time.Second)
	inner, _ := net.Listen("tcp", "127.0.0.1:0")
	var lg strings.Builder
	var mu sync.Mutex
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- r.s.serveTickets(ctx, &flakyTicketListener{Listener: inner, fails: 3}, func(net.Conn) uint32 { return 4242 }, logTo(&lg, &mu))
	}()
	c, err := net.Dial("tcp", inner.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	c.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := release.ReadTicket(c); err == nil {
		t.Fatal("an unknown CID read a ticket")
	}
	c.Close()
	waitFor(t, func() bool { mu.Lock(); defer mu.Unlock(); return strings.Contains(lg.String(), "guest 4242") })
	mu.Lock()
	n := strings.Count(lg.String(), "accept:")
	mu.Unlock()
	cancel()
	if err := <-done; err != nil || n != 3 {
		t.Fatalf("service ended with %v after %d accept notices (want nil and 3)", err, n)
	}
}
