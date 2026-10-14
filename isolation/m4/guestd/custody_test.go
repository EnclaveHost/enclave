package main

import (
	"context"
	"encoding/hex"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/release"
)

// The custody authorization goes ONLY to the guest guestd launched for that instance, only for its own deployment, and
// only for the binding that guest is waiting on.
func TestCustodyAuthReachesOnlyItsOwnGuestAndBinding(t *testing.T) {
	r, _ := releaseRig(t, 2*time.Second)
	p, _ := r.bundle("A", contract.Policy{})
	body := map[string]any{"image": "file://" + p, "name": name(5), "release": true, "ticket": b64('c')}
	code, out := r.do("POST", "/vms", body)
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	r.s.launching.Wait()
	v := r.vm(out["id"].(string))
	if v.Status != "running" {
		t.Fatalf("%s %s", v.Status, v.Error)
	}
	var id, other, binding [32]byte
	hd, _ := hex.DecodeString(v.HostData)
	copy(id[:], hd)
	other[0] = 0xee
	binding[0], binding[31] = 0xb1, 0x9d
	// a CID guestd did not launch, and the right CID naming another deployment, are refused at once
	if _, _, err := r.s.takeCustodyAuth(context.Background(), 4242, id, binding, nil); err == nil {
		t.Fatal("a CID guestd did not launch was served")
	}
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, other, binding, nil); err == nil || !strings.Contains(err.Error(), "another deployment") {
		t.Fatalf("another deployment: %v", err)
	}
	type res struct {
		a   release.CustodyAuth
		err error
	}
	done := make(chan res, 1)
	go func() {
		a, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, id, binding, nil)
		done <- res{a, err}
	}()
	waitFor(t, func() bool {
		_, g := r.do("GET", "/vms/"+v.ID, nil)
		return g["awaitingCustodyAuth"] == hex.EncodeToString(binding[:])
	})
	sig := "0x" + strings.Repeat("5a", 65)
	wrong := strings.Repeat("00", 32)
	if code, _ := r.do("POST", "/vms/"+v.ID+"/custody-auth", map[string]any{"binding": wrong, "endpoint": "https://api.enclave.host/t/a", "sig": sig, "expiry": 1800000000}); code != 409 {
		t.Fatalf("a signature for another binding: %d", code)
	}
	if code, _ := r.do("POST", "/vms/"+v.ID+"/custody-auth", map[string]any{"binding": hex.EncodeToString(binding[:]), "endpoint": "https://api.enclave.host/t/a", "sig": "0x12", "expiry": 1800000000}); code != 422 {
		t.Fatalf("a malformed signature: %d", code)
	}
	if code, _ := r.do("POST", "/vms/"+v.ID+"/custody-auth", map[string]any{"binding": hex.EncodeToString(binding[:]), "endpoint": "https://api.enclave.host/t/a", "sig": sig, "expiry": 1800000000}); code != 202 {
		t.Fatalf("the right binding: %d", code)
	}
	got := <-done
	if got.err != nil || got.a.Sig != sig || got.a.Endpoint != "https://api.enclave.host/t/a" || got.a.Expiry != 1800000000 {
		t.Fatalf("delivered %+v %v", got.a, got.err)
	}
	if _, g := r.do("GET", "/vms/"+v.ID, nil); g["awaitingCustodyAuth"] != nil {
		t.Fatal("still shown as waiting after delivery")
	}
	// no authorization arrives: the hold ends
	r.s.TicketHold = 300 * time.Millisecond
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, id, binding, nil); err == nil || !strings.Contains(err.Error(), "no custody authorization") {
		t.Fatalf("timeout: %v", err)
	}
}
