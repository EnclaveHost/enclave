//go:build linux && amd64

package rpcstorage

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/m3/rpcservice"
)

// These tests own a disposable /run, never the host's broker namespace.
func privateIngressRun(t *testing.T) {
	t.Helper()
	var fs syscall.Statfs_t
	uid, e := os.ReadFile("/proc/self/uid_map")
	if os.Getenv("RPC_INGRESS_TEST_PRIVATE") != "1" || e != nil || strings.Contains(string(uid), "4294967295") || syscall.Statfs("/run", &fs) != nil || fs.Type != 0x01021994 {
		t.Fatal("explicit private user/mount namespace with tmpfs /run required")
	}
	if _, e = os.Lstat("/run/native-rpc-storage"); !os.IsNotExist(e) {
		t.Fatal("test namespace not empty", e)
	}
	t.Cleanup(func() { os.RemoveAll("/run/native-rpc-storage") })
}
func ingressClock(t *testing.T, left time.Duration) (*os.File, uint64) {
	t.Helper()
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	if now < uint64(rpcservice.StartupWindow) {
		t.Fatal("fixture uptime insufficient for original expired-window setup")
	}
	origin := now - uint64(rpcservice.StartupWindow) + uint64(left)
	f, e := rpcservice.NewEntryContract(origin)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { f.Close() })
	return f, origin
}
func ingressPipe(t *testing.T) (*os.File, *os.File) {
	t.Helper()
	r, w, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { r.Close(); w.Close() })
	return r, w
}

