//go:build linux && amd64

package rpcstorage

import (
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

func TestBrokerOwnerHelper(t *testing.T) {
	if os.Getenv("RPC_BROKER_HELPER") != "1" {
		t.Skip("isolated child helper")
	}
	clock := os.NewFile(3, "original-clock")
	defer clock.Close()
	origin, e := rpcservice.OriginalEntryOrigin(clock)
	if e != nil {
		t.Fatal(e)
	}
	c, e := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: os.Getenv("RPC_BROKER_SOCKET"), Net: "unixpacket"})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	// The serving-export fixture must outlive its <=4s signed permit so
	// it can distinguish permit expiry from an unrelated mock-monitor exit.
	lifetime := 3 * time.Second
	if os.Getenv("RPC_BROKER_MODE") == "export-serving-fixture" {
		lifetime = 5 * time.Second
	}
	c.SetDeadline(time.Now().Add(lifetime))
	r, e := NewRequest(rpcBundle(t), origin)
	if e != nil {
		t.Fatal(e)
	}
	fd, _, eno := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if eno != 0 {
		t.Fatal(eno)
	}
	owner := os.NewFile(fd, "own-pidfd")
	defer owner.Close()
	fds := []int{int(fd)}
	mode := os.Getenv("RPC_BROKER_MODE")
	switch mode {
	case "wrong-process":
		other, _, eno := syscall.Syscall(434, uintptr(os.Getppid()), 0, 0)
		if eno != 0 {
			t.Fatal(eno)
		}
		defer syscall.Close(int(other))
		fds = []int{int(other)}
	case "regular-fd":
		fds = []int{3}
	case "missing-fd":
		fds = nil
	case "extra-fd":
		fds = append(fds, 3)
	case "wrong-boot":
		r.Boot = "12345678-1234-1234-1234-123456789abc"
	case "reset-origin":
		r.Origin++
		r.Deadline++
	}
	raw, _ := json.Marshal(r)
	if mode == "duplicate" {
		raw = []byte(strings.Replace(string(raw), `"appId":`, `"appId":"`+r.AppID+`","appId":`, 1))
	}
	if mode == "alias" {
		raw = []byte(strings.Replace(string(raw), `"appId":`, `"AppID":`, 1))
	}
	if mode == "oversized" {
		raw = append(raw, []byte(strings.Repeat(" ", 4096))...)
	}
	var rights []byte
	if len(fds) > 0 {
		rights = syscall.UnixRights(fds...)
	}
	if _, _, e = c.WriteMsgUnix(raw, rights, nil); e != nil {
		t.Fatal(e)
	}
	var ack [1]byte
	if e = readSkippingServing(c); e == nil {
		if mode == "close-live" {
			c.Close()
			time.Sleep(time.Second)
		}
		if mode == "extra-message" {
			c.Write([]byte("retry"))
			c.Read(ack[:])
		}
	}
}

// readSkippingServing waits for the next packet, passing over serving-expiry
// announcements the way the real monitor's watchServing follows them.
func readSkippingServing(c *net.UnixConn) error {
	buf := make([]byte, 256)
	for {
		n, e := c.Read(buf)
		if e != nil || !strings.HasPrefix(string(buf[:n]), servingPrefix) {
			return e
		}
	}
}

type brokerFixture struct {
	session *BrokerSession
	process *exec.Cmd
	conn    *net.UnixConn
	clock   *os.File
}

