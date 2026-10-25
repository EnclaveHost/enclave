//go:build linux && amd64

package desktop

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"
)

const dmTableStatus = 0xc138fd0c // _IOWR(0xfd,12,struct dm_ioctl), ABI v4.
const dmHeaderSize = 312
const dmTargetSize = 40

func rootDirectory(path string) (*os.File, error) {
	if !strings.HasPrefix(path, "/") || path == "/" {
		return nil, errors.New("absolute resource directory required")
	}
	fd, err := syscall.Open("/", syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for _, part := range strings.Split(path[1:], "/") {
		if part == "" || part == "." || part == ".." {
			syscall.Close(fd)
			return nil, errors.New("invalid resource path")
		}
		next, e := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, e
		}
		fd = next
		var st syscall.Stat_t
		if e = syscall.Fstat(fd, &st); e != nil || st.Uid != 0 || st.Mode&0022 != 0 {
			syscall.Close(fd)
			return nil, errors.New("unsafe resource ancestor")
		}
	}
	return os.NewFile(uintptr(fd), path), nil
}

// ReadInstalled follows no symlink component and requires an immutable mount.
// The measured platform image, not a host-selected manifest path, supplies dir.
func ReadInstalled(dir string) (Profile, string, error) {
	var p Profile
	d, err := rootDirectory(dir)
	if err != nil {
		return p, "", err
	}
	defer d.Close()
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(d.Fd()), &fs) != nil || fs.Flags&1 == 0 {
		return p, "", errors.New("profile directory is not read-only")
	}
	fd, err := syscall.Openat(int(d.Fd()), "profile.json", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return p, "", err
	}
	f := os.NewFile(uintptr(fd), "profile.json")
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return p, "", err
	}
	rawst := st.Sys().(*syscall.Stat_t)
	if !st.Mode().IsRegular() || rawst.Uid != 0 || st.Mode().Perm()&0222 != 0 || st.Size() < 1 || st.Size() > 16384 {
		return p, "", errors.New("unsafe installed profile")
	}
	raw := make([]byte, st.Size()+1)
	n, err := f.ReadAt(raw, 0)
	// ReadAt reaches EOF after the exact stat size; any growth is refused.
	if n != int(st.Size()) || err != io.EOF {
		return p, "", errors.New("profile changed during read")
	}
	return ParseProfile(raw[:n])
}

type verityTarget struct {
	Blocks, HashStart uint64
	RootHash, Salt    string
}

func validateTable(buf []byte, expectedDev uint64, want verityTarget) error {
	le := binary.LittleEndian
	if len(buf) < dmHeaderSize || le.Uint32(buf[:4]) != 4 {
		return errors.New("bad device-mapper reply")
	}
	size, start, count, flags := le.Uint32(buf[12:16]), le.Uint32(buf[16:20]), le.Uint32(buf[20:24]), le.Uint32(buf[28:32])
	// Active readonly target only; no suspended, inactive, or truncated table.
	if size > uint32(len(buf)) || size < dmHeaderSize || start < dmHeaderSize || uint64(start)+dmTargetSize >= uint64(size) || count != 1 || flags&1 == 0 || flags&(1<<5) == 0 || flags&((1<<1)|(1<<6)|(1<<8)) != 0 || le.Uint64(buf[40:48]) != expectedDev {
		return errors.New("inactive or unsafe resource table")
	}
	t := buf[start:size]
	if le.Uint64(t[:8]) != 0 || le.Uint64(t[8:16]) != want.Blocks*8 || !bytes.Equal(bytes.TrimRight(t[24:40], "\x00"), []byte("verity")) {
		return errors.New("resource is not the expected verity target")
	}
	end := bytes.IndexByte(t[40:], 0)
	if end < 0 {
		return errors.New("unterminated verity table")
	}
	fields := strings.Fields(string(t[40 : 40+end]))
	// No optional ignore-corruption, ignore-zero-blocks, check-at-most-once,
	// or restart policy: every authenticated read must either verify or fail.
	if len(fields) != 10 || fields[0] != "1" || fields[3] != "4096" || fields[4] != "4096" || fields[5] != strconv.FormatUint(want.Blocks, 10) || fields[6] != strconv.FormatUint(want.HashStart, 10) || fields[7] != "sha256" || fields[8] != want.RootHash || fields[9] != want.Salt {
		return errors.New("verity parameters differ from measured profile")
	}
	if (want.HashStart != 0) != (fields[1] == fields[2]) {
		return errors.New("verity backing layout differs from profile")
	}
	for _, dev := range fields[1:3] {
		parts := strings.Split(dev, ":")
		if len(parts) != 2 {
			return errors.New("invalid backing device")
		}
		for _, n := range parts {
			v, e := strconv.ParseUint(n, 10, 32)
			if e != nil || strconv.FormatUint(v, 10) != n {
				return errors.New("invalid backing device")
			}
		}
	}
	return nil
}

