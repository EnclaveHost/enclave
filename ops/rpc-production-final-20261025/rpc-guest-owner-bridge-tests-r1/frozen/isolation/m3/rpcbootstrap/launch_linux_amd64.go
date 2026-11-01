//go:build linux && amd64

package rpcbootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

const brokerExecutable = "/plat/native-rpc/rpc-storage-broker"

// Broker retains exact local process/group capabilities. Stop is a kill request,
// not confirmation of death, a writer fence, or reservation release. No detach,
// close, namespace deletion, restart or adoption API exists.
type Broker struct {
	group, kill, pidfd *os.File
	pid                int
	done               chan struct{}
	stop               sync.Once
}

func (b *Broker) Stop() {
	if b != nil {
		b.stop.Do(func() {
			if b.kill != nil {
				_, _ = b.kill.Write([]byte("1"))
			}
		})
	}
}
func (b *Broker) Done() <-chan struct{} { return b.done }
func (b *Broker) LocalDead() bool {
	if b == nil || b.pidfd == nil {
		return false
	}
	dead, e := pidSignaled(b.pidfd)
	if e != nil || !dead {
		return false
	}
	empty, e := rpcservice.BrokerGroupEmpty(b.group)
	return e == nil && empty
}
func pidSignaled(f *os.File) (bool, error) {
	if f == nil {
		return false, errors.New("exact process handle missing")
	}
	p := struct {
		FD              int32
		Events, Revents int16
	}{FD: int32(f.Fd()), Events: 1}
	ts := syscall.Timespec{}
	_, _, e := syscall.Syscall6(syscall.SYS_PPOLL, uintptr(unsafe.Pointer(&p)), 1, uintptr(unsafe.Pointer(&ts)), 0, 0, 0)
	if e != 0 {
		return false, e
	}
	if p.Revents & ^int16(1|16) != 0 {
		return false, errors.New("invalid process poll")
	}
	return p.Revents != 0, nil
}

