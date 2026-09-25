package main

// enclave-63's G1: domain ids restart at 1 when the guest reboots (and this kernel reboots when PID 1 dies), so
// stop and destroy must name the boot as well as the id. Each test here fails if its guard is removed.

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// control drives the real serveControl over a pipe: one JSON command per line, one answer each.
func control(t *testing.T, m *monitor) func(cmd string) map[string]any {
	t.Helper()
	host, guest := net.Pipe()
	go m.serveControl(guest)
	t.Cleanup(func() { host.Close() })
	br := bufio.NewReader(host)
	return func(cmd string) map[string]any {
		t.Helper()
		host.SetDeadline(time.Now().Add(20 * time.Second))
		if _, err := host.Write([]byte(cmd + "\n")); err != nil {
			t.Fatalf("send %s: %v", cmd, err)
		}
		line, err := br.ReadBytes('\n')
		if err != nil {
			t.Fatalf("answer to %s: %v", cmd, err)
		}
		var ans map[string]any
		if err := json.Unmarshal(line, &ans); err != nil {
			t.Fatalf("answer to %s is not JSON: %q", cmd, line)
		}
		return ans
	}
}

// a running domain with its files in place, so a real destroy can finish it
func plantDomain(t *testing.T, m *monitor, id int) *domain {
	t.Helper()
	d := registerSelf(m, id)
	d.Boot = m.boot
	d.dir = filepath.Join(t.TempDir(), "d")
	d.cgroup = filepath.Join(t.TempDir(), "cg")
	os.MkdirAll(d.dir, 0o755)
	os.MkdirAll(d.cgroup, 0o755)
	close(d.exited) // nothing is running
	return d
}

func listed(m *monitor, id int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.doms[id]
	return ok
}

func TestEachBootMintsItsOwnNonce(t *testing.T) {
	a, b := newMonitor(false, "/plat", t.TempDir(), 40000, 5000), newMonitor(false, "/plat", t.TempDir(), 40000, 5000)
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(a.boot) {
		t.Fatalf("the boot nonce is 128 bits of hex, got %q", a.boot)
	}
	if a.boot == b.boot {
		t.Fatal("two boots minted the same nonce")
	}
}

func TestStopAndDestroyWithoutABootAreRefusedAndTouchNothing(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	plantDomain(t, m, 1)
	ask := control(t, m)
	for _, cmd := range []string{`{"cmd":"destroy","id":1}`, `{"cmd":"stop","id":1}`} {
		got := ask(cmd)
		if got["bootRequired"] != true || !strings.Contains(got["error"].(string), "boot") {
			t.Fatalf("%s: a bare id must be refused for want of the boot, got %v", cmd, got)
		}
		if !listed(m, 1) {
			t.Fatalf("%s: a refused command removed the domain", cmd)
		}
	}
}

func TestAnotherBootsReferenceAnswersRebootedAndTouchesNothing(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	plantDomain(t, m, 1)
	ask := control(t, m)
	stale := strings.Repeat("0", 32)
	for _, cmd := range []string{`{"cmd":"destroy","id":1,"boot":"` + stale + `"}`, `{"cmd":"stop","id":1,"boot":"` + stale + `"}`} {
		got := ask(cmd)
		if got["rebooted"] != true || got["boot"] != m.boot {
			t.Fatalf("%s: another boot's domain 1 must answer rebooted with the current boot, got %v", cmd, got)
		}
		if !listed(m, 1) {
			t.Fatalf("%s: THIS boot's domain 1 was acted on for another boot's reference", cmd)
		}
	}
}

func TestListAndStateNameTheBootAndTheRightBootDestroys(t *testing.T) {
	m, _ := testMonitor(t, okReport)
	plantDomain(t, m, 1)
	ask := control(t, m)
	if got := ask(`{"cmd":"list"}`); got["boot"] != m.boot {
		t.Fatalf("list must carry the boot, got %v", got)
	} else if doms := got["domains"].([]any); len(doms) != 1 || doms[0].(map[string]any)["boot"] != m.boot {
		t.Fatalf("each listed domain carries its boot, got %v", doms)
	}
	if got := ask(`{"cmd":"state"}`); got["boot"] != m.boot {
		t.Fatalf("state must carry the boot, got %v", got)
	}
	if got := ask(`{"cmd":"destroy","id":1,"boot":"` + m.boot + `"}`); got["destroyed"] != float64(1) {
		t.Fatalf("the right boot and id destroy the domain, got %v", got)
	}
	if listed(m, 1) {
		t.Fatal("the domain is still listed after its destroy")
	}
}