func verifyMount(path string, magic int64, want verityTarget) (result *os.File, mountID uint64, err error) {
	d, err := rootDirectory(path)
	if err != nil {
		return nil, 0, err
	}
	defer func() {
		if err != nil {
			d.Close()
		}
	}()
	var fs syscall.Statfs_t
	var st syscall.Stat_t
	if syscall.Fstatfs(int(d.Fd()), &fs) != nil || syscall.Fstat(int(d.Fd()), &st) != nil || fs.Type != magic || fs.Flags&7 != 7 || (magic == 0xef53 && fs.Flags&8 == 0) || (magic == 0x73717368 && fs.Flags&8 != 0) {
		return nil, 0, errors.New("resource filesystem is not read-only or has wrong type")
	}
	// st_dev is a userspace dev_t; the ioctl carries Linux new_encode_dev.
	major := (st.Dev>>8)&0xfff | (st.Dev>>32)&0xfffff000
	minor := st.Dev&0xff | (st.Dev>>12)&0xffffff00
	if major > 0xfff || minor > 0xfffff {
		return nil, 0, errors.New("resource device outside kernel ABI")
	}
	dev := (minor & 0xff) | (major << 8) | ((minor & 0xfff00) << 12)
	f, err := os.OpenFile("/dev/mapper/control", os.O_RDWR|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, 0, err
	}
	defer f.Close()
	var ctrl syscall.Stat_t
	if syscall.Fstat(int(f.Fd()), &ctrl) != nil || ctrl.Mode&syscall.S_IFMT != syscall.S_IFCHR || ctrl.Uid != 0 || ctrl.Rdev != uint64(10<<8|236) {
		return nil, 0, errors.New("invalid mapper control")
	}
	buf := make([]byte, 16384)
	le := binary.LittleEndian
	le.PutUint32(buf[:4], 4)
	le.PutUint32(buf[12:16], uint32(len(buf)))
	le.PutUint32(buf[16:20], dmHeaderSize)
	le.PutUint32(buf[28:32], 1<<4)
	le.PutUint64(buf[40:48], dev)
	_, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), dmTableStatus, uintptr(unsafe.Pointer(&buf[0])))
	runtime.KeepAlive(buf)
	if errno != 0 {
		return nil, 0, fmt.Errorf("resource table unavailable: %w", errno)
	}
	if err = validateTable(buf, dev, want); err != nil {
		return nil, 0, err
	}
	// STATX_ATTR_MOUNT_ROOT prevents accepting a subdirectory of the volume.
	var sx [256]byte
	empty := []byte{0}
	_, _, errno = syscall.Syscall6(332, d.Fd(), uintptr(unsafe.Pointer(&empty[0])), 0x1000|0x100, 0x7ff|0x1000, uintptr(unsafe.Pointer(&sx[0])), 0)
	runtime.KeepAlive(d)
	runtime.KeepAlive(empty)
	if errno != 0 {
		return nil, 0, errno
	}
	if le.Uint64(sx[56:64])&0x2000 == 0 || le.Uint64(sx[8:16])&0x2000 == 0 || le.Uint32(sx[:4])&0x1000 == 0 {
		return nil, 0, errors.New("resource is not a pinned mount root")
	}
	mountID = le.Uint64(sx[144:152])
	info, e := os.Open("/proc/self/mountinfo")
	if e != nil {
		return nil, 0, e
	}
	var procfs syscall.Statfs_t
	if syscall.Fstatfs(int(info.Fd()), &procfs) != nil || procfs.Type != 0x9fa0 {
		info.Close()
		return nil, 0, errors.New("mount identity source is not procfs")
	}
	raw, e := io.ReadAll(io.LimitReader(info, (1<<20)+1))
	info.Close()
	if e != nil {
		return nil, 0, e
	}
	if len(raw) > 1<<20 {
		return nil, 0, errors.New("mountinfo exceeds bound")
	}
	if e = verifyMountRoot(raw, mountID, fmt.Sprintf("%d:%d", major, minor)); e != nil {
		return nil, 0, e
	}
	return d, mountID, nil
}

// A bind of /usr is a mount root too; mountinfo's root field must name /
// within the authenticated filesystem, not merely the root of a bind mount.
func verifyMountRoot(raw []byte, id uint64, device string) error {
	found := false
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || fields[0] != strconv.FormatUint(id, 10) {
			continue
		}
		if found || fields[2] != device || fields[3] != "/" {
			return errors.New("resource mount is not filesystem root")
		}
		found = true
	}
	if !found {
		return errors.New("pinned resource mount not visible")
	}
	return nil
}

// Resources pins the verified filesystem roots by descriptors and mount IDs.
// Keep these open through bind/clone; a later path lookup is not equivalent.
type Resources struct {
	Root, Models              *os.File
	RootMountID, ModelMountID uint64
}

func (r *Resources) Close() error {
	a := r.Root.Close()
	b := r.Models.Close()
	if a != nil {
		return a
	}
	return b
}
func (p Profile) OpenMounted(rootPath, modelPath string) (*Resources, error) {
	if err := p.Validate(); err != nil {
		return nil, err
	}
	r, id, err := verifyMount(rootPath, 0x73717368, verityTarget{p.Root.DataBlocks, 0, p.Root.RootHash, p.Root.Salt})
	if err != nil {
		return nil, fmt.Errorf("desktop root: %w", err)
	}
	m, mid, err := verifyMount(modelPath, 0xef53, verityTarget{p.Models.DataBlocks, p.Models.HashStartBlock, p.Models.RootHash, p.Models.Salt})
	if err != nil {
		r.Close()
		return nil, fmt.Errorf("desktop models: %w", err)
	}
	return &Resources{Root: r, Models: m, RootMountID: id, ModelMountID: mid}, nil
}

// VerifyMounted is a probe-only convenience. Production launch must retain
// OpenMounted's descriptors until the namespace has its own pinned mounts.
func (p Profile) VerifyMounted(rootPath, modelPath string) error {
	r, err := p.OpenMounted(rootPath, modelPath)
	if err != nil {
		return err
	}
	return r.Close()
}