// StartBroker uses only the guest-generated credential. The local owner bridge
// supplies public policy and a pinned export certificate through fixed protected
// paths; these do NOT prove owner authority. Broker verifies chain authorization
// and signed volume/export proof independently after monitor acquisition.
// A consumed launch failure closes the identity and wakes the waiting load.
func (i *Identity) StartBroker(boot, digest string, clock *os.File, bundle []byte) (b *Broker, err error) {
	if err = i.beginLaunch(boot, digest); err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			i.Close()
			b.Stop()
		}
	}()
	i.mu.Lock()
	prepared := i.ownerPrepared
	i.mu.Unlock()
	if !prepared {
		return nil, errors.New("owner public inputs not prepared")
	}
	pub, err := i.Public()
	if err != nil {
		return nil, err
	}
	origin, err := rpcservice.OriginalEntryOrigin(clock)
	if err != nil {
		return nil, err
	}
	if origin != pub.Request.Origin {
		return nil, errors.New("broker original clock differs")
	}
	sum := sha256.Sum256(bundle)
	if hex.EncodeToString(sum[:]) != pub.Request.AppID {
		return nil, errors.New("broker loaded bundle differs")
	}
	now, err := rpcservice.MonotonicNow()
	if err != nil || now < pub.Request.Origin || now >= pub.Request.Deadline {
		return nil, errors.New("original broker launch window ended")
	}
	left := pub.Request.Deadline - now
	if left > uint64(3*time.Second) {
		left = uint64(3 * time.Second)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(left))
	defer cancel()
	dir, err := protectedDir("/run/native-rpc-owner")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	policy, err := readPublicAt(dir, "policy.json", 2<<20)
	if err != nil {
		return nil, err
	}
	server, err := readPublicAt(dir, "server.der", 16384)
	if err != nil {
		return nil, err
	}
	if err = boundPolicy(policy, pub, bundle); err != nil {
		return nil, err
	}
	// The owner-input producer has already consumed the fixed namespace. FD7
	// is now a readonly public bootstrap record, never a host Unix relay socket.
	rawBootstrap, err := readPublicAt(dir, "owner-bootstrap.json", 12<<20)
	if err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(int(dir.Fd()), "owner-bootstrap.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	relay := os.NewFile(uintptr(fd), "owner-bootstrap")
	defer relay.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Size != int64(len(rawBootstrap)) {
		return nil, errors.New("owner bootstrap changed")
	}
	held := make([]byte, len(rawBootstrap)+1)
	n, e := syscall.Pread(fd, held, 0)
	if e != nil || n != len(rawBootstrap) || !bytes.Equal(held[:n], rawBootstrap) {
		return nil, errors.New("owner bootstrap replaced")
	}
	parent, err := protectedDir("/sys/fs/cgroup")
	if err != nil {
		return nil, err
	}
	defer parent.Close()
	return i.launch(ctx, clock, bundle, policy, server, relay, parent)
}
func (i *Identity) beginLaunch(boot, digest string) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	if e := i.check(boot, digest); e != nil {
		return e
	}
	if !i.reported || i.launchUsed || i.acquireUsed || i.keyUsed {
		return errors.New("reported unused bootstrap launch required")
	}
	i.launchUsed = true
	return nil
}
func boundPolicy(raw []byte, p Public, bundle []byte) error {
	var policy struct {
		Schema        string   `json:"schema"`
		Runtime       string   `json:"runtime"`
		BundleSHA256  string   `json:"bundleSha256"`
		Manifest      []byte   `json:"manifest"`
		ChainID       uint64   `json:"chainId"`
		Ledger        string   `json:"ledger"`
		RPCs          []string `json:"rpcs"`
		Confirmations uint64   `json:"confirmations"`
		MaxAgeSeconds uint64   `json:"maxAgeSeconds"`
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if e := dec.Decode(&policy); e != nil {
		return e
	}
	typed, _ := json.Marshal(policy)
	var value any
	dec = json.NewDecoder(bytes.NewReader(typed))
	dec.UseNumber()
	if e := dec.Decode(&value); e != nil {
		return e
	}
	canonical, _ := json.Marshal(value)
	rid, e := contract.RuntimeID(p.Runtime)
	if e != nil {
		return e
	}
	sum := sha256.Sum256(bundle)
	if !bytes.Equal(bytes.TrimSpace(raw), canonical) || policy.Schema != "enclave-rpc-broker-policy/1" || policy.Runtime != hex.EncodeToString(rid[:]) || policy.BundleSHA256 != hex.EncodeToString(sum[:]) || len(policy.Manifest) == 0 || len(policy.Manifest) > 65536 || policy.MaxAgeSeconds == 0 || policy.MaxAgeSeconds > 120 {
		return errors.New("broker policy must bind loaded runtime and bundle")
	}
	return nil
}
func protectedDir(path string) (*os.File, error) {
	f, e := os.Open("/")
	if e != nil {
		return nil, e
	}
	for _, name := range append([]string{"."}, strings.Split(strings.TrimPrefix(path, "/"), "/")...) {
		fd, e := syscall.Openat(int(f.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		f.Close()
		if e != nil {
			return nil, e
		}
		f = os.NewFile(uintptr(fd), name)
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&0022 != 0 {
			f.Close()
			return nil, errors.New("protected root ancestors required")
		}
	}
	return f, nil
}
func readPublicAt(dir *os.File, name string, max int64) ([]byte, error) {
	fd, e := syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	var st, after syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0600 || st.Nlink != 1 || st.Size <= 0 || st.Size > max {
		return nil, errors.New("bounded private public input required")
	}
	raw, e := io.ReadAll(io.LimitReader(f, max+1))
	if e != nil {
		return nil, e
	}
	if syscall.Fstat(fd, &after) != nil || st.Dev != after.Dev || st.Ino != after.Ino || st.Size != after.Size || st.Mode != after.Mode || st.Uid != after.Uid || st.Nlink != after.Nlink || st.Mtim != after.Mtim || st.Ctim != after.Ctim || int64(len(raw)) != st.Size {
		return nil, errors.New("public input changed")
	}
	return raw, nil
}
func privateFile(dir *os.File, name string, raw []byte) (*os.File, error) {
	fd, e := syscall.Openat(int(dir.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if e != nil {
		return nil, e
	}
	f := os.NewFile(uintptr(fd), name)
	n, e := f.Write(raw)
	if e == nil && n != len(raw) {
		e = io.ErrShortWrite
	}
	if e == nil {
		e = f.Sync()
	}
	f.Close()
	if e != nil {
		return nil, e
	}
	fd, e = syscall.Openat(int(dir.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return nil, e
	}
	return os.NewFile(uintptr(fd), name), nil
}

// parent is a held real delegation. Production always opens the fixed guest
// root; the native fixture supplies only its actual disposable delegation.
func (i *Identity) launch(ctx context.Context, clock *os.File, bundle, policy, server []byte, relay, parent *os.File) (b *Broker, err error) {
	pub, err := i.Public()
	if err != nil {
		return nil, err
	}
	if err = boundPolicy(policy, pub, bundle); err != nil {
		return nil, err
	}
	credential, err := i.TakeCredential()
	if err != nil {
		return nil, err
	}
	key, err := x509.MarshalPKCS8PrivateKey(credential.PrivateKey)
	if err != nil {
		return nil, err
	}
	defer clear(key)
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key})
	defer clear(keyPEM)
	cert := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: credential.Certificate[0]})
	run, err := protectedDir("/run")
	if err != nil {
		return nil, err
	}
	defer run.Close()
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(run.Fd()), &fs) != nil || fs.Type != 0x01021994 || fs.Flags&1 != 0 {
		return nil, errors.New("private writable guest tmpfs required")
	}
	if err = syscall.Mkdirat(int(run.Fd()), "native-rpc-broker-inputs", 0700); err != nil {
		return nil, err
	}
	dir, err := protectedDir("/run/native-rpc-broker-inputs")
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	// Permanent intent precedes credential files, cgroup setup and first child.
	intent, _ := json.Marshal(pub.Request)
	mark, err := privateFile(dir, "launch-intent", intent)
	if err != nil {
		return nil, err
	}
	mark.Close()
	if err = dir.Sync(); err != nil {
		return nil, err
	}
	files := make([]*os.File, 0, 5)
	defer func() {
		for _, f := range files {
			f.Close()
		}
	}()
	for _, v := range []struct {
		name string
		raw  []byte
	}{{"policy.json", policy}, {"bundle", bundle}, {"server.der", server}, {"client.pem", cert}, {"client-key.pem", keyPEM}} {
		f, e := privateFile(dir, v.name, v.raw)
		if e != nil {
			return nil, e
		}
		files = append(files, f)
	}
	if err = dir.Sync(); err != nil {
		return nil, err
	}
	plat, err := protectedDir("/plat/native-rpc")
	if err != nil {
		return nil, err
	}
	defer plat.Close()
	fd, err := syscall.Openat(int(plat.Fd()), "rpc-storage-broker", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	exe := os.NewFile(uintptr(fd), brokerExecutable)
	defer exe.Close()
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&0222 != 0 || st.Mode&0111 == 0 || st.Nlink != 1 || st.Size <= 0 || st.Size > 32<<20 || syscall.Fstatfs(fd, &fs) != nil || fs.Flags&1 == 0 {
		return nil, errors.New("fixed immutable broker executable required")
	}
	b = &Broker{done: make(chan struct{})}
	b.group, b.kill, err = rpcservice.PrepareBrokerGroup(parent, pub.Request.Nonce)
	if err != nil {
		return b, err
	}
	defer func() {
		if err != nil {
			b.Stop()
		}
	}()
	r, w, err := os.Pipe()
	if err != nil {
		return b, err
	}
	defer r.Close()
	defer w.Close()
	// fd11 is the held immutable executable; it is not a listener capability.
	cmd := exec.Command("/proc/self/fd/11")
	cmd.Args = []string{"rpc-storage-broker"}
	cmd.Env = []string{"GOMAXPROCS=1", "GOMEMLIMIT=96MiB"}
	cmd.ExtraFiles = []*os.File{clock, w, files[0], files[1], relay, files[2], files[3], files[4], exe}
	pidfd := -1
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: int(b.group.Fd()), PidFD: &pidfd, Pdeathsig: syscall.SIGKILL}
	if err = ctx.Err(); err != nil {
		return b, err
	}
	if err = current(pub.Request); err != nil {
		return b, err
	}
	started := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		e := cmd.Start()
		started <- e
		if e == nil {
			_ = cmd.Wait()
		}
		close(b.done)
	}()
	// clone/exec itself is covered by independent PID1 original deadline. Never
	// return and close borrowed FDs while Start is still using them.
	if err = <-started; err != nil {
		return b, err
	}
	b.pid = cmd.Process.Pid
	if pidfd < 0 {
		return b, errors.New("atomic broker pidfd missing")
	}
	b.pidfd = os.NewFile(uintptr(pidfd), "broker-pidfd")
	w.Close()
	if err = readListening(ctx, r, b, pub); err != nil {
		return b, err
	}
	return b, nil
}
func readListening(ctx context.Context, r *os.File, b *Broker, p Public) error {
	fd := int(r.Fd())
	if e := syscall.SetNonblock(fd, true); e != nil {
		return e
	}
	raw := make([]byte, 1025)
	used := 0
	for {
		if e := ctx.Err(); e != nil {
			return e
		}
		if e := current(p.Request); e != nil {
			return e
		}
		dead, e := pidSignaled(b.pidfd)
		if e != nil {
			return e
		}
		if dead {
			return errors.New("broker exited before listening")
		}
		n, e := syscall.Read(fd, raw[used:])
		if n > 0 {
			used += n
			if used > 1024 {
				return errors.New("oversized broker listening record")
			}
		}
		if e == nil && n == 0 {
			break
		}
		if e != nil && e != syscall.EAGAIN && e != syscall.EINTR {
			return e
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Millisecond):
		}
	}
	want, _ := json.Marshal(map[string]any{"schema": "enclave-rpc-broker-listening/1", "boot": p.Request.Boot, "pid": b.pid, "originMonotonicNs": p.Request.Origin, "deadlineMonotonicNs": p.Request.Deadline, "rootsGranted": false, "rpcReady": false})
	if !bytes.Equal(raw[:used], append(want, '\n')) {
		return errors.New("broker listening identity/clock differs")
	}
	if e := rpcservice.VerifyBrokerGroup(b.group, b.pid); e != nil {
		return e
	}
	dead, e := pidSignaled(b.pidfd)
	if e != nil {
		return e
	}
	if dead {
		return errors.New("broker died during readiness")
	}
	return ctx.Err()
}
