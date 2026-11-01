//go:build linux && amd64

// Package rpcdomain prepares the distinct monitor-owned CPU RPC domain. It
// does not enable an ordinary/desktop monitor, accept a host launcher path,
// attach storage, provision secrets or start a process.
package rpcdomain

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcplatform"
	"enclave.host/isolation/m3/rpcservice"
)

const claimDirectory = "/run/native-rpc-claim"

type binding struct {
	AppID      string `json:"appId"`
	BaseVolume string `json:"baseVolume"`
	Deployment string `json:"deployment"`
	L1Volume   string `json:"l1Volume"`
	Nonce      string `json:"nonce"`
	Origin     uint64 `json:"originMonotonicNs"`
	Profile    string `json:"profile"`
	Schema     string `json:"schema"`
}

// Prepared hides capabilities until a single transfer. A failure leaves the
// guest claim/cgroup names consumed, including partial preparation failures.
type Prepared struct {
	mu                     sync.Mutex
	taken                  bool
	installed              *rpcplatform.Installed
	groups                 *rpcservice.PreparedGroups
	owner, deadline, claim *os.File
	binding                binding
}

type Capabilities struct {
	AppID, ProfileID, ClaimID, Deployment, L1VolumeID, BaseVolumeID string
	Root, Entry, Owner, Deadline, Control, Claim                    *os.File
	Groups                                                          rpcservice.Groups
	RootMountID                                                     uint64
}

// Prepare requires the original admission timestamp captured before download,
// authentication and all preparation. It verifies actual installed resources
// before consuming a per-boot claim, then creates the matching cgroups. A
// monitor caller must independently authorize the wallet/deployment and retain
// its startup guardian; this function supplies no host/wallet authority.
func Prepare(bundle []byte, originalOrigin uint64) (result *Prepared, err error) {
	if os.Getuid() != 0 || os.Geteuid() != 0 || len(bundle) > contract.MaxRPCControllerBytes+(1<<20) {
		return nil, errors.New("bounded RPC bundle in trusted root monitor required")
	}
	man, art, err := contract.ParseRPC(bundle)
	if err != nil {
		return nil, err
	}
	deadline, err := rpcservice.NewEntryContract(originalOrigin)
	if err != nil {
		return nil, err
	}
	p := &Prepared{deadline: deadline}
	defer func() {
		if err != nil {
			p.abandonUnused()
		}
	}()
	p.installed, err = rpcplatform.OpenInstalled()
	if err != nil {
		return nil, err
	}
	if err = p.installed.Profile.CheckBundle(man, art); err != nil {
		return nil, err
	}
	var si syscall.Sysinfo_t
	if err = syscall.Sysinfo(&si); err != nil {
		return nil, err
	}
	if runtime.NumCPU() < 4 || si.Unit == 0 || si.Totalram > ^uint64(0)/uint64(si.Unit) || si.Totalram*uint64(si.Unit) < 20<<30 {
		return nil, errors.New("RPC requires four CPUs and 19 GiB plus 1 GiB platform reserve")
	}
	// The exact owner is this monitor process, never a host-provided numeric PID.
	fd, _, e := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if e != 0 {
		return nil, e
	}
	p.owner = os.NewFile(fd, "rpc-monitor-owner")
	sum := contract.AppID(bundle)
	p.binding = binding{AppID: hex.EncodeToString(sum[:]), BaseVolume: man.RPC.BaseVolumeID, Deployment: man.SecretDeployment, L1Volume: man.RPC.L1VolumeID, Origin: originalOrigin, Profile: p.installed.Identity, Schema: "enclave-rpc-domain-claim/1"}
	nonce := make([]byte, 32)
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	p.binding.Nonce = hex.EncodeToString(nonce)
	d, err := openClaimDirectory()
	if err != nil {
		return nil, err
	}
	if err = withinOriginal(originalOrigin); err != nil {
		d.Close()
		return nil, err
	}
	p.claim, err = consumeClaim(d, p.binding)
	d.Close()
	if err != nil {
		return nil, err
	}
	cg, err := protectedDirectory("/sys/fs/cgroup")
	if err != nil {
		return nil, err
	}
	p.groups, err = rpcservice.PrepareGroups(cg, p.binding.Nonce)
	cg.Close()
	if err != nil {
		return nil, err
	}
	if err = withinOriginal(originalOrigin); err != nil {
		return nil, err
	}
	return p, nil
}
func withinOriginal(origin uint64) error {
	now, err := rpcservice.MonotonicNow()
	if err != nil {
		return err
	}
	if now < origin || now-origin >= uint64(rpcservice.StartupWindow) {
		return errors.New("RPC original startup window expired")
	}
	return nil
}

