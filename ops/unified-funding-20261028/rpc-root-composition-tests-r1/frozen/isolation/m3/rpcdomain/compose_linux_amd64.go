//go:build linux && amd64

package rpcdomain

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"enclave.host/isolation/contract"
)

// StateVolume is a BORROWED capability acquired by the trusted monitor's
// authenticated storage workflow. LogicalID alone is not authority; neither
// root ownership nor this API proves an exclusive writer lease. The caller
// must retain that lease and independently terminate on storage authority loss.
// No pathname or caller-supplied "authorized" boolean is accepted here.
type StateVolume struct {
	LogicalID string
	Root      *os.File
}

// Composition retains every source/mount, including on partial failure. Never
// detach or reuse the consumed directory. Cleanup belongs to exact domain and
// writer quiescence, not a deferred Close during a timed-out mount operation.
type Composition struct {
	Path   string
	Root   *os.File
	Mounts []string
	held   []*os.File
}

type writeIdentity struct {
	Dev uint64 `json:"dev"`
	Ino uint64 `json:"ino"`
	UID uint32 `json:"uid"`
	GID uint32 `json:"gid"`
}
type volumeIdentity struct {
	VolumeID string                   `json:"volumeId"`
	Dev      uint64                   `json:"dev"`
	Ino      uint64                   `json:"ino"`
	Writes   map[string]writeIdentity `json:"writes"`
}
type mountDocument struct {
	Schema string                    `json:"schema"`
	AppID  string                    `json:"appId"`
	Claim  string                    `json:"claim"`
	Roles  map[string]volumeIdentity `json:"roles"`
}

var writeScopes = map[string]map[string]uint32{
	"l1":   {"data": 2101, "tmp": 2101, "cl": 2102, "tmp-cl": 2102},
	"base": {"data": 2103, "tmp": 2103},
}
var stateMounts = map[string]string{"l1": "srv/enclave-l1-pair", "base": "srv/enclave-base-holder"}

