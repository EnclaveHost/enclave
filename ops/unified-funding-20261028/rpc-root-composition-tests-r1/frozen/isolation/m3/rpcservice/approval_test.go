//go:build linux && amd64

package rpcservice

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

func approvalFixture(t *testing.T) []byte {
	t.Helper()
	b, _, _, _ := controllerFixture(t)
	rt, _ := json.Marshal(contract.RuntimeIdentity{Name: "wasmtime", Version: "test-only", HostISA: contract.ISAx86_64, TargetISA: contract.ISAx86_64, CPUFeatures: "baseline", Execution: contract.ExecJIT, WX: contract.WXEnforced, Cache: contract.CacheNone})
	f, err := approvalIdentity(b, rt, [32]byte{1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = approvalIdentity(b, append(rt, []byte(`{}`)...), [32]byte{1}); err == nil {
		t.Fatal("trailing runtime accepted")
	}
	if _, err = approvalIdentity(b, rt, [32]byte{}); err == nil {
		t.Fatal("zero nonce accepted")
	}
	return f
}
func TestApprovalActualSealedBinding(t *testing.T) {
	frame := approvalFixture(t)
	f, err := sealedApproval(frame)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got := make([]byte, len(frame))
	if _, err = f.ReadAt(got, 0); err != nil || !bytes.Equal(got, frame) {
		t.Fatal(err)
	}
	if _, err = f.WriteAt([]byte{0}, 0); err == nil {
		t.Fatal("mutable binding")
	}
	if err = f.Truncate(0); err == nil {
		t.Fatal("mutable binding size")
	}
}
func TestApprovalPrivatePipeRequiresExactCompleteAttempt(t *testing.T) {
	expected := approvalFixture(t)
	for _, mode := range []string{"valid", "wrong-nonce", "wrong-app", "short", "extra", "no-approval", "held-open"} {
		t.Run(mode, func(t *testing.T) {
			r, w, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			defer w.Close()
			frame := append([]byte{}, expected...)
			switch mode {
			case "wrong-nonce":
				frame[len(frame)-1] ^= 1
			case "wrong-app":
				frame[8] ^= 1
			case "short":
				frame = frame[:5]
			case "extra":
				frame = append(frame, 0)
			case "no-approval":
				frame = nil
			}
			if _, err = w.Write(frame); err != nil {
				t.Fatal(err)
			}
			if mode != "held-open" {
				w.Close()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			defer cancel()
			err = readApproval(ctx, r, expected)
			if (mode == "valid") != (err == nil) {
				t.Fatal(mode, err)
			}
		})
	}
}
func TestFrontCommandAndBudget(t *testing.T) {
	c := roleCommand(roleFront, 23)
	want := []string{"/plat/front", "-listen-unix", "/run/front/front.sock", "-report-unix", "/run/front/monitor.sock", "-runtime-identity", "/plat/rt/runtime.json", "-app-mode", "run", "-upstream", "127.0.0.1:8000"}
	if !slices.Equal(c.Args, want) || c.SysProcAttr.Credential.Uid != 1053577 || roleLimits[roleFront].memory != 256<<20 {
		t.Fatal(c.Args)
	}
}
func TestFrontApprovalRefusalNeverStartsControllerOrChains(t *testing.T) {
	f := &fakeBackend{approval: func(context.Context) error { return errors.New("owner refused") }}
	st := await(t, runAsync(supervisor(t, f, time.Second, testTiming)))
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	wantOrder(t, f, roleFront)
}
func TestFrontLaunchFailureNeverStartsControllerOrChains(t *testing.T) {
	f := &fakeBackend{}
	f.startErr[roleFront] = errors.New("front absent")
	st := await(t, runAsync(supervisor(t, f, time.Second, testTiming)))
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	wantOrder(t, f, roleFront)
}
func TestFrontApprovalDelayCannotResetOriginalDeadline(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeBackend{approval: func(context.Context) error { close(entered); <-release; return nil }}
	tm := testTiming
	tm.cleanupBound = 25 * time.Millisecond
	s := supervisor(t, f, 40*time.Millisecond, tm)
	done := runAsync(s)
	<-entered
	st := await(t, done)
	wantFinal(t, st, OutcomeDeadline, CleanupUncertain, false)
	wantOrder(t, f, roleFront)
	close(release)
	eventually(t, "approval caller drained", func() bool { return f.allEmpty() })
	time.Sleep(10 * time.Millisecond)
	wantOrder(t, f, roleFront)
}
func TestFrontExitEndsWholeNativeGraph(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, time.Second, testTiming)
	done := runAsync(s)
	eventually(t, "all clients", func() bool { return s.State().ClientsStarted })
	f.exit(roleFront, errors.New("front lost"))
	st := await(t, done)
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, true)
	if !f.allEmpty() {
		t.Fatal("front loss left clients")
	}
}
func TestEntryRejectsPriorFrontlessTopology(t *testing.T) {
	b, err := encodeEntry([16]byte{1}, 100)
	if err != nil {
		t.Fatal(err)
	}
	copy(b, "ERPCONE2")
	if _, _, err = decodeEntry(b, [16]byte{1}, 101); err == nil {
		t.Fatal("frontless entry accepted")
	}
	copy(b, "ERPCONE3")
	if _, _, err = decodeEntry(b, [16]byte{1}, 101); err == nil {
		t.Fatal("entry without composed root accepted")
	}
}
