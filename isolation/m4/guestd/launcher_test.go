package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// the real launcher against a fake run-domain.sh that prints the HOST line a real one would, with the CID `echoCID`
func fakeRunDomain(t *testing.T, echoCID string) *realLauncher {
	dir := t.TempDir()
	script := "#!/bin/sh\necho \"HOST mode=snp vcpus=1 memMiB=1024 cpuQuota=100% unit=guestd-test-nonexistent-$$ cid=" + echoCID + " t0_ms=0\"\n"
	if err := os.WriteFile(filepath.Join(dir, "run-domain.sh"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return &realLauncher{m2: dir, bootWait: 10 * time.Second, aliveGrace: 100 * time.Millisecond}
}

// the ticket service and the egress server know a guest only by the CID guestd chose: a launch that came up on another
// is refused (enclave-99's review, untested until now)
func TestTheLauncherRefusesAGuestOnAnotherCID(t *testing.T) {
	l := fakeRunDomain(t, "140001")
	_, err := l.Start(context.Background(), "img", "gdtest", t.TempDir(), 1, 1024, 100, "", 140000)
	if err == nil || !strings.Contains(err.Error(), "CID 140001, not the 140000 guestd chose") {
		t.Fatalf("%v", err)
	}
}

// a unit that is dead before the guest printed a byte ends the wait after the short grace, not after bootWait
func TestADeadUnitWithNoSerialEndsTheWaitQuickly(t *testing.T) {
	l := fakeRunDomain(t, "140000")
	t0 := time.Now()
	_, err := l.Start(context.Background(), "img", "gdtest", t.TempDir(), 1, 1024, 100, "", 140000)
	if err == nil || !strings.Contains(err.Error(), "ended during boot") {
		t.Fatalf("%v", err)
	}
	if d := time.Since(t0); d > 3*time.Second {
		t.Fatalf("the wait lasted %s: a dead unit held its room for the boot wait", d)
	}
}
