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

// Fixture roots test the monitor wire contract, not NBD attachment or ownership.
func TestStagedAcquisitionPreservesOriginalWindow(t *testing.T) {
	for _, mode := range []string{"slow-grant", "original-expiry", "missing-ack", "wrong-ack", "ack-rights", "truncated-ack", "repeated-ack", "grant-without-ack"} {
		t.Run(mode, func(t *testing.T) {
			c, s := pair(t)
			now, _ := rpcservice.MonotonicNow()
			req, e := NewRequest(rpcBundle(t), now)
			if e != nil {
				t.Fatal(e)
			}
			if mode == "original-expiry" {
				req.Origin = now - uint64(rpcservice.StartupWindow) + uint64(250*time.Millisecond)
				req.Deadline = req.Origin + uint64(rpcservice.StartupWindow)
			}
			root, e := os.Open(t.TempDir())
			if e != nil {
				t.Fatal(e)
			}
			defer root.Close()
			finished := make(chan struct{})
			go func() {
				defer close(finished)
				b, oob := make([]byte, 2048), make([]byte, 128)
				n, on, _, _, err := s.ReadMsgUnix(b, oob)
				if err != nil {
					return
				}
				rights, _ := receivedRights(oob[:on])
				for _, fd := range rights {
					syscall.Close(fd)
				}
				hash := sha256.Sum256(b[:n])
				binding := hex.EncodeToString(hash[:]) + "\n"
				ack := acceptedPrefix + binding
				var fds []byte
				switch mode {
				case "missing-ack":
					time.Sleep(3200 * time.Millisecond)
					return
				case "wrong-ack":
					ack = acceptedPrefix + strings.Repeat("0", 64) + "\n"
				case "ack-rights":
					fds = syscall.UnixRights(int(root.Fd()))
				case "truncated-ack":
					ack = strings.Repeat("x", 300)
				case "grant-without-ack":
					ack = replyPrefix + binding
					fds = syscall.UnixRights(int(root.Fd()), int(root.Fd()))
				}
				if _, _, err = s.WriteMsgUnix([]byte(ack), fds, nil); err != nil {
					return
				}
				switch mode {
				case "slow-grant":
					time.Sleep(3200 * time.Millisecond)
				case "original-expiry":
					time.Sleep(400 * time.Millisecond)
				case "repeated-ack":
					s.WriteMsgUnix([]byte(ack), nil, nil)
					return
				default:
					return
				}
				s.WriteMsgUnix([]byte(replyPrefix+binding), syscall.UnixRights(int(root.Fd()), int(root.Fd())), nil)
			}()
			started := time.Now()
			a, e := acquire(c, req)
			elapsed := time.Since(started)
			if a == nil {
				t.Fatal("lost consumed attempt")
			}
			if mode == "slow-grant" {
				if e != nil || a.L1 == nil || a.Base == nil || elapsed < 3*time.Second {
					t.Fatalf("accepted stage did not retain original window: %v %v", elapsed, e)
				}
				s.Close()
				select {
				case <-a.Loss():
				case <-time.After(time.Second):
					t.Fatal("loss not observed")
				}
			} else {
				if e == nil {
					t.Fatal("invalid acquisition granted")
				}
				if mode == "original-expiry" && elapsed > 750*time.Millisecond {
					t.Fatal("original deadline reset", elapsed)
				}
				if mode == "missing-ack" && elapsed > 3500*time.Millisecond {
					t.Fatal("ack cutoff extended", elapsed)
				}
				select {
				case <-a.Loss():
				default:
					t.Fatal("failed acquisition gate left open")
				}
			}
			<-finished
			for _, f := range []*os.File{a.owner, a.peer, a.L1, a.Base} {
				if f != nil {
					f.Close()
				}
			}
		})
	}
}

func TestAcceptanceOnlyOnceAndNoRoots(t *testing.T) {
	c, s := pair(t)
	now, _ := rpcservice.MonotonicNow()
	req, e := NewRequest(rpcBundle(t), now)
	if e != nil {
		t.Fatal(e)
	}
	clock, e := rpcservice.NewEntryContract(now)
	if e != nil {
		t.Fatal(e)
	}
	defer clock.Close()
	fd, _, eno := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if eno != 0 {
		t.Fatal(eno)
	}
	defer syscall.Close(int(fd))
	b, _ := json.Marshal(req)
	c.WriteMsgUnix(b, syscall.UnixRights(int(fd)), nil)
	session, e := ReceiveBrokerSession(s, clock)
	if e != nil {
		t.Fatal(e)
	}
	defer func() { session.Stop(); <-session.done; session.peer.Close(); session.owner.Close() }()
	if e = session.Acknowledge(); e != nil {
		t.Fatal(e)
	}
	packet, oob := make([]byte, 256), make([]byte, 128)
	c.SetReadDeadline(time.Now().Add(time.Second))
	n, on, flags, _, e := c.ReadMsgUnix(packet, oob)
	hash := sha256.Sum256(b)
	if e != nil || flags&(syscall.MSG_TRUNC|syscall.MSG_CTRUNC) != 0 || on != 0 || string(packet[:n]) != acceptedPrefix+hex.EncodeToString(hash[:])+"\n" {
		t.Fatal("acceptance altered binding or transferred roots", e)
	}
	if session.reserved || session.consent != nil {
		t.Fatal("acceptance manufactured authority")
	}
	if e = session.Acknowledge(); e == nil {
		t.Fatal("repeat acceptance permitted")
	}
	select {
	case <-session.Context().Done():
	case <-time.After(time.Second):
		t.Fatal("repeat did not close gate")
	}
}

