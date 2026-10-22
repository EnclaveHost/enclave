package encvol

// The volume's plaintext tree, touched by the front (root) inside a directory the app (uid 1000) controls. Every path is
// resolved with openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_MAGICLINKS|RESOLVE_NO_XDEV) from the volume's
// own directory, so nothing the app plants (a symlink, a rename race, a mount) can make a pull write, or a push read,
// anything outside that volume. A symlink is skipped as rclone's local backend skips it without -L/-l; any other
// non-regular file is skipped too. What a pull creates belongs to the app's uid, as when rclone ran as that uid.

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"
	"unsafe"
)

const (
	sysOpenat2          = 437
	resolveNoXdev       = 0x01
	resolveNoMagiclinks = 0x02
	resolveNoSymlinks   = 0x04
	resolveBeneath      = 0x08
	atRemoveDir         = 0x200
	oPath               = 0x200000 // O_PATH (Linux); Go's syscall package does not export it
	atSymlinkNofollow   = 0x100    // AT_SYMLINK_NOFOLLOW (Linux); likewise
)

type openHow struct {
	Flags   uint64
	Mode    uint64
	Resolve uint64
}

type tree struct {
	dir      string
	uid, gid int  // -1 = leave ownership alone (a non-root front, tests as an unprivileged user)
	shared   bool // group read-write with the app (Options.Shared): files 0660, directories 02770
}

func (t tree) fileMode() uint32 {
	if t.shared {
		return 0o660
	}
	return 0o644
}

func (t tree) dirMode() uint32 {
	if t.shared {
		return 0o2770
	}
	return 0o755
}

// open resolves rel beneath the volume. rel is "/"-separated and relative; "" or "." is the volume itself.
func (t tree) open(rel string, flags int, mode uint32) (int, error) {
	root, err := syscall.Open(t.dir, oPath|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return -1, err
	}
	defer syscall.Close(root)
	if rel == "" {
		rel = "."
	}
	p, err := syscall.BytePtrFromString(rel)
	if err != nil {
		return -1, err
	}
	how := openHow{Flags: uint64(flags | syscall.O_CLOEXEC), Mode: uint64(mode),
		Resolve: resolveBeneath | resolveNoSymlinks | resolveNoMagiclinks | resolveNoXdev}
	for {
		fd, _, e := syscall.Syscall6(sysOpenat2, uintptr(root), uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&how)), unsafe.Sizeof(how), 0, 0)
		if e == syscall.EINTR || e == syscall.EAGAIN {
			continue
		}
		if e == syscall.ENOSYS {
			return -1, errors.New("this kernel lacks openat2; the volume cannot be handled safely")
		}
		if e != 0 {
			return -1, e
		}
		return int(fd), nil
	}
}

// local is one plaintext file found by a walk.
type localFile struct {
	Rel     string
	Size    int64
	ModTime time.Time
}

// walk lists the regular files beneath the volume (rclone's local listing without -L/-l), plus every directory.
func (t tree) walk() ([]localFile, map[string]bool, error) {
	var files []localFile
	dirs := map[string]bool{}
	var rec func(rel string, depth int) error
	rec = func(rel string, depth int) error {
		if depth > 256 {
			return fmt.Errorf("%s: directory tree too deep", rel)
		}
		fd, err := t.open(rel, syscall.O_RDONLY|syscall.O_DIRECTORY, 0)
		if err != nil {
			return fmt.Errorf("%s: %v", show(rel), err)
		}
		f := os.NewFile(uintptr(fd), rel)
		names, err := f.Readdirnames(-1)
		if err != nil {
			f.Close()
			return fmt.Errorf("%s: %v", show(rel), err)
		}
		var subdirs []string
		for _, n := range names {
			var st syscall.Stat_t
			if err := fstatat(fd, n, &st); err != nil {
				if errors.Is(err, syscall.ENOENT) {
					continue // removed while we looked
				}
				f.Close()
				return fmt.Errorf("%s: %v", show(join(rel, n)), err)
			}
			child := join(rel, n)
			switch st.Mode & syscall.S_IFMT {
			case syscall.S_IFREG:
				if !utf8.ValidString(child) {
					f.Close()
					return fmt.Errorf("%q: file names must be UTF-8", child)
				}
				files = append(files, localFile{Rel: child, Size: st.Size, ModTime: time.Unix(st.Mtim.Sec, st.Mtim.Nsec)})
			case syscall.S_IFDIR:
				subdirs = append(subdirs, child)
			}
		}
		f.Close()
		for _, d := range subdirs {
			dirs[d] = true
			if err := rec(d, depth+1); err != nil {
				return err
			}
		}
		return nil
	}
	if err := rec("", 0); err != nil {
		return nil, nil, err
	}
	return files, dirs, nil
}

func fstatat(dirfd int, name string, st *syscall.Stat_t) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall6(syscall.SYS_NEWFSTATAT, uintptr(dirfd), uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(st)), atSymlinkNofollow, 0, 0)
	if e != 0 {
		return e
	}
	return nil
}

