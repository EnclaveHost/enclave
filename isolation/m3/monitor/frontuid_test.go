package main

import (
	"os"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

// The domain model is RUNTIME vs FRONT (enclave-87's ruling on enclave-bf's finding): a report is made for a domain's
// FRONT only. Here the caller (this test process) is the domain's RUNTIME - its uid is the domain's UID, and the front
// has another - so it must be REFUSED, having named nothing; and a request from the front's uid is answered (the rest of
// report_test.go registers the caller as the front).
func TestAReportIsRefusedToTheRuntime(t *testing.T) {
	m, sock := testMonitor(t, okReport)
	d := &domain{ID: 1, UID: os.Getuid(), FrontUID: os.Getuid() + frontUIDOffset, Port: 40001, life: contract.NewLifecycle(contract.Running),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	m.register(d)
	if _, byRuntime := m.byUID[d.UID]; byRuntime {
		t.Fatal("the runtime's uid is in the report table")
	}
	got := mustAsk(t, sock, goodBind)
	if got["error"] != "caller is not a domain's front" || got["report"] != "" {
		t.Fatalf("a report request from the domain's RUNTIME uid: %v", got)
	}
	// the same caller as the domain's front is answered
	m.deregister(d)
	d2 := &domain{ID: 1, UID: os.Getuid() + frontUIDOffset, FrontUID: os.Getuid(), Port: 40001, life: contract.NewLifecycle(contract.Running),
		exited: make(chan struct{}), inFlight: make(chan struct{}, maxReportsPerDom)}
	m.register(d2)
	if got := mustAsk(t, sock, goodBind); got["error"] != "" {
		t.Fatalf("a report request from the domain's FRONT uid was refused: %v", got)
	}
}

// main.go, from its source: /run is the front's alone (its uid, 0700), the front's uid is from its own range, and domexec
// is told both uids.
func TestTheFrontOwnsRun(t *testing.T) {
	b, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	for _, must := range []string{
		"FrontUID: m.baseUID + frontUIDOffset + id",
		"if id >= frontUIDOffset {",
		"os.Chown(runAt, d.FrontUID, d.FrontUID)",
		"os.Chmod(runAt, 0o700)",
		`fmt.Sprintf("%d:%d", d.UID, d.FrontUID)`,
		"m.byUID[d.FrontUID] = d",
	} {
		if !strings.Contains(src, must) {
			t.Fatalf("main.go no longer has %q", must)
		}
	}
	for _, mustNot := range []string{"os.Chown(runAt, d.UID", "m.byUID[d.UID] = d", `os.Chown(filepath.Join(d.dir, "run"), d.UID`} {
		if strings.Contains(src, mustNot) {
			t.Fatalf("main.go gives the RUNTIME's uid what is the front's: %q", mustNot)
		}
	}
}
