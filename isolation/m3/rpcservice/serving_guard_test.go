//go:build linux && amd64

package rpcservice

import (
	"context"
	"encoding/binary"
	"math"
	"os"
	"syscall"
	"testing"
	"time"
)

func TestServingGuardTransitions(t *testing.T) {
	b := GuardBinding{Origin: 1, Deadline: 1 + uint64(StartupWindow), Observed: 100, PreparedSHA256: [32]byte{9}}
	for _, mode := range []string{"commit-renew", "prepare-no-extension", "wrong-origin", "wrong-deadline", "future", "stale", "zero-digest", "reserved", "oversized", "commit-first", "duplicate-prepare", "changed-digest", "replay-commit", "sequence-gap", "expiry", "permit-cap", "late-commit", "late-renew", "renew-not-advancing", "overflow-origin"} {
		t.Run(mode, func(t *testing.T) {
			s, _ := newGuardState(b.Origin, b.Deadline)
			p := guardFrame(1, b, 0, 0)
			now := uint64(100)
			switch mode {
			case "overflow-origin":
				if _, e := newGuardState(math.MaxUint64, 1); e == nil {
					t.Fatal("overflow")
				}
				return
			case "wrong-origin":
				p[16]++
			case "wrong-deadline":
				p[24]++
			case "future":
				binary.LittleEndian.PutUint64(p[32:], 101)
			case "stale":
				now += guardFresh
			case "zero-digest":
				clear(p[56:])
			case "reserved":
				p[9] = 1
			case "oversized":
				p = append(p, 0)
			case "commit-first":
				p = guardFrame(2, b, 1, 200)
			default:
				if e := s.accept(p, now); e != nil {
					t.Fatal(e)
				}
				if s.until != b.Deadline {
					t.Fatal("prepare extended")
				}
				if mode == "prepare-no-extension" {
					return
				}
				if mode == "duplicate-prepare" {
					break
				}
				p = guardFrame(2, b, 1, 200)
				switch mode {
				case "changed-digest":
					p[56]++
				case "expiry":
					binary.LittleEndian.PutUint64(p[40:], now)
				case "permit-cap":
					binary.LittleEndian.PutUint64(p[40:], now+guardPermit+1)
				case "late-commit":
					now = b.Deadline
				default:
					if e := s.accept(p, now); e != nil {
						t.Fatal(e)
					}
					if mode == "replay-commit" {
						break
					}
					p = guardFrame(3, b, 2, 300)
					switch mode {
					case "sequence-gap":
						binary.LittleEndian.PutUint64(p[48:], 3)
					case "late-renew":
						now = 200
					case "renew-not-advancing":
						binary.LittleEndian.PutUint64(p[40:], 200)
					case "commit-renew":
						if e := s.accept(p, 150); e != nil || s.until != 300 || s.sequence != 2 {
							t.Fatal(e)
						}
						return
					}
				}
			}
			if e := s.accept(p, now); e == nil {
				t.Fatal("invalid transition accepted")
			}
		})
	}
}
func guardPair(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	p, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	a, b := os.NewFile(uintptr(p[0]), "client"), os.NewFile(uintptr(p[1]), "guard")
	t.Cleanup(func() { a.Close(); b.Close() })
	return a, b
}
func TestServingGuardActualSocketAndIndependentWatcher(t *testing.T) {
	for _, mode := range []string{"prepare-only", "commit-expiry", "renew-expiry", "channel-loss", "malformed", "wrong-binding", "replay", "owner-loss"} {
		t.Run(mode, func(t *testing.T) {
			now, _ := MonotonicNow()
			d := now + uint64(150*time.Millisecond)
			o := d - uint64(StartupWindow)
			a, b := guardPair(t)
			fd, e := GuardSocketFD(b)
			if e != nil {
				t.Fatal(e)
			}
			owner := openTestPidfd(t, os.Getpid())
			defer owner.Close()
			ownerFD := int(owner.Fd())
			// An eventfd cannot substitute for production validateOwner. This variant
			// only injects the poll event into the same independent watcher branch.
			if mode == "owner-loss" {
				x, _, eno := syscall.Syscall(syscall.SYS_EVENTFD2, 0, syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
				if eno != 0 {
					t.Fatal(eno)
				}
				ownerFD = int(x)
				defer syscall.Close(ownerFD)
			}
			client, e := NewGuardClient(a, o, d)
			if e != nil {
				t.Fatal(e)
			}
			armed, done := make(chan struct{}), make(chan int, 1)
			go watchServingEntry(ownerFD, fd, o, d, armed, func(n int) { done <- n })
			<-armed
			defer client.Shutdown()
			binding := GuardBinding{Origin: o, Deadline: d, Observed: now, PreparedSHA256: [32]byte{4}}
			if e = client.Prepare(context.Background(), binding); e != nil {
				t.Fatal(e)
			}
			until := d
			if mode != "prepare-only" {
				until = now + uint64(300*time.Millisecond)
				if e = client.Commit(context.Background(), binding, until); e != nil {
					t.Fatal(e)
				}
				switch mode {
				case "renew-expiry":
					until = now + uint64(400*time.Millisecond)
					if e = client.Renew(context.Background(), binding, 2, until); e != nil {
						t.Fatal(e)
					}
				case "channel-loss":
					client.Shutdown()
				case "malformed":
					if sendGuard(client.fd, []byte("bad")) != nil {
						t.Fatal("send")
					}
				case "wrong-binding":
					binding.PreparedSHA256[0]++
					if sendGuard(client.fd, guardFrame(3, binding, 2, until+1)) != nil {
						t.Fatal("send")
					}
				case "replay":
					if sendGuard(client.fd, guardFrame(2, binding, 1, until)) != nil {
						t.Fatal("send")
					}
				case "owner-loss":
					v := make([]byte, 8)
					binary.LittleEndian.PutUint64(v, 1)
					if _, e = syscall.Write(ownerFD, v); e != nil {
						t.Fatal(e)
					}
				}
			}
			select {
			case code := <-done:
				terminal, _ := MonotonicNow()
				if code != 124 {
					t.Fatal(code)
				}
				if mode == "prepare-only" || mode == "commit-expiry" || mode == "renew-expiry" {
					if terminal < until || terminal > until+uint64(150*time.Millisecond) {
						t.Fatal("wrong expiry", terminal, until)
					}
				} else if terminal >= d {
					t.Fatal("loss waited for startup cutoff")
				}
			case <-time.After(time.Second):
				t.Fatal("independent guard failed")
			}
		})
	}
}
func TestServingGuardClientRefusesLostOrChangedAck(t *testing.T) {
	for _, mode := range []string{"changed", "eof", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			a, b := guardPair(t)
			now, _ := MonotonicNow()
			d := now + uint64(time.Second)
			o := d - uint64(StartupWindow)
			g, e := NewGuardClient(a, o, d)
			if e != nil {
				t.Fatal(e)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			defer cancel()
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				raw := make([]byte, 88)
				_, _, e := syscall.Recvfrom(int(b.Fd()), raw, 0)
				if e != nil {
					return
				}
				switch mode {
				case "changed":
					raw[8] |= 0x80
					raw[56]++
					_ = sendGuard(int(b.Fd()), raw)
				case "eof":
					syscall.Shutdown(int(b.Fd()), syscall.SHUT_RDWR)
				case "blocked":
					<-ctx.Done()
				}
			}()
			binding := GuardBinding{Origin: o, Deadline: d, Observed: now, PreparedSHA256: [32]byte{2}}
			if e = g.Prepare(ctx, binding); e == nil {
				t.Fatal("bad ack accepted")
			}
			<-finished
			if e = g.Prepare(context.Background(), binding); e == nil {
				t.Fatal("failed channel replayed")
			}
		})
	}
}