// openRead opens a regular file beneath the volume for reading (no FIFO can block it: O_NONBLOCK, then a type check).
func (t tree) openRead(rel string) (*os.File, int64, error) {
	fd, err := t.open(rel, syscall.O_RDONLY|syscall.O_NONBLOCK|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, 0, err
	}
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG {
		syscall.Close(fd)
		return nil, 0, fmt.Errorf("%s: not a regular file", show(rel))
	}
	return os.NewFile(uintptr(fd), rel), st.Size, nil
}

// mkdirs makes rel's directories beneath the volume, owned by the app.
func (t tree) mkdirs(rel string) error {
	if rel == "" || rel == "." {
		return nil
	}
	cur := ""
	for _, seg := range strings.Split(rel, "/") {
		parent, err := t.open(cur, oPath|syscall.O_DIRECTORY, 0)
		if err != nil {
			return err
		}
		err = syscall.Mkdirat(parent, seg, t.dirMode())
		if err == nil && t.uid >= 0 {
			err = syscall.Fchownat(parent, seg, t.uid, t.gid, atSymlinkNofollow)
		}
		if err == nil {
			err = syscall.Fchmodat(parent, seg, t.dirMode(), 0) // the umask does not decide what the app may do
		} else if errors.Is(err, syscall.EEXIST) {
			err = nil // checked when the next step opens it (a symlink there is refused)
		}
		syscall.Close(parent)
		if err != nil {
			return err
		}
		cur = join(cur, seg)
	}
	return nil
}

// writeFile writes rel atomically (a partial name, then a rename), owned by the app, with mtime set; it counts what it
// reads from r and stops at the transfer cap.
func (t tree) writeFile(rel string, r io.Reader, mtime time.Time, tmpTag string) (int64, error) {
	dir, base := path.Split(rel)
	dir = strings.TrimSuffix(dir, "/")
	if err := t.mkdirs(dir); err != nil {
		return 0, err
	}
	parent, err := t.open(dir, oPath|syscall.O_DIRECTORY, 0)
	if err != nil {
		return 0, err
	}
	defer syscall.Close(parent)
	tmp := base + "." + tmpTag + ".partial" // rclone's local backend writes <name>.<hash>.partial and renames it
	fd, err := syscall.Openat(parent, tmp, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, t.fileMode())
	if err != nil {
		return 0, err
	}
	f := os.NewFile(uintptr(fd), tmp)
	fail := func(err error) (int64, error) {
		f.Close()
		unlinkat(parent, tmp, 0)
		return 0, err
	}
	if t.uid >= 0 {
		if err := f.Chown(t.uid, t.gid); err != nil {
			return fail(err)
		}
	}
	if err := f.Chmod(os.FileMode(t.fileMode())); err != nil {
		return fail(err)
	}
	n, err := io.Copy(f, r)
	if err != nil {
		return fail(err)
	}
	ts := []syscall.Timespec{syscall.NsecToTimespec(mtime.UnixNano()), syscall.NsecToTimespec(mtime.UnixNano())}
	if _, _, e := syscall.Syscall6(syscall.SYS_UTIMENSAT, uintptr(fd), 0, uintptr(unsafe.Pointer(&ts[0])), 0, 0, 0); e != 0 {
		return fail(e)
	}
	if err := f.Close(); err != nil {
		unlinkat(parent, tmp, 0)
		return 0, err
	}
	// a directory (or anything else the app made) at the final name is replaced only if it is a file or a symlink
	var st syscall.Stat_t
	if fstatat(parent, base, &st) == nil && st.Mode&syscall.S_IFMT == syscall.S_IFDIR {
		unlinkat(parent, tmp, 0)
		return 0, fmt.Errorf("%s: a directory is in the way", show(rel))
	}
	if err := syscall.Renameat(parent, tmp, parent, base); err != nil {
		unlinkat(parent, tmp, 0)
		return 0, err
	}
	return n, nil
}

// remove deletes the file rel (never following a symlink: unlinkat removes the link itself).
func (t tree) remove(rel string) error {
	dir, base := path.Split(rel)
	parent, err := t.open(strings.TrimSuffix(dir, "/"), oPath|syscall.O_DIRECTORY, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(parent)
	return unlinkat(parent, base, 0)
}

// rmdirIfEmpty removes the directory rel if it is empty (ENOTEMPTY is not an error).
func (t tree) rmdirIfEmpty(rel string) {
	dir, base := path.Split(rel)
	parent, err := t.open(strings.TrimSuffix(dir, "/"), oPath|syscall.O_DIRECTORY, 0)
	if err != nil {
		return
	}
	defer syscall.Close(parent)
	unlinkat(parent, base, atRemoveDir)
}

func unlinkat(dirfd int, name string, flags int) error {
	p, err := syscall.BytePtrFromString(name)
	if err != nil {
		return err
	}
	_, _, e := syscall.Syscall(syscall.SYS_UNLINKAT, uintptr(dirfd), uintptr(unsafe.Pointer(p)), uintptr(flags))
	if e != 0 {
		return e
	}
	return nil
}

func join(a, b string) string {
	if a == "" {
		return b
	}
	return a + "/" + b
}

func show(rel string) string {
	if rel == "" {
		return "."
	}
	return rel
}