// ComposeCommand assembles the real root and then the fixed namespace command.
// It never starts the command. Accepted platform, authenticated attachments,
// outer guardian, report registration, networking and writer-loss termination
// remain required before the monitor may call Start. Failed attempts retain
// their mounts/capabilities and cannot be retried through this Prepared value.
func (p *Prepared) ComposeCommand(bundle []byte, l1, base StateVolume) (*Launch, error) {
	p.mu.Lock()
	if p.taken || p.composition != nil {
		p.mu.Unlock()
		return nil, errors.New("RPC composition already consumed")
	}
	c := &Composition{}
	p.composition = c
	p.mu.Unlock()
	if err := withinOriginal(p.binding.Origin); err != nil {
		return nil, err
	}
	if len(bundle) > contract.MaxRPCControllerBytes+(1<<20) {
		return nil, errors.New("bounded RPC bundle required")
	}
	bundle = append([]byte(nil), bundle...)
	man, wasm, err := contract.ParseRPC(bundle)
	if err != nil {
		return nil, err
	}
	id := contract.AppID(bundle)
	if hex.EncodeToString(id[:]) != p.binding.AppID || man.SecretDeployment != p.binding.Deployment || l1.LogicalID != p.binding.L1Volume || base.LogicalID != p.binding.BaseVolume {
		return nil, errors.New("RPC composition differs from consumed app/volume claim")
	}
	if err = p.installed.Profile.CheckBundle(man, wasm); err != nil {
		return nil, err
	}
	platform, err := protectedDirectory("/plat")
	if err != nil {
		return nil, err
	}
	c.held = append(c.held, platform, l1.Root, base.Root)
	var platformFS syscall.Statfs_t
	if syscall.Fstatfs(int(platform.Fd()), &platformFS) != nil || platformFS.Flags&1 == 0 {
		return nil, errors.New("immutable measured platform required")
	}
	fd, err := syscall.Open("/run/monitor.sock", 0x200000|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0) // O_PATH holds exact socket inode
	if err != nil {
		return nil, err
	}
	report := os.NewFile(uintptr(fd), "rpc-monitor-report")
	c.held = append(c.held, report)
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFSOCK || st.Uid != 0 {
		return nil, errors.New("root monitor report socket required")
	}
	wrap, err := c.source(platform, "native-rpc/chain_service.py", false)
	if err != nil {
		return nil, err
	}
	raw, err := boundedImmutable(wrap, 1<<20)
	if err != nil {
		return nil, err
	}
	if err = p.installed.Profile.CheckWrapper(raw); err != nil {
		return nil, err
	}
	profile, err := p.installed.Profile.Canonical()
	if err != nil {
		return nil, err
	}
	doc := mountDocument{Schema: "enclave-rpc-native-mounts/1", AppID: p.binding.AppID, Claim: p.binding.Nonce, Roles: map[string]volumeIdentity{}}
	children := map[string]map[string]*os.File{}
	for _, item := range []struct {
		role  string
		state StateVolume
	}{{"l1", l1}, {"base", base}} {
		row, dirs, err := c.state(item.state, item.role)
		if err != nil {
			return nil, err
		}
		doc.Roles[item.role], children[item.role] = row, dirs
	}
	if doc.Roles["l1"].Dev == doc.Roles["base"].Dev {
		return nil, errors.New("L1 and Base must be separate state filesystems")
	}
	parent, err := protectedDirectory("/domains")
	if err != nil {
		return nil, err
	}
	c.held = append(c.held, parent)
	name := "rpc-" + p.binding.Nonce
	if err = syscall.Mkdirat(int(parent.Fd()), name, 0700); err != nil {
		return nil, err
	}
	c.Path = filepath.Join("/domains", name)
	if err = c.tmpfs("", 32, 0755); err != nil {
		return nil, err
	}
	for _, dir := range []string{"usr", "lib64", "opt", "etc/ssl", "etc/enclave-rpc", "etc/enclave-rpc-vm", "plat/rt", "plat/native-rpc", "run/front", "tmp", "proc", "sys", "dev", "root", "srv/enclave-l1-pair", "srv/enclave-base-holder", "var/tmp"} {
		if err = c.directories(dir); err != nil {
			return nil, err
		}
	}
	if err = os.Chmod(c.at("root"), 0700); err != nil {
		return nil, err
	}
	for _, dir := range []string{"usr", "lib64", "opt", "etc/ssl"} {
		f, e := c.source(p.installed.Root, dir, true)
		if e != nil {
			return nil, e
		}
		if e = c.bind(f, dir, true, true); e != nil {
			return nil, e
		}
	}
	for _, row := range []struct {
		src, dst string
		dir      bool
	}{{"front", "plat/front", false}, {"rt", "plat/rt", true}} {
		f, e := c.source(platform, row.src, row.dir)
		if e != nil {
			return nil, e
		}
		if e = c.bind(f, row.dst, row.dir, true); e != nil {
			return nil, e
		}
	}
	if err = c.bind(wrap, "opt/enclave-rpc/chain_service.py", false, true); err != nil {
		return nil, err
	}
	for _, file := range []string{"chain.json", "native-root"} {
		f, e := c.source(p.installed.Root, "etc/enclave-rpc/"+file, false)
		if e != nil {
			return nil, e
		}
		if e = c.bind(f, "etc/enclave-rpc/"+file, false, true); e != nil {
			return nil, e
		}
	}
	config, err := man.AppConfig()
	if err != nil {
		return nil, err
	}
	metadata := map[string][]byte{"app.bundle": bundle, "app.wasm": wasm, "app.sha256": []byte(p.binding.AppID), "app.config": config, "secret.id": []byte(p.binding.Deployment), "app.ports": []byte(strings.Join(man.Ports, "\n") + "\n"), "plat/native-rpc/profile.json": profile, "etc/hosts": []byte("127.0.0.1 localhost\n::1 localhost\n"), "etc/nsswitch.conf": []byte("passwd: files\ngroup: files\nhosts: files\n")}
	metadata["etc/passwd"], metadata["etc/group"] = roleAccounts()
	metadata["etc/enclave-rpc/native-mounts.json"], err = json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	for path, data := range metadata {
		if err = c.write(path, data, 0444, 0, 0); err != nil {
			return nil, err
		}
	}
	jwt := make([]byte, 32)
	if _, err = rand.Read(jwt); err != nil {
		return nil, err
	}
	jwtText := []byte(hex.EncodeToString(jwt))
	for i := range jwt {
		jwt[i] = 0
	}
	err = c.write("etc/enclave-rpc/jwt.hex", jwtText, 0440, 2101, 2102)
	for i := range jwtText {
		jwtText[i] = 0
	}
	if err != nil {
		return nil, err
	}
	for _, row := range []struct {
		role string
		root *os.File
	}{{"l1", l1.Root}, {"base", base.Root}} {
		target := stateMounts[row.role]
		if err = c.bind(row.root, target, true, true); err != nil {
			return nil, err
		}
		for name, f := range children[row.role] {
			if err = c.bind(f, target+"/"+name, true, false); err != nil {
				return nil, err
			}
		}
	}
	if err = c.tmpfs("run/front", 16, 0700); err != nil {
		return nil, err
	}
	if err = os.Chown(c.at("run/front"), 1053577, 1053577); err != nil {
		return nil, err
	}
	if err = c.bind(report, "run/front/monitor.sock", false, false); err != nil {
		return nil, err
	}
	if err = c.tmpfs("tmp", 64, 01777); err != nil {
		return nil, err
	}
	if err = c.devices(); err != nil {
		return nil, err
	}
	if err = syscall.Mount("", c.Path, "", syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, ""); err != nil {
		return nil, err
	}
	c.Root, err = os.Open(c.Path)
	if err != nil {
		return nil, err
	}
	if err = withinOriginal(p.binding.Origin); err != nil {
		return nil, err
	}
	p.mu.Lock()
	p.compositionReady = true
	p.mu.Unlock()
	l, err := p.Command(c.Root)
	if err != nil {
		return nil, err
	}
	l.Composition = c
	return l, nil
}

