package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"enclave.host/isolation/contract"
)

// The SUPERVISOR's own manager path (supervisor.js vmReq, through its GUESTD_TRANSPORT_SELFTEST seam) against a
// real guestd server: with ISOLATION_BACKEND set it speaks guestd-control/1 and nothing else, and without the flag
// it is exactly the plain path it always was.

type counting struct {
	h  http.Handler
	mu sync.Mutex
	n  map[string]int
}

func (c *counting) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	c.n[r.Method+" "+r.URL.Path]++
	c.mu.Unlock()
	c.h.ServeHTTP(w, r)
}

func (c *counting) count(k string) int { c.mu.Lock(); defer c.mu.Unlock(); return c.n[k] }

func supervisorSeam(t *testing.T, env map[string]string, calls []map[string]any) []map[string]any {
	t.Helper()
	cj, _ := json.Marshal(map[string]any{"calls": calls})
	cmd := exec.Command("node", "../../../supervisor.js")
	cmd.Env = append(os.Environ(), "SECRET=test-secret", "GUESTD_TRANSPORT_SELFTEST="+string(cj),
		"ISOLATION_SELFTEST=", "INSTANCE_SELFTEST=", "POOL_SELFTEST=", "SWEEP_SELFTEST=", "REACH_SELFTEST=",
		"ACME_SELFTEST=", "CFG_EDIT_SELFTEST=", "ADDRESS_BOOK_ADDRESS=", "REGISTRY_ENABLED=", "CLAIM_ENABLED=",
		"ACME_EAB_KID=", "ACME_EAB_HMAC=", "APP_CERT_DOMAIN=", "DNS_API=", "GUESTD_KEY_FILE=", "ISOLATION_BACKEND=")
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("supervisor seam: %v %s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var got []map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &got); err != nil {
		t.Fatalf("%v: %s", err, out)
	}
	t.Logf("seam %v -> %s", env["ISOLATION_BACKEND"] != "", lines[len(lines)-1])
	return got
}

