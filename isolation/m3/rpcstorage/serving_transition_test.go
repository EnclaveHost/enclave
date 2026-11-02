//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

func TestServingExpiryParsesOnlyExactAnnouncement(t *testing.T) {
	const prefix = servingPrefix + "ab "
	for raw, want := range map[string]bool{
		prefix + "123\n": true, prefix + "0\n": true,
		prefix + "0123\n": false, prefix + "123": false, prefix + "12 3\n": false, prefix + "-1\n": false,
		prefix + "123\n\n": false, prefix + "\n": false, prefix + "18446744073709551616\n": false,
		servingPrefix + "cd 123\n": false, replyPrefix + "ab 123\n": false,
	} {
		if _, ok := servingExpiry([]byte(raw), prefix); ok != want {
			t.Errorf("%q: got %v want %v", raw, ok, want)
		}
	}
}

// servingPair returns a monitor-side Attempt watching one end of a socketpair,
// pinned to a live child as the exact broker, and the broker-side end.
func servingPair(t *testing.T, req Request) (*Attempt, *net.UnixConn, *exec.Cmd) {
	t.Helper()
	fds, err := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	conn := func(fd int) *net.UnixConn {
		f := os.NewFile(uintptr(fd), "pair")
		c, err := net.FileConn(f)
		f.Close()
		if err != nil {
			t.Fatal(err)
		}
		return c.(*net.UnixConn)
	}
	monitor, broker := conn(fds[0]), conn(fds[1])
	child := exec.Command("/usr/bin/sleep", "60")
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { child.Process.Kill(); child.Wait() })
	pidfd, _, e := syscall.Syscall(434, uintptr(child.Process.Pid), 0, 0) // pidfd_open
	if e != 0 {
		t.Fatal(e)
	}
	a := &Attempt{Request: req, peer: os.NewFile(pidfd, "broker-pidfd"), loss: make(chan struct{})}
	go watchServing(monitor, a, req)
	t.Cleanup(func() { broker.Close() })
	return a, broker, child
}

func announcement(t *testing.T, req Request, expiry uint64) []byte {
	raw, _ := json.Marshal(req)
	sum := sha256.Sum256(raw)
	return []byte(servingPrefix + hex.EncodeToString(sum[:]) + " " + strconv.FormatUint(expiry, 10) + "\n")
}

func lostWithin(a *Attempt, d time.Duration) bool {
	select {
	case <-a.loss:
		return true
	case <-time.After(d):
		return false
	}
}

func TestWatchServingFollowsOnlyIncreasingBoundedExpiry(t *testing.T) {
	// A short original deadline stands in for the 900-second startup window.
	short := func() Request {
		now, err := rpcservice.MonotonicNow()
		if err != nil {
			t.Fatal(err)
		}
		return Request{Schema: requestSchema, Origin: now - uint64(time.Second), Deadline: now + uint64(400*time.Millisecond), Nonce: strconv.FormatInt(time.Now().UnixNano(), 16)}
	}

	t.Run("no-announcement-loses-at-original-deadline", func(t *testing.T) {
		a, _, _ := servingPair(t, short())
		if lostWithin(a, 200*time.Millisecond) || !lostWithin(a, 2*time.Second) {
			t.Fatal("attempt not retired exactly at original deadline")
		}
	})
	t.Run("renewals-extend-past-startup-then-expire", func(t *testing.T) {
		req := short()
		a, broker, _ := servingPair(t, req)
		m, _ := rpcservice.MonotonicNow()
		if _, err := broker.Write(announcement(t, req, m+uint64(800*time.Millisecond))); err != nil {
			t.Fatal(err)
		}
		time.Sleep(600 * time.Millisecond) // past the original deadline
		m, _ = rpcservice.MonotonicNow()
		if lostWithin(a, 0) {
			t.Fatal("announced serving expiry not followed")
		}
		if _, err := broker.Write(announcement(t, req, m+uint64(700*time.Millisecond))); err != nil {
			t.Fatal(err)
		}
		if lostWithin(a, 400*time.Millisecond) {
			t.Fatal("renewal not followed")
		}
		if !lostWithin(a, 2*time.Second) {
			t.Fatal("serving expiry did not retire the attempt")
		}
	})
	for name, mutate := range map[string]func(Request, uint64) []byte{
		"not-increasing":  func(r Request, m uint64) []byte { return announcement(t, r, r.Deadline) },
		"beyond-permit":   func(r Request, m uint64) []byte { return announcement(t, r, m+servingSpan+uint64(time.Second)) },
		"other-request":   func(r Request, m uint64) []byte { r.Nonce += "0"; return announcement(t, r, m+uint64(time.Second)) },
		"any-other-bytes": func(r Request, m uint64) []byte { return []byte("x") },
	} {
		t.Run(name, func(t *testing.T) {
			req := short()
			a, broker, _ := servingPair(t, req)
			m, _ := rpcservice.MonotonicNow()
			if _, err := broker.Write(mutate(req, m)); err != nil {
				t.Fatal(err)
			}
			if !lostWithin(a, 200*time.Millisecond) {
				t.Fatal("invalid announcement accepted")
			}
		})
	}
	t.Run("rights-are-loss", func(t *testing.T) {
		req := short()
		a, broker, _ := servingPair(t, req)
		m, _ := rpcservice.MonotonicNow()
		f, _ := os.Open("/dev/null")
		defer f.Close()
		if _, _, err := broker.WriteMsgUnix(announcement(t, req, m+uint64(time.Second)), syscall.UnixRights(int(f.Fd())), nil); err != nil {
			t.Fatal(err)
		}
		if !lostWithin(a, 200*time.Millisecond) {
			t.Fatal("announcement carrying descriptors accepted")
		}
	})
	t.Run("broker-death-is-loss-after-serving", func(t *testing.T) {
		req := short()
		a, broker, child := servingPair(t, req)
		m, _ := rpcservice.MonotonicNow()
		if _, err := broker.Write(announcement(t, req, m+uint64(5*time.Second))); err != nil {
			t.Fatal(err)
		}
		time.Sleep(100 * time.Millisecond)
		child.Process.Kill()
		if !lostWithin(a, time.Second) {
			t.Fatal("exact broker death not observed during serving")
		}
	})
}