// protectedDirectory rejects symlink components and writable ancestors. The
// fixed measured guest namespace is authoritative; root metadata is not remote
// host or wallet authentication.
func protectedDirectory(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/") || path == "/" {
		return nil, errors.New("absolute protected directory required")
	}
	fd, err := syscall.Open("/", syscall.O_DIRECTORY|syscall.O_RDONLY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(path[1:], "/") {
		if part == "" || part == "." || part == ".." {
			syscall.Close(fd)
			return nil, errors.New("invalid protected path")
		}
		next, e := syscall.Openat(fd, part, syscall.O_DIRECTORY|syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil || st.Uid != 0 || st.Mode&0022 != 0 {
			syscall.Close(fd)
			return nil, errors.New("unsafe directory ancestor")
		}
	}
	return os.NewFile(uintptr(fd), path), nil
}
func openClaimDirectory() (*os.File, error) {
	run, err := protectedDirectory("/run")
	if err != nil {
		return nil, err
	}
	defer run.Close()
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(run.Fd()), &fs) != nil || fs.Type != 0x01021994 {
		return nil, errors.New("RPC claim requires boot-local tmpfs")
	}
	err = syscall.Mkdirat(int(run.Fd()), "native-rpc-claim", 0700)
	if err != nil && err != syscall.EEXIST {
		return nil, err
	}
	return protectedDirectory(claimDirectory)
}
func consumeClaim(d *os.File, b binding) (*os.File, error) {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if d == nil || syscall.Fstat(int(d.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&07777 != 0700 || syscall.Fstatfs(int(d.Fd()), &fs) != nil || fs.Type != 0x01021994 {
		return nil, errors.New("root-only tmpfs claim directory required")
	}
	if b.Schema != "enclave-rpc-domain-claim/1" || !contract.NonzeroHash(b.AppID) || !contract.NonzeroHash(b.Profile) || !contract.NonzeroHash(b.Nonce) || !contract.NonzeroHash(b.L1Volume) || !contract.NonzeroHash(b.BaseVolume) || b.L1Volume == b.BaseVolume || len(b.Deployment) != 66 || !strings.HasPrefix(b.Deployment, "0x") || !contract.NonzeroHash(b.Deployment[2:]) {
		return nil, errors.New("invalid claim binding")
	}
	raw, err := json.Marshal(b)
	if err != nil {
		return nil, err
	}
	raw = append(raw, '\n')
	fd, err := syscall.Openat(int(d.Fd()), "claimed", syscall.O_RDWR|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "rpc-consumed-claim")
	fail := func(e error) (*os.File, error) { f.Close(); return nil, e }
	if n, e := f.Write(raw); e != nil {
		return fail(e)
	} else if n != len(raw) {
		return fail(io.ErrShortWrite)
	}
	if err = f.Chmod(0400); err != nil {
		return fail(err)
	}
	if err = f.Sync(); err != nil {
		return fail(err)
	}
	if err = d.Sync(); err != nil {
		return fail(err)
	}
	check := make([]byte, len(raw)+1)
	n, e := f.ReadAt(check, 0)
	if n != len(raw) || e != io.EOF || string(check[:n]) != string(raw) {
		return fail(errors.New("claim readback differs"))
	}
	// Retain a read-only descriptor, not the writable construction handle.
	var before, after syscall.Stat_t
	if err = syscall.Fstat(int(f.Fd()), &before); err != nil {
		return fail(err)
	}
	ro, e := syscall.Openat(int(d.Fd()), "claimed", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if e != nil {
		return fail(e)
	}
	rf := os.NewFile(uintptr(ro), "rpc-consumed-claim")
	if syscall.Fstat(ro, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino || after.Nlink != 1 || after.Mode&07777 != 0400 {
		rf.Close()
		return fail(errors.New("claim identity changed"))
	}
	f.Close()
	return rf, nil
}
func (p *Prepared) abandonUnused() error {
	var errs []error
	if p.groups != nil {
		errs = append(errs, p.groups.Abandon())
	}
	if p.installed != nil {
		errs = append(errs, p.installed.Close())
	}
	for _, f := range []*os.File{p.owner, p.deadline, p.claim} {
		if f != nil {
			errs = append(errs, f.Close())
		}
	}
	return errors.Join(errs...)
}

// Abandon cannot release transferred handles. It never unlinks the claim or
// deletes cgroups, and it says nothing about storage or capacity release.
func (p *Prepared) Abandon() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken {
		return errors.New("RPC preparation already transferred")
	}
	p.taken = true
	return p.abandonUnused()
}

// Take is not launch permission. The monitor must first bind authenticated
// app-owned state, role writes/JWT/network and an outer independent guardian.
// All capabilities remain held while clone, cleanup or any writer is uncertain.
func (p *Prepared) Take() (Capabilities, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken {
		return Capabilities{}, errors.New("RPC preparation already consumed")
	}
	if err := withinOriginal(p.binding.Origin); err != nil {
		return Capabilities{}, err
	}
	g, c, err := p.groups.Take()
	if err != nil {
		return Capabilities{}, err
	}
	p.taken = true
	b := p.binding
	return Capabilities{AppID: b.AppID, ProfileID: b.Profile, ClaimID: b.Nonce, Deployment: b.Deployment, L1VolumeID: b.L1Volume, BaseVolumeID: b.BaseVolume, Root: p.installed.Root, Entry: p.installed.Entry, Owner: p.owner, Deadline: p.deadline, Claim: p.claim, Control: c, Groups: g, RootMountID: p.installed.RootMountID}, nil
}
