package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"log"
	"net"
	"strings"
	"sync"
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
		tk, _, err := r.s.takeTicket(ctx, cid)
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
	_, a := r.create(name(1), p)
	_, b := r.create(name(2), p)
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
	if _, _, err := r.s.takeTicket(context.Background(), 4242); err == nil {
		t.Fatal("a CID guestd did not launch was served")
	}
}

// the ticket may also come with the create request, for a guest that then takes it at boot without waiting
func TestATicketInTheCreateRequestIsHandedAtBoot(t *testing.T) {
	r, g := releaseRig(t, time.Second)
	p, _ := r.bundle("A", contract.Policy{})
	body := map[string]any{"image": "file://" + p, "name": name(3), "ticket": b64('c')}
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
	if code, _ := off.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": name(1), "ticket": b64('a')}); code != 422 {
		t.Fatalf("a ticket with -release off: %d", code)
	}
	if code, _ := off.do("POST", "/vms/gd00000000/ticket", map[string]any{"ticket": b64('a')}); code != 422 {
		t.Fatalf("POST ticket with -release off: %d", code)
	}
	r, _ := releaseRig(t, time.Second)
	for what, body := range map[string]map[string]any{
		"a ticket for a name that is no deployment id": {"image": "file://" + p, "name": "lab-guest", "ticket": b64('a')},
		"a short ticket":          {"image": "file://" + p, "name": name(2), "ticket": base64.StdEncoding.EncodeToString([]byte("short"))},
		"a ticket not base64":     {"image": "file://" + p, "name": name(2), "ticket": "%%%"},
		"config beside a ticket":  {"image": "file://" + p, "name": name(2), "ticket": b64('a'), "config": `{"a":1}`},
		"secrets beside a ticket": {"image": "file://" + p, "name": name(2), "ticket": b64('a'), "secrets": map[string]any{"K": "v"}},
	} {
		if code, _ := r.do("POST", "/vms", body); code != 422 {
			t.Fatalf("%s: %d", what, code)
		}
	}
	if code, _ := r.do("POST", "/vms/gdnothere/ticket", map[string]any{"ticket": b64('a')}); code != 404 {
		t.Fatalf("a ticket for no instance: %d", code)
	}
}

// enclave-63's invariant 4: the CID guestd chooses avoids every guest it holds, ADOPTED ones included, and is the
// CID the guest is started with
func TestTheCIDAvoidsEveryHeldGuest(t *testing.T) {
	r, _ := releaseRig(t, 50*time.Millisecond)
	r.s.mu.Lock()
	r.s.vms["gdadopted"] = &vm{ID: "gdadopted", Name: name(9), Status: "running", cid: 70000, HostData: hostDataFor(name(9)),
		lc: contract.NewLifecycle(contract.Running)}
	draws := []uint32{70000, 5, 70000, 70001}
	r.s.drawCID = func() uint32 { c := draws[0]; draws = draws[1:]; return c }
	r.s.mu.Unlock()
	p, _ := r.bundle("A", contract.Policy{})
	_, v := r.create(name(4), p)
	r.s.launching.Wait()
	if x := r.vm(v["id"].(string)); x.cid != 70001 {
		t.Fatalf("chose CID %d (the adopted guest holds 70000; 5 is out of range)", x.cid)
	}
	r.f.mu.Lock()
	defer r.f.mu.Unlock()
	if len(r.f.cids) != 1 || r.f.cids[0] != 70001 {
		t.Fatalf("the guest was started with %v", r.f.cids)
	}
}

func TestEgressAdmitsOnlyLiveDeploymentGuests(t *testing.T) {
	r, _ := releaseRig(t, 50*time.Millisecond)
	r.s.mu.Lock()
	r.s.vms["a"] = &vm{ID: "a", Status: "running", cid: 70010, HostData: hostDataFor(name(1)), lc: contract.NewLifecycle(contract.Running)}
	r.s.vms["lab"] = &vm{ID: "lab", Status: "running", cid: 70011, lc: contract.NewLifecycle(contract.Running)}
	ended := contract.NewLifecycle(contract.Running)
	ended.RequestEnd("test")
	r.s.vms["gone"] = &vm{ID: "gone", Status: "running", cid: 70012, HostData: hostDataFor(name(2)), lc: ended}
	r.s.vms["failed"] = &vm{ID: "failed", Status: "failed", cid: 70013, HostData: hostDataFor(name(3)), lc: contract.NewLifecycle(contract.Starting)}
	r.s.mu.Unlock()
	for cid, want := range map[uint32]bool{70010: true, 70011: false, 70012: false, 70013: false, 99999: false, 0: false} {
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
	_, v := r.create(name(5), p)
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

func TestHealthStatesRelease(t *testing.T) {
	for _, on := range []bool{false, true} {
		r := newRig(t)
		r.s.Release = on
		_, h := r.do("GET", "/health", nil)
		sup := h["supports"].(map[string]any)
		if sup["release"] != on || sup["config"] != false || sup["secrets"] != false {
			t.Fatalf("-release %v: supports %v", on, sup)
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
