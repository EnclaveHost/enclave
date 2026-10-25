package main

import (
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/shieldbridge"
	"enclave.host/isolation/m2/shieldconfig"
	"enclave.host/isolation/m3/desktop"
	"enclave.host/isolation/m3/desktopworker"
)

// Native is a separate measured monitor/domexec build and a single-use guest.
// No load request can select its profile, mounts, executables, UIDs or worker.
const nativeClaimDir = "/run/native-desktop-claim"
const nativeRootPath = "/plat/native-desktop/rootfs"
const nativeModelPath = "/native-models"
const nativeRuntimeUID = 5001

//go:embed native-network.nft
var nativeNetworkPolicy string

type nativeGuest struct {
	profile desktop.Profile
	sha     string
}

type nativeDomain struct {
	monitor    *monitor
	claim      *desktop.Claim
	resources  *desktop.Resources
	group      *desktop.Group
	lease      *desktopworker.Lease
	cancel     context.CancelFunc
	brokerDone chan struct{}
	mounts     []string // successful mounts in the monitor's namespace, in creation order
	dirOwned   bool
	vcpus      int
	gpuMilli   int
	bundle     []byte
}

func (m *monitor) initNativeGuest() error {
	if !nativeDesktopBuild || m.snp || m.hostPort == 0 || m.plat != "/plat" || m.root != "/domains" || m.baseUID != 5000 {
		return errors.New("native guest requires its fixed dedicated T0-hv platform")
	}
	var kernel syscall.Utsname
	if err := syscall.Uname(&kernel); err != nil {
		return err
	}
	var release strings.Builder
	for _, c := range kernel.Release {
		if c == 0 {
			break
		}
		release.WriteByte(byte(c))
	}
	if release.String() != desktop.KernelRelease {
		return errors.New("native guest kernel differs from the fixed profile")
	}
	p, sha, err := desktop.ReadInstalled("/plat/native-desktop")
	if err != nil {
		return err
	}
	r, err := p.OpenMounted(nativeRootPath, nativeModelPath)
	if err != nil {
		return err
	}
	if err = r.Close(); err != nil {
		return err
	}
	// Never remove or remount this directory: its atomic claim survives monitor
	// restart. AcquireClaim verifies all ancestors, mode and actual tmpfs later.
	if err = os.Mkdir(nativeClaimDir, 0700); err != nil && !os.IsExist(err) {
		return err
	}
	m.native = &nativeGuest{profile: p, sha: sha}
	return nil
}

func (g *nativeGuest) validate(man contract.Manifest, artifact []byte, cpu, mem int) error {
	if err := g.profile.CheckBundle(man, artifact); err != nil {
		return err
	}
	if cpu != man.Policy.CPUPercent || mem < man.Policy.MemMiB {
		return errors.New("native allocation differs from its measured CPU or memory floor")
	}
	if _, err := desktop.Limits(cpu, mem, man.Policy.Vcpus); err != nil {
		return err
	}
	cfg, err := man.AppConfig()
	if err != nil {
		return err
	}
	if !shieldconfig.PublicWebMode(string(cfg)) {
		return errors.New("native desktop requires measured public-web egress")
	}
	return nil
}

func (m *monitor) poisonNative(err error) {
	m.mu.Lock()
	m.noDomains = "native guest is permanently unavailable after uncertain cleanup"
	m.mu.Unlock()
	fmt.Printf("MON native cleanup failed: %v; guest remains claimed\n", err)
}

func (m *monitor) prepareNative(d *domain, man contract.Manifest, artifact []byte) error {
	if err := m.native.validate(man, artifact, d.CPU, d.MemMiB); err != nil {
		return err
	}
	var si syscall.Sysinfo_t
	if err := syscall.Sysinfo(&si); err != nil {
		return err
	}
	if si.Unit == 0 || si.Totalram > ^uint64(0)/uint64(si.Unit) {
		return errors.New("invalid guest memory capacity")
	}
	if err := desktop.CheckCapacity(d.MemMiB, runtime.NumCPU(), man.Policy.Vcpus, si.Totalram*uint64(si.Unit)/1024); err != nil {
		return err
	}
	r, err := m.native.profile.OpenMounted(nativeRootPath, nativeModelPath)
	if err != nil {
		return err
	}
	claim, err := desktop.AcquireClaim(nativeClaimDir)
	if err != nil {
		r.Close()
		return err
	}
	group, err := desktop.NewGroup("/sys/fs/cgroup", claim, d.CPU, d.MemMiB, man.Policy.Vcpus)
	if err != nil {
		// Group creation may have partially installed limits. No process has
		// launched, but the consumed claim and any failed group must stay held.
		r.Close()
		claim.Close()
		m.poisonNative(err)
		return err
	}
	d.native = &nativeDomain{monitor: m, claim: claim, resources: r, group: group, vcpus: man.Policy.Vcpus, gpuMilli: man.Desktop.GPUMilli}
	d.UID, d.FrontUID = nativeRuntimeUID, nativeRuntimeUID+frontUIDOffset
	// Full 256-bit claim identity, but a short prefix keeps the broker pathname
	// at 106 bytes, below sockaddr_un's 107-byte pathname limit.
	d.dir = filepath.Join(m.root, "n-"+claim.ID())
	d.cgroup = filepath.Join("/sys/fs/cgroup", "desktop-"+claim.ID())
	return nil
}

func (d *domain) trackNativeMount(path string) {
	if d.native != nil {
		d.native.mounts = append(d.native.mounts, path)
	}
}