func TestBrokerIngressChild(t *testing.T) {
	if os.Getenv("RPC_INGRESS_HELPER") != "1" {
		t.Skip("child-only ingress fixture")
	}
	s, receipts, e := AcceptBroker(os.NewFile(3, "original-clock"), os.NewFile(4, "ready"))
	if e != nil {
		t.Fatal(e)
	}
	defer receipts.Close()
	defer s.Stop()
	if e = s.Acknowledge(); e != nil {
		t.Fatal(e)
	}
	// No root grant, authority credentials, provider or export in this fixture.
	fmt.Println("accepted")
	<-s.Context().Done()
}
func TestBrokerIngressOwnsExactPeer(t *testing.T) {
	privateIngressRun(t)
	clock, origin := ingressClock(t, 5*time.Second)
	ready, w := ingressPipe(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestBrokerIngressChild$")
	cmd.Env = append(os.Environ(), "RPC_INGRESS_HELPER=1")
	cmd.ExtraFiles = []*os.File{clock, w}
	cmd.Stderr = os.Stderr
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	w.Close()
	ready.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, e := bufio.NewReader(ready).ReadBytes('\n')
	if e != nil {
		t.Fatal(e)
	}
	var row struct {
		Schema   string `json:"schema"`
		Boot     string `json:"boot"`
		PID      int    `json:"pid"`
		Origin   uint64 `json:"originMonotonicNs"`
		Deadline uint64 `json:"deadlineMonotonicNs"`
		Roots    bool   `json:"rootsGranted"`
		RPC      bool   `json:"rpcReady"`
	}
	if e = json.Unmarshal(line, &row); e != nil {
		t.Fatal(e)
	}
	boot, _ := os.ReadFile("/proc/sys/kernel/random/boot_id")
	if row.Schema != "enclave-rpc-broker-listening/1" || row.PID != cmd.Process.Pid || row.Boot != strings.TrimSpace(string(boot)) || row.Origin != origin || row.Deadline != origin+uint64(rpcservice.StartupWindow) || row.Roots || row.RPC {
		t.Fatal("invalid listener receipt", string(line))
	}
	marker, e := os.ReadFile("/run/native-rpc-storage/broker-started")
	if e != nil || string(marker)+"\n" != string(line) {
		t.Fatal("readiness preceded exact consumed record", e)
	}
	if e = protectedSocket(); e != nil {
		t.Fatal(e)
	}
	c, e := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: socketPath, Net: "unixpacket"})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	raw, e := c.SyscallConn()
	if e != nil {
		t.Fatal(e)
	}
	var peer *syscall.Ucred
	var peerErr error
	raw.Control(func(fd uintptr) {
		peer, peerErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if peerErr != nil || int(peer.Pid) != cmd.Process.Pid || int(peer.Pid) == os.Getpid() {
		t.Fatal("listener belongs to wrong process", peer, peerErr)
	}
	req, e := NewRequest(rpcBundle(t), origin)
	if e != nil {
		t.Fatal(e)
	}
	type result struct {
		a *Attempt
		e error
	}
	done := make(chan result, 1)
	go func() { a, e := acquire(c, req); done <- result{a, e} }()
	accepted := make(chan string, 1)
	go func() { s, _ := bufio.NewReader(out).ReadString('\n'); accepted <- s }()
	select {
	case s := <-accepted:
		if s != "accepted\n" {
			t.Fatal(s)
		}
	case <-time.After(time.Second):
		t.Fatal("no real session acceptance")
	}
	start := time.Now()
	if e = cmd.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	select {
	case r := <-done:
		if r.e == nil || r.a == nil || r.a.L1 != nil || r.a.Base != nil {
			t.Fatal("broker death granted roots", r.e)
		}
		t.Logf("broker-created listener actual PID %d; broker loss refused in %s before original 5s deadline", peer.Pid, time.Since(start))
		for _, f := range []*os.File{r.a.owner, r.a.peer} {
			if f != nil {
				f.Close()
			}
		}
	case <-time.After(time.Second):
		t.Fatal("broker death not observed")
	}
	// Kernel death leaves both consumed record and socket, so no second broker.
	_, w2 := ingressPipe(t)
	s, d, e := AcceptBroker(clock, w2)
	if e == nil || !os.IsExist(e) || s != nil || d != nil {
		t.Fatal("consumed namespace reused", e)
	}
	if b, e := os.ReadFile("/run/native-rpc-storage/broker-started"); e != nil || sha256.Sum256(b) != sha256.Sum256(marker) {
		t.Fatal("consumed marker changed", e)
	}
}
func TestBrokerIngressOriginalAcceptDeadline(t *testing.T) {
	privateIngressRun(t)
	clock, _ := ingressClock(t, 200*time.Millisecond)
	_, w := ingressPipe(t)
	start := time.Now()
	s, d, e := AcceptBroker(clock, w)
	ne, ok := e.(net.Error)
	if e == nil || !ok || !ne.Timeout() || s != nil || d != nil || time.Since(start) > time.Second {
		t.Fatal("accept reset original deadline", e, time.Since(start))
	}
	if _, e = os.Lstat(socketPath); e != nil {
		t.Fatal("consumed socket removed", e)
	}
}
func TestBrokerIngressRejectsStalledReadiness(t *testing.T) {
	privateIngressRun(t)
	clock, _ := ingressClock(t, 3*time.Second)
	_, w := ingressPipe(t)
	fd := int(w.Fd())
	if e := syscall.SetNonblock(fd, true); e != nil {
		t.Fatal(e)
	}
	// Fill the actual pipe; readiness must make one nonblocking write, not hang.
	for {
		_, e := syscall.Write(fd, make([]byte, 4096))
		if e == syscall.EAGAIN {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
	}
	start := time.Now()
	s, d, e := AcceptBroker(clock, w)
	if e == nil || !strings.Contains(e.Error(), "readiness unacknowledged") || s != nil || d != nil || time.Since(start) > time.Second {
		t.Fatal("stalled bootstrap not refused", e)
	}
	if _, e = os.Lstat("/run/native-rpc-storage/broker-started"); e != nil {
		t.Fatal("failed readiness not consumed", e)
	}
}
func TestBrokerIngressRejectsInvalidInputs(t *testing.T) {
	for _, mode := range []string{"regular-ready", "read-end", "unsealed-clock", "ancestor-write", "existing-namespace", "malformed-peer"} {
		t.Run(mode, func(t *testing.T) {
			privateIngressRun(t)
			clock, _ := ingressClock(t, 3*time.Second)
			r, w := ingressPipe(t)
			want := ""
			switch mode {
			case "regular-ready":
				f, e := os.CreateTemp("/tmp", "bad-ready")
				if e != nil {
					t.Fatal(e)
				}
				defer os.Remove(f.Name())
				defer f.Close()
				w = f
				want = "readiness pipe"
			case "read-end":
				w = r
				want = "readiness pipe"
			case "unsealed-clock":
				clock = r
				want = "entry"
			case "ancestor-write":
				if e := os.Chmod("/run", 0777); e != nil {
					t.Fatal(e)
				}
				defer os.Chmod("/run", 0755)
				want = "protected bootstrap ancestors"
			case "existing-namespace":
				if e := os.Mkdir("/run/native-rpc-storage", 0700); e != nil {
					t.Fatal(e)
				}
				want = "file exists"
			case "malformed-peer":
				go func() {
					bufio.NewReader(r).ReadBytes('\n')
					c, e := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: socketPath, Net: "unixpacket"})
					if e == nil {
						c.Write([]byte("invalid"))
						c.Close()
					}
				}()
				want = "exact owner pidfd"
			}
			s, d, e := AcceptBroker(clock, w)
			if e == nil || !strings.Contains(e.Error(), want) || s != nil || d != nil {
				t.Fatal("wrong refusal", mode, e)
			}
			if mode == "malformed-peer" {
				b, e := os.ReadFile("/run/native-rpc-storage/broker-started")
				if e != nil {
					t.Fatal(e)
				}
				t.Log("malformed first peer consumed namespace; marker SHA256", hex.EncodeToString(func() []byte { h := sha256.Sum256(b); return h[:] }()))
			}
		})
	}
}
