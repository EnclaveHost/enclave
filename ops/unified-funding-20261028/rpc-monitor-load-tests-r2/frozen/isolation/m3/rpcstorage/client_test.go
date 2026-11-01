//go:build linux && amd64

package rpcstorage

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

func rpcBundle(t *testing.T) []byte {
	t.Helper()
	m := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("1", 64), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}}
	b, e := contract.Build(m, []byte{0, 97, 115, 109, 13, 0, 1, 0})
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestRequestPreservesOriginalIdentityAndDeadline(t *testing.T) {
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	b := rpcBundle(t)
	origin := now - uint64(time.Second)
	r, e := NewRequest(b, origin)
	if e != nil {
		t.Fatal(e)
	}
	id := sha256.Sum256(b)
	if r.AppID != hex.EncodeToString(id[:]) || r.Origin != origin || r.Deadline != origin+uint64(rpcservice.StartupWindow) || r.L1Volume != strings.Repeat("a", 64) || r.BaseVolume != strings.Repeat("b", 64) || !contract.NonzeroHash(r.Nonce) {
		t.Fatal("changed original binding", r)
	}
	for _, o := range []uint64{now + uint64(time.Hour), now - uint64(rpcservice.StartupWindow), ^uint64(0)} {
		if _, e = NewRequest(b, o); e == nil {
			t.Fatal("invalid origin", o)
		}
	}
	if _, e = NewRequest([]byte("ordinary artifact"), origin); e == nil {
		t.Fatal("non RPC accepted")
	}
}
func pair(t *testing.T) (*net.UnixConn, *net.UnixConn) {
	t.Helper()
	fds, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_SEQPACKET|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	var out [2]*net.UnixConn
	for i, fd := range fds {
		f := os.NewFile(uintptr(fd), "fixture")
		c, e := net.FileConn(f)
		f.Close()
		if e != nil {
			t.Fatal(e)
		}
		out[i] = c.(*net.UnixConn)
		t.Cleanup(func() { c.Close() })
	}
	return out[0], out[1]
}
func TestActualGrantDescriptorsAndLoss(t *testing.T) {
	if os.Getuid() != 0 {
		t.Fatal("private user-namespace runner required")
	}
	for _, mode := range []string{"valid", "wrong-binding", "one-fd", "extra-fds", "truncated", "late"} {
		t.Run(mode, func(t *testing.T) {
			c, s := pair(t)
			roots := []*os.File{}
			for i := 0; i < 3; i++ {
				f, e := os.Open(t.TempDir())
				if e != nil {
					t.Fatal(e)
				}
				roots = append(roots, f)
				defer f.Close()
			}
			now, _ := rpcservice.MonotonicNow()
			req, e := NewRequest(rpcBundle(t), now)
			if e != nil {
				t.Fatal(e)
			}
			if mode == "late" {
				req.Origin = now - uint64(rpcservice.StartupWindow) + uint64(50*time.Millisecond)
				req.Deadline = req.Origin + uint64(rpcservice.StartupWindow)
			}
			server := make(chan error, 1)
			go func() {
				b, oob := make([]byte, 4096), make([]byte, 128)
				n, on, _, _, e := s.ReadMsgUnix(b, oob)
				if e != nil {
					server <- e
					return
				}
				fds, e := receivedRights(oob[:on])
				if e != nil || len(fds) != 1 {
					server <- fmt.Errorf("owner pidfd missing")
					return
				}
				defer syscall.Close(fds[0])
				target, e := os.Readlink(fmt.Sprintf("/proc/self/fd/%d", fds[0]))
				if e != nil || target != "anon_inode:[pidfd]" {
					server <- fmt.Errorf("not exact owner pidfd: %s %v", target, e)
					return
				}
				var received Request
				if e = json.Unmarshal(b[:n], &received); e != nil || received != req {
					server <- fmt.Errorf("request differs")
					return
				}
				h := sha256.Sum256(b[:n])
				reply := replyPrefix + hex.EncodeToString(h[:]) + "\n"
				rights := []int{int(roots[0].Fd()), int(roots[1].Fd())}
				switch mode {
				case "wrong-binding":
					reply = replyPrefix + strings.Repeat("0", 64) + "\n"
				case "one-fd":
					rights = rights[:1]
				case "extra-fds":
					rights = append(rights, int(roots[2].Fd()))
				case "truncated":
					reply = strings.Repeat("x", 300)
				case "late":
					time.Sleep(100 * time.Millisecond)
				}
				_, _, e = s.WriteMsgUnix([]byte(reply), syscall.UnixRights(rights...), nil)
				server <- e
			}()
			a, e := acquire(c, req)
			if a == nil {
				t.Fatal("lost retained attempt")
			}
			defer func() {
				if a.owner != nil {
					a.owner.Close()
				}
				if a.L1 != nil {
					a.L1.Close()
				}
				if a.Base != nil {
					a.Base.Close()
				}
			}()
			if mode != "valid" {
				if e == nil {
					t.Fatal("invalid grant accepted")
				}
				<-server
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if e = <-server; e != nil {
				t.Fatal(e)
			}
			for i, f := range []*os.File{a.L1, a.Base} {
				var x, y syscall.Stat_t
				syscall.Fstat(int(f.Fd()), &x)
				syscall.Fstat(int(roots[i].Fd()), &y)
				if x.Dev != y.Dev || x.Ino != y.Ino {
					t.Fatal("descriptor identity changed")
				}
				flags, _, e := syscall.Syscall(syscall.SYS_FCNTL, f.Fd(), syscall.F_GETFD, 0)
				if e != 0 || flags&syscall.FD_CLOEXEC == 0 {
					t.Fatal("received fd inheritable")
				}
			}
			select {
			case <-a.Loss():
				t.Fatal("live grant considered lost")
			default:
			}
			s.Close()
			select {
			case <-a.Loss():
			case <-time.After(time.Second):
				t.Fatal("broker loss not observed")
			}
		})
	}
}

func TestConsumedIntentSurvivesClosedHandle(t *testing.T) {
	now, _ := rpcservice.MonotonicNow()
	req, e := NewRequest(rpcBundle(t), now)
	if e != nil {
		t.Fatal(e)
	}
	path, e := os.MkdirTemp("/tmp", "rpc-intent-")
	if e != nil {
		t.Fatal(e)
	}
	defer os.RemoveAll(path)
	if e = os.Chmod(path, 0700); e != nil {
		t.Fatal(e)
	}
	d, e := os.Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer d.Close()
	f, e := consumeIntent(d, req)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = f.Write([]byte("replace")); e == nil {
		t.Fatal("retained intent is writable")
	}
	raw, e := os.ReadFile(path + "/attempt")
	if e != nil {
		t.Fatal(e)
	}
	var got Request
	if e = json.Unmarshal(raw, &got); e != nil || got != req {
		t.Fatal("intent differs", e)
	}
	f.Close()
	req.Nonce = strings.Repeat("d", 64)
	if _, e = consumeIntent(d, req); e == nil {
		t.Fatal("closed first attempt replayed")
	}
}