func TestAcquisitionBrokerHelper(t *testing.T) {
	if os.Getenv("RPC_ACQUISITION_HELPER") != "1" {
		t.Skip("isolated exact-peer fixture")
	}
	l, e := net.ListenUnix("unixpacket", &net.UnixAddr{Name: os.Getenv("RPC_ACQUISITION_SOCKET"), Net: "unixpacket"})
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	fmt.Println("listening")
	l.SetDeadline(time.Now().Add(3 * time.Second))
	c, e := l.AcceptUnix()
	if e != nil {
		t.Fatal(e)
	}
	session, e := ReceiveBrokerSession(c, os.NewFile(3, "original-clock"))
	if e != nil {
		t.Fatal(e)
	}
	if e = session.Acknowledge(); e != nil {
		t.Fatal(e)
	}
	// External controller holds this duplicate, so killing this broker does NOT
	// produce socket EOF. The monitor must act on its preheld SO_PEERPIDFD.
	f, e := c.File()
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	control, e := net.FileConn(os.NewFile(4, "controller"))
	if e != nil {
		t.Fatal(e)
	}
	defer control.Close()
	if _, _, e = control.(*net.UnixConn).WriteMsgUnix([]byte("held"), syscall.UnixRights(int(f.Fd())), nil); e != nil {
		t.Fatal(e)
	}
	time.Sleep(10 * time.Second)
}

func TestStagedAcquisitionDetectsExactBrokerDeathWithSocketRetained(t *testing.T) {
	dir, e := os.MkdirTemp("/tmp", "rpc-acquire-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(dir)
	now, _ := rpcservice.MonotonicNow()
	origin := now - uint64(rpcservice.StartupWindow) + uint64(5*time.Second)
	clock, e := rpcservice.NewEntryContract(origin)
	if e != nil {
		t.Fatal(e)
	}
	defer clock.Close()
	parent, child := pair(t)
	childFD, e := child.File()
	if e != nil {
		t.Fatal(e)
	}
	defer childFD.Close()
	cmd := exec.Command(os.Args[0], "-test.run=^TestAcquisitionBrokerHelper$")
	cmd.ExtraFiles = []*os.File{clock, childFD}
	cmd.Env = append(os.Environ(), "RPC_ACQUISITION_HELPER=1", "RPC_ACQUISITION_SOCKET="+dir+"/s")
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	cmd.Stderr = os.Stderr
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	ready := make(chan string, 1)
	go func() { line, _ := bufio.NewReader(out).ReadString('\n'); ready <- line }()
	select {
	case line := <-ready:
		if line != "listening\n" {
			t.Fatal(line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("listener absent")
	}
	c, e := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: dir + "/s", Net: "unixpacket"})
	if e != nil {
		t.Fatal(e)
	}
	defer c.Close()
	req, e := NewRequest(rpcBundle(t), origin)
	if e != nil {
		t.Fatal(e)
	}
	type result struct {
		a *Attempt
		e error
	}
	resultC := make(chan result, 1)
	go func() { a, e := acquire(c, req); resultC <- result{a, e} }()
	parent.SetReadDeadline(time.Now().Add(2 * time.Second))
	packet, oob := make([]byte, 16), make([]byte, 128)
	n, on, _, _, e := parent.ReadMsgUnix(packet, oob)
	if e != nil || string(packet[:n]) != "held" {
		t.Fatal("external socket hold missing", e)
	}
	rights, e := receivedRights(oob[:on])
	if e != nil || len(rights) != 1 {
		t.Fatal("missing duplicate", e)
	}
	defer syscall.Close(rights[0])
	start := time.Now()
	if e = cmd.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	select {
	case got := <-resultC:
		elapsed := time.Since(start)
		if got.e == nil || got.a.L1 != nil || got.a.Base != nil || elapsed > time.Second {
			t.Fatal("exact peer death not enforced", elapsed, got.e)
		}
		if pid, e := pidfdPID(got.a.peer); e == nil && pid > 0 { // A zombie can retain Pid until reaped; poll is authoritative.
			dead, pe := pollBroker([]brokerPoll{{int32(got.a.peer.Fd()), 1, 0}}, 0)
			if pe != nil || !dead {
				t.Fatal("broker pidfd not terminal")
			}
		}
		t.Logf("exact broker death refused acquisition in %s with socket duplicate held and original 5s deadline", elapsed)
		for _, f := range []*os.File{got.a.peer, got.a.owner} {
			if f != nil {
				f.Close()
			}
		}
	case <-time.After(time.Second):
		t.Fatal("monitor waited for socket EOF or original deadline after broker death")
	}
}