// Every target is beneath a newly created, root-owned domain directory. Every
// source is a fixed trusted platform path or an already verified resource fd.
func (d *domain) nativeBind(source, relative string, directory, recursive bool, flags uintptr) error {
	target := filepath.Join(d.dir, relative)
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return err
	}
	if directory {
		if err := os.Mkdir(target, 0755); err != nil {
			return err
		}
	} else {
		f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0444)
		if err != nil {
			return err
		}
		f.Close()
	}
	bind := uintptr(syscall.MS_BIND)
	if recursive {
		bind |= syscall.MS_REC
	}
	if err := syscall.Mount(source, target, "", bind, ""); err != nil {
		return err
	}
	d.trackNativeMount(target)
	if recursive {
		// The only recursive source is the freshly created control directory,
		// whose sole submount is the pinned models directory. Record its clone
		// after its parent so strict teardown unmounts it first.
		d.trackNativeMount(filepath.Join(target, "models"))
	}
	return syscall.Mount("", target, "", syscall.MS_BIND|syscall.MS_REMOUNT|flags, "")
}

func (m *monitor) setupNative(d *domain) error {
	n := d.native
	nativeAt := filepath.Join(d.dir, "native")
	if err := os.Mkdir(nativeAt, 0700); err != nil {
		return err
	}
	// The supervisor chroots here before cloning nsinit. That child must be
	// able to make its own root mount private before constructing the desktop.
	if err := syscall.Mount(nativeAt, nativeAt, "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	d.trackNativeMount(nativeAt)
	nd := filepath.Join(d.dir, "run/native-desktop")
	if err := os.Mkdir(nd, 0750); err != nil {
		return err
	}
	if err := os.Chown(nd, 0, 1002); err != nil {
		return err
	}
	root := fmt.Sprintf("/proc/self/fd/%d", n.resources.Root.Fd())
	models := fmt.Sprintf("/proc/self/fd/%d", n.resources.Models.Fd())
	ro := uintptr(syscall.MS_RDONLY | syscall.MS_NOSUID | syscall.MS_NODEV)
	locked := ro | syscall.MS_NOEXEC
	for _, b := range []struct {
		src, dst string
		dir, rec bool
		flags    uintptr
	}{
		{root, "native/plat/native-desktop/rootfs", true, false, ro},
		{models, "run/native-desktop/models", true, false, locked},
		{root + "/usr/local/libexec/kvm-box/nsinit", "native/plat/native-desktop/nsinit", false, false, ro},
		{root + "/desktop.profile", "native/desktop.profile", false, false, locked},
		{root + "/usr/local/libexec/kvm-box/gateway", "native-gateway", false, false, ro},
		{"/dev", "native/dev", true, false, syscall.MS_NOSUID | syscall.MS_NOEXEC},
		{"/sys", "native/sys", true, false, locked},
		{nd, "native/run/native-desktop", true, true, syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC},
	} {
		if err := d.nativeBind(b.src, b.dst, b.dir, b.rec, b.flags); err != nil {
			return fmt.Errorf("native bind %s: %w", b.dst, err)
		}
	}
	if err := os.Mkdir(filepath.Join(d.dir, "native/proc"), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(d.dir, "native-network.nft"), []byte(nativeNetworkPolicy), 0444); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	n.cancel = cancel
	lease, err := desktopworker.AcquireHost(ctx, desktopworker.Binding{Boot: d.Boot, Claim: n.claim.ID(), AppID: d.AppSha, ProfileSHA: m.native.sha, GPUMilli: n.gpuMilli})
	if err != nil {
		return err
	}
	n.lease = lease
	ready := make(chan error, 1)
	n.brokerDone = make(chan struct{})
	broker := shieldbridge.Bridge{Path: filepath.Join(nd, "worker.sock"), UID: 1001, RootOwnedSocket: true, Limit: 8, KeepIdleConnections: true, Dial: lease.Open}
	go func() { defer close(n.brokerDone); _ = broker.Serve(ctx, ready) }()
	select {
	case err = <-ready:
		if err != nil {
			return err
		}
	case <-time.After(5 * time.Second):
		return errors.New("native worker broker readiness timed out")
	}
	go func() {
		select {
		case <-lease.Done():
		case <-n.brokerDone:
		}
		m.retire(d, "native worker lease or broker ended")
	}()
	return nil
}

func (d *domain) releaseNative() {
	n := d.native
	if d.ln != nil {
		d.ln.Close()
	}
	if n.cancel != nil {
		n.cancel()
	}
	if n.lease != nil {
		// Revoke worker stream permission before killing processes. This
		// single-use transport cannot release or reassign host GPU capacity;
		// the manager must retain that allocation until confirmed VM removal.
		_ = n.lease.Close()
	}
	if n.brokerDone != nil {
		<-n.brokerDone
	}
	ctx, cancel := context.WithTimeout(context.Background(), exitGrace)
	defer cancel()
	// No process-handle fallback and no detached mounts. Failure retains the
	// group/resource descriptors and consumed claim until the guest is removed.
	if err := n.group.Kill(ctx); err != nil {
		n.monitor.poisonNative(err)
		return
	}
	d.mu.Lock()
	proc := d.proc
	d.mu.Unlock()
	if proc != nil {
		select {
		case <-d.exited:
		case <-ctx.Done():
			n.monitor.poisonNative(ctx.Err())
			return
		}
	}
	if err := n.group.Remove(); err != nil {
		n.monitor.poisonNative(err)
		return
	}
	for i := len(n.mounts) - 1; i >= 0; i-- {
		if err := syscall.Unmount(n.mounts[i], 0); err != nil {
			n.monitor.poisonNative(err)
			return
		}
	}
	if n.dirOwned {
		if err := os.RemoveAll(d.dir); err != nil {
			n.monitor.poisonNative(err)
			return
		}
	}
	if err := errors.Join(n.group.Close(), n.resources.Close(), n.claim.Close()); err != nil {
		n.monitor.poisonNative(err)
	}
}