func brokerFixtureStart(t *testing.T, mode string, remaining time.Duration) (brokerFixture, error) {
	t.Helper()
	dir, e := os.MkdirTemp("/tmp", "rpc-bs-")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := dir + "/s"
	l, e := net.ListenUnix("unixpacket", &net.UnixAddr{Name: path, Net: "unixpacket"})
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	l.SetDeadline(time.Now().Add(3 * time.Second))
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	origin := now
	if remaining > 0 {
		origin = now - uint64(rpcservice.StartupWindow) + uint64(remaining)
	}
	clock, e := rpcservice.NewEntryContract(origin)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { clock.Close() })
	cmd := exec.Command(os.Args[0], "-test.run=^TestBrokerOwnerHelper$")
	cmd.ExtraFiles = []*os.File{clock}
	cmd.Env = append(os.Environ(), "RPC_BROKER_HELPER=1", "RPC_BROKER_SOCKET="+path, "RPC_BROKER_MODE="+mode)
	// All children are inside the qualification's bounded private namespace/cgroup.
	// A held os.Process refers only to this exact child; no broad PID enumeration.
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { cmd.Process.Kill(); cmd.Wait() })
	c, e := l.AcceptUnix()
	if e != nil {
		t.Fatal(e)
	}
	s, e := ReceiveBrokerSession(c, clock)
	if s != nil {
		t.Cleanup(func() { s.lose(); <-s.done; s.owner.Close(); s.peer.Close() })
	}
	return brokerFixture{s, cmd, c, clock}, e
}
func TestBrokerBindsActualPeerAndTransferredOwner(t *testing.T) {
	f, e := brokerFixtureStart(t, "valid", 0)
	if e != nil {
		t.Fatal(e)
	}
	pid, e := pidfdPID(f.session.peer)
	if e != nil || pid != f.process.Process.Pid {
		t.Fatal("wrong exact peer", pid, e)
	}
	pid, e = pidfdPID(f.session.owner)
	if e != nil || pid != f.process.Process.Pid {
		t.Fatal("wrong transferred owner", pid, e)
	}
	if e = f.session.alive(); e != nil {
		t.Fatal(e)
	}
	r := f.session.Request()
	r.Nonce = strings.Repeat("0", 64)
	if r == f.session.Request() {
		t.Fatal("caller mutated bound request")
	}
	// Failed authorization consumes this exact session and closes its work gate.
	if _, e = f.session.AuthenticateAndReserve(nil, rpcBundle(t), []byte(`{}`), nil); e == nil {
		t.Fatal("unauthenticated session reserved")
	}
	if _, e = f.session.AuthenticateAndReserve(nil, rpcBundle(t), []byte(`{}`), nil); e == nil || !strings.Contains(e.Error(), "already consumed") {
		t.Fatal("same session replay", e)
	}
}
func TestBrokerRejectsIdentityAndPacketSubstitution(t *testing.T) {
	for _, mode := range []string{"wrong-process", "regular-fd", "missing-fd", "extra-fd", "wrong-boot", "reset-origin", "duplicate", "alias", "oversized"} {
		t.Run(mode, func(t *testing.T) {
			f, e := brokerFixtureStart(t, mode, 0)
			if e == nil || f.session != nil {
				t.Fatal("accepted", mode)
			}
			want := map[string]string{"wrong-process": "not socket peer", "regular-fd": "not socket peer", "missing-fd": "exact owner pidfd", "extra-fd": "exact owner pidfd", "wrong-boot": "reset original time or boot", "reset-origin": "reset original time or boot", "duplicate": "noncanonical", "alias": "noncanonical", "oversized": "exact owner pidfd"}[mode]
			if !strings.Contains(e.Error(), want) {
				t.Fatalf("wrong refusal for %s: %v", mode, e)
			}
			if e = f.process.Wait(); e != nil {
				t.Fatalf("sender did not complete its packet: %v", e)
			}
		})
	}
}
func TestBrokerLossAndOriginalDeadlineCloseGate(t *testing.T) {
	for _, mode := range []string{"owner-death", "close-live", "extra-message", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			left := time.Duration(0)
			if mode == "deadline" {
				left = 350 * time.Millisecond
			}
			f, e := brokerFixtureStart(t, mode, left)
			if e != nil {
				t.Fatal(e)
			}
			start := time.Now()
			if mode == "owner-death" {
				if e = f.process.Process.Kill(); e != nil {
					t.Fatal(e)
				}
			}
			if mode == "close-live" || mode == "extra-message" {
				if _, e = f.conn.Write([]byte("x")); e != nil {
					t.Fatal(e)
				}
			}
			select {
			case <-f.session.Context().Done():
			case <-time.After(time.Second):
				t.Fatal("closed gate not observed")
			}
			if e = f.session.alive(); e == nil {
				t.Fatal("lost session still usable")
			}
			if mode == "close-live" {
				event, e := pollBroker([]brokerPoll{{int32(f.session.peer.Fd()), 1, 0}}, 0)
				if e != nil || event {
					t.Fatal("fixture exited; did not isolate connection loss", e)
				}
			}
			if mode == "deadline" && time.Since(start) > 600*time.Millisecond {
				t.Fatal("original deadline reset")
			}
		})
	}
}