func (c *Composition) at(rel string) string { return filepath.Join(c.Path, rel) }

// All directories are newly created in our exclusive tmpfs, before bindings.
// Explicit chmod is necessary under the monitor's restrictive umask.
func (c *Composition) directories(rel string) error {
	path := c.Path
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return errors.New("fixed directory required")
		}
		path = filepath.Join(path, part)
		if err := os.Mkdir(path, 0755); err != nil && !os.IsExist(err) {
			return err
		}
		st, err := os.Lstat(path)
		if err != nil || !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe composition directory")
		}
		if err := os.Chmod(path, 0755); err != nil {
			return err
		}
	}
	return nil
}
func (c *Composition) tmpfs(rel string, mib int, mode uint32) error {
	target := c.at(rel)
	if err := syscall.Mount("tmpfs", target, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, fmt.Sprintf("size=%dm,mode=%o", mib, mode)); err != nil {
		return err
	}
	c.Mounts = append(c.Mounts, target)
	return nil
}
func (c *Composition) source(root *os.File, rel string, dir bool) (*os.File, error) {
	if root == nil {
		return nil, errors.New("held source required")
	}
	fd, err := syscall.Dup(int(root.Fd()))
	if err != nil {
		return nil, err
	}
	syscall.CloseOnExec(fd)
	parts := strings.Split(rel, "/")
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			syscall.Close(fd)
			return nil, errors.New("fixed relative source required")
		}
		flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
		if i < len(parts)-1 || dir {
			flags |= syscall.O_DIRECTORY
		}
		n, e := syscall.Openat(fd, part, flags, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = n
	}
	f := os.NewFile(uintptr(fd), rel)
	c.held = append(c.held, f)
	return f, nil
}
func boundedImmutable(f *os.File, limit int64) ([]byte, error) {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if f == nil || syscall.Fstat(int(f.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Uid != 0 || st.Mode&0222 != 0 || st.Size < 1 || st.Size > limit || syscall.Fstatfs(int(f.Fd()), &fs) != nil || fs.Flags&1 == 0 {
		return nil, errors.New("bounded immutable platform file required")
	}
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil || int64(len(b)) != st.Size {
		return nil, errors.New("platform file changed")
	}
	return b, nil
}
func (c *Composition) bind(f *os.File, rel string, dir, ro bool) error {
	target := c.at(rel)
	if _, err := os.Lstat(target); os.IsNotExist(err) {
		if dir {
			err = os.Mkdir(target, 0755)
		} else {
			var x *os.File
			x, err = os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0444)
			if err == nil {
				err = x.Close()
			}
		}
		if err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	st, err := os.Lstat(target)
	if err != nil || st.Mode()&os.ModeSymlink != 0 || st.IsDir() != dir {
		return errors.New("unsafe fixed mount target")
	}
	if err = syscall.Mount(fmt.Sprintf("/proc/self/fd/%d", f.Fd()), target, "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	c.Mounts = append(c.Mounts, target)
	flags := uintptr(syscall.MS_BIND | syscall.MS_REMOUNT | syscall.MS_NOSUID | syscall.MS_NODEV)
	if strings.HasPrefix(rel, "srv/") || strings.HasPrefix(rel, "etc/") || strings.HasPrefix(rel, "run/") {
		flags |= syscall.MS_NOEXEC
	}
	if ro {
		flags |= syscall.MS_RDONLY
	}
	if err = syscall.Mount("", target, "", flags, ""); err != nil {
		return err
	}
	var before, after syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &before) != nil || syscall.Stat(target, &after) != nil || before.Dev != after.Dev || before.Ino != after.Ino {
		return errors.New("mount identity changed")
	}
	return nil
}
func (c *Composition) write(rel string, data []byte, mode os.FileMode, uid, gid int) error {
	f, err := os.OpenFile(c.at(rel), os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if n, e := f.Write(data); e != nil {
		return e
	} else if n != len(data) {
		return io.ErrShortWrite
	}
	if err = f.Chown(uid, gid); err != nil {
		return err
	}
	if err = f.Chmod(mode); err != nil {
		return err
	}
	return f.Sync()
}
func (c *Composition) state(v StateVolume, role string) (volumeIdentity, map[string]*os.File, error) {
	row := volumeIdentity{VolumeID: v.LogicalID, Writes: map[string]writeIdentity{}}
	dirs := map[string]*os.File{}
	if _, ok := writeScopes[role]; !ok {
		return row, nil, errors.New("unknown state role")
	}
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if v.Root == nil || !contract.NonzeroHash(v.LogicalID) || syscall.Fstat(int(v.Root.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&0022 != 0 || st.Ino != 2 || syscall.Fstatfs(int(v.Root.Fd()), &fs) != nil || fs.Type != 0xef53 || fs.Flags&1 != 0 {
		return row, nil, errors.New("held writable ext4 filesystem root required")
	}
	row.Dev, row.Ino = st.Dev, st.Ino
	for name, uid := range writeScopes[role] {
		f, err := c.source(v.Root, name, true)
		if err != nil {
			return row, nil, err
		}
		if syscall.Fstat(int(f.Fd()), &st) != nil || st.Dev != row.Dev || st.Uid != uid || st.Gid != uid || st.Mode&0077 != 0 {
			return row, nil, errors.New("state role ownership differs; never chown original data")
		}
		row.Writes[name] = writeIdentity{st.Dev, st.Ino, st.Uid, st.Gid}
		dirs[name] = f
	}
	return row, dirs, nil
}
func roleAccounts() ([]byte, []byte) {
	passwd, group := "root:x:0:0:root:/root:/nonexistent\n", "root:x:0:\n"
	for _, r := range []struct {
		name string
		uid  int
	}{{"el", 2101}, {"cl", 2102}, {"base", 2103}, {"probe", 2104}, {"controller", 2105}, {"front", 1053577}} {
		passwd += fmt.Sprintf("rpc%s:x:%d:%d:RPC %s:/nonexistent:/nonexistent\n", r.name, r.uid, r.uid, r.name)
		group += fmt.Sprintf("rpc%s:x:%d:\n", r.name, r.uid)
	}
	return []byte(passwd), []byte(group)
}
func (c *Composition) devices() error {
	target := c.at("dev")
	if err := syscall.Mount("tmpfs", target, "tmpfs", syscall.MS_NOSUID|syscall.MS_NOEXEC, "size=1m,mode=0755"); err != nil {
		return err
	}
	c.Mounts = append(c.Mounts, target)
	for name, minor := range map[string]int{"null": 3, "zero": 5, "random": 8, "urandom": 9} {
		if err := syscall.Mknod(c.at("dev/"+name), syscall.S_IFCHR|0666, 1<<8|minor); err != nil {
			return err
		}
		if err := os.Chmod(c.at("dev/"+name), 0666); err != nil {
			return err
		}
	}
	return syscall.Mount("", target, "", syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NOEXEC, "")
}
