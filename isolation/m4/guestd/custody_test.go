package main

import (
	"context"
	"encoding/hex"
	"io"
	"log"
	"net"
	"reflect"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/release"
)

func v1req(id, binding [32]byte) release.AuthRequest {
	return release.AuthRequest{V: 1, ID: id, Binding: binding}
}

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
	if _, _, err := r.s.takeCustodyAuth(context.Background(), 4242, v1req(id, binding), nil); err == nil {
		t.Fatal("a CID guestd did not launch was served")
	}
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, v1req(other, binding), nil); err == nil || !strings.Contains(err.Error(), "another deployment") {
		t.Fatalf("another deployment: %v", err)
	}
	type res struct {
		a   release.CustodyAuth
		err error
	}
	done := make(chan res, 1)
	go func() {
		a, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, v1req(id, binding), nil)
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
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, v1req(id, binding), nil); err == nil || !strings.Contains(err.Error(), "no custody authorization") {
		t.Fatalf("timeout: %v", err)
	}
}

// custody v2: the guest's custody-auth-v2 line over the service (TCP stands in for vsock) shows as
// awaitingCustodyAuth {v: 2, vault, binding}; the supervisor's POST for that binding reaches the guest as in v1.
func TestCustodyAuthV2ReportsTheVault(t *testing.T) {
	r, _ := releaseRig(t, 2*time.Second)
	p, _ := r.bundle("A", contract.Policy{})
	code, out := r.do("POST", "/vms", map[string]any{"image": "file://" + p, "name": name(6), "release": true, "ticket": b64('c')})
	if code != 201 {
		t.Fatalf("%d %v", code, out)
	}
	r.s.launching.Wait()
	v := r.vm(out["id"].(string))
	if v.Status != "running" {
		t.Fatalf("%s %s", v.Status, v.Error)
	}
	var id, binding [32]byte
	var vault [20]byte
	hd, _ := hex.DecodeString(v.HostData)
	copy(id[:], hd)
	binding[0], binding[31] = 0xb2, 0x9e
	vault[0], vault[19] = 0x7a, 0x01
	// a v2 request naming no well-formed vault is refused at once
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, release.AuthRequest{V: 2, Vault: "0x1234", ID: id, Binding: binding}, nil); err == nil {
		t.Fatal("a v2 request without a vault was taken")
	}
	if _, _, err := r.s.takeCustodyAuth(context.Background(), v.cid, release.AuthRequest{V: 1, Vault: "0x" + strings.Repeat("7a", 20), ID: id, Binding: binding}, nil); err == nil {
		t.Fatal("a v1 request with a vault was taken")
	}

	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.s.serveCustodyAuth(ctx, l, func(net.Conn) uint32 { return v.cid }, log.New(io.Discard, "", 0))
	c, err := net.Dial("tcp", l.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := release.WriteAuthRequestV2(c, vault, id, binding); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"v": float64(2), "vault": "0x7a" + strings.Repeat("00", 18) + "01", "binding": hex.EncodeToString(binding[:])}
	waitFor(t, func() bool {
		_, g := r.do("GET", "/vms/"+v.ID, nil)
		got, _ := g["awaitingCustodyAuth"].(map[string]any)
		return reflect.DeepEqual(got, want)
	})
	sig := "0x" + strings.Repeat("5b", 65)
	if code, _ := r.do("POST", "/vms/"+v.ID+"/custody-auth", map[string]any{"binding": hex.EncodeToString(binding[:]), "endpoint": "https://api.enclave.host/t/a", "sig": sig, "expiry": 1800000000}); code != 202 {
		t.Fatalf("the right binding: %d", code)
	}
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	a, err := release.ReadAuth(c)
	if err != nil || a.Sig != sig || a.Endpoint != "https://api.enclave.host/t/a" || a.Expiry != 1800000000 {
		t.Fatalf("delivered %+v %v", a, err)
	}
	waitFor(t, func() bool { _, g := r.do("GET", "/vms/"+v.ID, nil); return g["awaitingCustodyAuth"] == nil })
}
