package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// restart builds a NEW server over the same root and launcher, as a guestd restart does, and runs its boot adoption.
func (r *rig) restart(t *testing.T) (*server, map[string]bool, []string, []string) {
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	keep, adopted, dropped := s2.adoptOnBoot(context.Background())
	return s2, keep, adopted, dropped
}

func TestARestartAdoptsTheSameGuestAndNothingElse(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	mk := func(name string) string {
		code, body := r.create(name, p)
		if code != 201 {
			t.Fatalf("create %s: %d %v", name, code, body)
		}
		r.s.launching.Wait()
		return body["id"].(string)
	}
	live := mk("0x" + strings.Repeat("aa", 32))
	dead := mk("0x" + strings.Repeat("bb", 32))
	other := mk("0x" + strings.Repeat("cc", 32))
	corrupt := mk("0x" + strings.Repeat("dd", 32))
	_ = os.WriteFile(filepath.Join(r.s.Root, corrupt, recordFile), []byte("{not json"), 0o600)
	stray := filepath.Join(r.s.Root, "gd0badf00d") // a workdir that never became running: no record
	_ = os.MkdirAll(stray, 0o700)
	r.f.mu.Lock()
	r.f.alive["unit-"+dead] = false // its guest exited while guestd was down
	r.f.mu.Unlock()
	// "other" will present a different key on re-verification: not the same guest
	s2 := newServer(r.f, r.s.Root)
	s2.Now = r.s.Now
	r.f.mu.Lock()
	r.f.keyOverride = ""
	r.f.mu.Unlock()
	keyFor := map[string]string{}
	// adopt one at a time so the key override applies to "other" only
	for _, id := range []string{live, dead, corrupt} {
		keyFor[id] = s2.adoptOne(context.Background(), filepath.Join(r.s.Root, id))
	}
	r.f.mu.Lock()
	r.f.keyOverride = strings.Repeat("99", 32)
	r.f.mu.Unlock()
	keyFor[other] = s2.adoptOne(context.Background(), filepath.Join(r.s.Root, other))
	keyFor["stray"] = s2.adoptOne(context.Background(), stray)
	if keyFor[live] != "" {
		t.Fatalf("the live guest that verifies as itself was not adopted: %s", keyFor[live])
	}
	for id, want := range map[string]string{dead: "no longer active", corrupt: "unreadable", other: "not the same guest", "stray": "no instance record"} {
		if !strings.Contains(keyFor[id], want) {
			t.Errorf("%s: got %q, want it dropped as %q", id, keyFor[id], want)
		}
	}
	v := s2.vms[live]
	if v == nil || v.Status != "running" || v.lc.State() != contract.Running || v.TransportKeySha256 != fakeKeySha || v.Name != "0x"+strings.Repeat("aa", 32) ||
		v.HostData != strings.Repeat("aa", 32) || v.HostPort == 0 {
		t.Fatalf("the adopted record: %+v", v)
	}
	if len(s2.vms) != 1 {
		t.Fatalf("only the one guest may be adopted: %d", len(s2.vms))
	}
}

func TestBootAdoptionEndsAndScrubsWhatItDoesNotAdopt(t *testing.T) {
	r := newRig(t)
	p, _ := r.bundle("A", contract.Policy{})
	code, body := r.create("0x"+strings.Repeat("aa", 32), p)
	if code != 201 {
		t.Fatal(code)
	}
	r.s.launching.Wait()
	keepID := body["id"].(string)
	code, body = r.create("0x"+strings.Repeat("bb", 32), p)
	r.s.launching.Wait()
	dropID := body["id"].(string)
	r.f.mu.Lock()
	r.f.alive["unit-"+dropID] = false
	r.f.mu.Unlock()
	s2, keep, adopted, dropped := r.restart(t)
	if fmt.Sprint(adopted) != "["+keepID+"]" || len(dropped) != 1 || !keep["unit-"+keepID] || keep["unit-"+dropID] {
		t.Fatalf("adopted %v dropped %v keep %v", adopted, dropped, keep)
	}
	if _, err := os.Stat(filepath.Join(r.s.Root, dropID)); !os.IsNotExist(err) {
		t.Fatal("a dropped guest's workdir was not scrubbed")
	}
	if r.f.stopsOf(dropID) != 1 {
		t.Fatalf("a dropped guest with a record was not stopped: %d", r.f.stopsOf(dropID))
	}
	// the adopted guest serves the /vms contract as before, and its dead-man lease is inert until a heartbeat
	if s2.vms[keepID] == nil || len(s2.leaseExpired(s2.Now().Add(24*3600*1e9))) != 0 {
		t.Fatal("the adopted guest is missing or its lease is not inert before the first heartbeat")
	}
}

func TestAFailedStartKeepsItsReason(t *testing.T) {
	r := newRig(t)
	r.f.serial = "DOM snp=1\nError: no exported instance named `wasi:http/incoming-handler@0.2.12`\nDOM ERROR app exited status=1\n"
	r.f.verifyErr = fmt.Errorf("VERDICT reject reason=\"the domain never answered\"")
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0x"+strings.Repeat("aa", 32), p)
	r.s.launching.Wait()
	id := body["id"].(string)
	if _, err := os.Stat(filepath.Join(r.s.Root, id)); !os.IsNotExist(err) {
		t.Fatal("the failed start's workdir was kept (the bundle and image are the tenant's)")
	}
	b, err := os.ReadFile(filepath.Join(r.s.Root, "failed", id, id+".serial"))
	if err != nil || !strings.Contains(string(b), "no exported instance") {
		t.Fatalf("the serial console was not preserved: %v %q", err, b)
	}
	code, logs := r.do("GET", "/vms/"+id+"/logs?tail=2", nil)
	lines, _ := logs["lines"].([]any)
	if code != 200 || logs["status"] != "failed" || len(lines) != 2 || !strings.Contains(fmt.Sprint(logs["error"]), "did not attest") {
		t.Fatalf("GET logs of a failed start: %d %v", code, logs)
	}
	// retention is bounded
	for i := 0; i < keepFailed+5; i++ {
		_ = os.MkdirAll(filepath.Join(r.s.Root, "failed", fmt.Sprintf("gdx%07d", i)), 0o700)
	}
	pruneFailed(filepath.Join(r.s.Root, "failed"), keepFailed)
	if ents, _ := os.ReadDir(filepath.Join(r.s.Root, "failed")); len(ents) != keepFailed {
		t.Fatalf("failed logs kept: %d, want %d", len(ents), keepFailed)
	}
}

func TestLogsOfARunningInstance(t *testing.T) {
	r := newRig(t)
	r.f.serial = "DOM serving\nline two\n"
	p, _ := r.bundle("A", contract.Policy{})
	_, body := r.create("0x"+strings.Repeat("aa", 32), p)
	r.s.launching.Wait()
	code, logs := r.do("GET", "/vms/"+body["id"].(string)+"/logs", nil)
	if code != 200 || logs["status"] != "running" || fmt.Sprint(logs["lines"]) != "[DOM serving line two]" {
		t.Fatalf("%d %v", code, logs)
	}
	if code, _ := r.do("GET", "/vms/gd00000000/logs", nil); code != 404 {
		t.Fatalf("an unknown instance's logs: %d", code)
	}
}