func TestTheSupervisorReachesGuestdOnlyOverTheChannel(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	r := newRig(t)
	r.s.Auth = newControlAuth(testKey, r.s.Now)
	ch := &chaos{s: r.s}
	ts := httptest.NewServer(ch)
	defer ts.Close()
	p, _ := r.bundle("A", contract.Policy{})
	dir := t.TempDir()
	key := filepath.Join(dir, "pair.key")
	_ = os.WriteFile(key, []byte(hex.EncodeToString(testKey)+"\n"), 0o600)
	on := map[string]string{"ISOLATION_BACKEND": "snp-guest-per-app", "VMMGR_URL": ts.URL, "GUESTD_KEY_FILE": key}
	setChaos := func(cfg chaosCfg) { ch.mu.Lock(); ch.cfg = cfg; ch.mu.Unlock() }
	names := func(n string) int {
		r.s.mu.Lock()
		defer r.s.mu.Unlock()
		k := 0
		for _, v := range r.s.vms {
			if v.Name == n {
				k++
			}
		}
		return k
	}

	// the plain reads and the heartbeat, signed
	got := supervisorSeam(t, on, []map[string]any{{"method": "GET", "path": "/health"}, {"method": "GET", "path": "/vms"},
		{"method": "POST", "path": "/vms/lease", "body": map[string]any{"ids": []string{}}}})
	if fmt.Sprintf("%v %v %v %v", got[0]["status"], field(got[0], "body", "backend"), got[1]["status"], got[2]["status"]) != "200 snp-guest-per-app 200 200" {
		t.Fatalf("signed reads: %v", got)
	}

	// a launch whose signed 201 is replaced by an unsigned 401 on the way back: reconciled, executed ONCE
	setChaos(chaosCfg{Fake401Method: "POST", Fake401Path: "/vms", Fake401Times: 1})
	got = supervisorSeam(t, on, []map[string]any{{"method": "POST", "path": "/vms",
		"body": map[string]any{"image": "file://" + p, "name": "0xs1", "cpuShare": 0.25, "gpuShare": 0, "appPort": 8080,
			"ports": []any{}, "config": "", "configCid": "", "egress": ""}}})
	r.s.launching.Wait()
	if got[0]["status"] != float64(201) || got[0]["reconciled"] != true || names("0xs1") != 1 {
		t.Fatalf("a replaced launch reply must reconcile to the ONE launch: %v (instances named 0xs1: %d)", got, names("0xs1"))
	}
	id := field(got[0], "body", "id").(string)

	// a stop whose reply is replaced: DELETE is idempotent here, so it is sent again and reads as confirmed (404)
	setChaos(chaosCfg{Fake401Method: "DELETE", Fake401Path: "/vms/" + id, Fake401Times: 1})
	got = supervisorSeam(t, on, []map[string]any{{"method": "DELETE", "path": "/vms/" + id}})
	if got[0]["status"] != float64(404) || names("0xs1") != 0 {
		t.Fatalf("a replaced stop reply: %v", got)
	}

	// any other mutating route is never repeated: the outcome is reported unknown
	setChaos(chaosCfg{Fake401Method: "POST", Fake401Path: "/gpu/bounce-mps", Fake401Times: 1})
	got = supervisorSeam(t, on, []map[string]any{{"method": "POST", "path": "/gpu/bounce-mps", "body": map[string]any{}}})
	if got[0]["kind"] != "outcome-unknown" || got[0]["mayHaveExecuted"] != true {
		t.Fatalf("a non-idempotent route: %v", got)
	}
	setChaos(chaosCfg{})

	// no key, an exposed key: no transport at all, and guestd hears nothing
	ch.mu.Lock()
	hellos := ch.hellos
	ch.mu.Unlock()
	noKey := map[string]string{"ISOLATION_BACKEND": "snp-guest-per-app", "VMMGR_URL": ts.URL}
	got = supervisorSeam(t, noKey, []map[string]any{{"method": "GET", "path": "/health"}})
	if !strings.Contains(fmt.Sprint(got[0]["error"]), "GUESTD_KEY_FILE is not") {
		t.Fatalf("no key: %v", got)
	}
	open := filepath.Join(dir, "open.key")
	_ = os.WriteFile(open, []byte(hex.EncodeToString(testKey)+"\n"), 0o644)
	_ = os.Chmod(open, 0o644)
	got = supervisorSeam(t, map[string]string{"ISOLATION_BACKEND": "snp-guest-per-app", "VMMGR_URL": ts.URL,
		"GUESTD_KEY_FILE": open}, []map[string]any{{"method": "GET", "path": "/health"}})
	if !strings.Contains(fmt.Sprint(got[0]["error"]), "readable or writable by others") {
		t.Fatalf("exposed key: %v", got)
	}
	ch.mu.Lock()
	after := ch.hellos
	ch.mu.Unlock()
	if after != hellos {
		t.Fatal("a supervisor without a usable key contacted guestd")
	}

	// a manager in lab mode (no credentials): refused, and not one plain request reaches it
	lab := newRig(t)
	lc := &counting{h: lab.s, n: map[string]int{}}
	lts := httptest.NewServer(lc)
	defer lts.Close()
	got = supervisorSeam(t, map[string]string{"ISOLATION_BACKEND": "snp-guest-per-app", "VMMGR_URL": lts.URL,
		"GUESTD_KEY_FILE": key}, []map[string]any{{"method": "GET", "path": "/health"}, {"method": "GET", "path": "/vms"}})
	if !strings.Contains(fmt.Sprint(got[0]["error"]), "does not speak guestd-control/1") ||
		lc.count("GET /health")+lc.count("GET /vms") != 0 {
		t.Fatalf("an unauthenticated manager must be refused before any request reaches it: %v (plain requests: %d)",
			got, lc.count("GET /health")+lc.count("GET /vms"))
	}

	// and WITHOUT the flag, vmReq is the plain path it always was: one plain request, no handshake attempted
	hellosBefore := lc.count("GET /control/hello") // the lab-mode run above tried once per call
	got = supervisorSeam(t, map[string]string{"VMMGR_URL": lts.URL}, []map[string]any{{"method": "GET", "path": "/health"}})
	if got[0]["status"] != float64(200) || lc.count("GET /health") != 1 || lc.count("GET /control/hello") != hellosBefore {
		t.Fatalf("the flag-off path must be unchanged: %v (plain /health: %d)", got, lc.count("GET /health"))
	}
}
