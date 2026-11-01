//go:build linux && amd64

package main

import (
	"crypto/sha256"
	"enclave.host/isolation/m3/rpcservice"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestOwnerWireRejectsAliasDuplicateMissingAndTrailing(t *testing.T) {
	type row struct {
		Schema string `json:"schema"`
	}
	for _, raw := range []string{`{"Schema":"a"}`, `{"schema":"a","schema":"a"}`, `{}`, `{"schema":"a"} {}`, `{"schema":null}`, `{"schema":"a","unknown":true}`} {
		var out row
		if decode([]byte(raw), &out, true) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	var out row
	if e := decode([]byte("{\"schema\":\"a\"}\n"), &out, true); e != nil {
		t.Fatal(e)
	}
}

func TestOwnerInputsRequireHeldPrivateReadonlyRegularFile(t *testing.T) {
	path := t.TempDir() + "/seed"
	if e := os.WriteFile(path, make([]byte, 32), 0600); e != nil {
		t.Fatal(e)
	}
	f, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if b, e := owned(int(f.Fd()), 32); e != nil || len(b) != 32 {
		t.Fatal(e)
	}
	rw, e := os.OpenFile(path, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	defer rw.Close()
	if _, e = owned(int(rw.Fd()), 32); e == nil {
		t.Fatal("writable seed fd accepted")
	}
	if e = os.Chmod(path, 0644); e != nil {
		t.Fatal(e)
	}
	if _, e = owned(int(f.Fd()), 32); e == nil {
		t.Fatal("public seed accepted")
	}
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	defer w.Close()
	if _, e = owned(int(r.Fd()), 32); e == nil {
		t.Fatal("blocking pipe accepted as key")
	}
	if _, e = owned(-1, 32); e == nil {
		t.Fatal("invalid fd accepted")
	}
	// An invalid input must not close or mutate standard input by fd reuse.
	if _, _, e := syscall.Syscall(syscall.SYS_FCNTL, 0, syscall.F_GETFD, 0); e != 0 {
		t.Fatal(e)
	}
}

func TestOwnerOriginalClockAndActorBudget(t *testing.T) {
	for _, mode := range []string{"valid", "spent-actor-budget", "expired-actor", "last-half-second", "expired-clock", "other-boot", "wall-jump", "pin", "reset-window", "overflow", "contract-time"} {
		t.Run(mode, func(t *testing.T) {
			mono, e := rpcservice.MonotonicNow()
			if e != nil {
				t.Fatal(e)
			}
			wall := uint64(time.Now().UnixNano())
			boot, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
			if e != nil {
				t.Fatal(e)
			}
			origin, created := mono, wall
			if mode == "last-half-second" {
				origin -= 899500000000
				created -= 899500000000
			}
			if mode == "expired-clock" {
				origin -= 901000000000
				created -= 901000000000
			}
			if mode == "wall-jump" {
				created -= 3000000000
			}
			if mode == "overflow" {
				origin = ^uint64(0) - 100
			}
			row := map[string]any{"schema": "owned-rpc-startup-clock/1", "bootId": strings.TrimSpace(string(boot)), "originMonotonicNs": origin, "deadlineMonotonicNs": origin + 900000000000, "createdUtcNs": created, "deadlineUtcNs": created + 900000000000}
			if mode == "other-boot" {
				row["bootId"] = "12345678-1234-1234-1234-123456789abc"
			}
			if mode == "reset-window" {
				row["deadlineMonotonicNs"] = origin + 901000000000
			}
			raw, _ := json.Marshal(row)
			sum := sha256.Sum256(raw)
			pin := hex.EncodeToString(sum[:])
			if mode == "pin" {
				pin = strings.Repeat("a", 64)
			}
			actor := time.Now().Add(20 * time.Second)
			if mode == "spent-actor-budget" {
				actor = time.Now().Add(300 * time.Millisecond)
			}
			if mode == "expired-actor" {
				actor = time.Now().Add(-time.Second)
			}
			contractCreated := created
			if mode == "contract-time" {
				contractCreated++
			}
			before := time.Now()
			deadline, e := ownerDeadline(raw, pin, contractCreated, created+900000000000, actor)
			valid := mode == "valid" || mode == "spent-actor-budget" || mode == "last-half-second"
			if !valid {
				if e == nil {
					t.Fatal("substituted/expired clock accepted")
				}
				return
			}
			if e != nil || deadline.After(actor) || deadline.Before(before) {
				t.Fatal("original bound not retained", e)
			}
			if mode == "spent-actor-budget" && !deadline.Equal(actor) {
				t.Fatal("actor budget reset after preparation")
			}
			if mode == "last-half-second" && deadline.Sub(before) > 500*time.Millisecond {
				t.Fatal("owner window reset at request")
			}
		})
	}
}
