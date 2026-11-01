//go:build linux && amd64

package rpcstorage

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"syscall"
)

// A per-boot consumed intent precedes even connect/submission. It survives a
// monitor restart and is never unlinked. The broker still requires its durable
// cross-boot writer journal: local tmpfs is not a remote settlement certificate.
func consumeIntent(d *os.File, r Request) (*os.File, error) {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if d == nil || syscall.Fstat(int(d.Fd()), &st) != nil || st.Uid != 0 || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Mode&07777 != 0700 || syscall.Fstatfs(int(d.Fd()), &fs) != nil || fs.Type != 0x01021994 {
		return nil, errors.New("private root tmpfs storage authority directory required")
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	b, err := json.Marshal(r)
	if err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(int(d.Fd()), "attempt", syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0600)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "consumed-storage-attempt")
	defer f.Close()
	if n, e := f.Write(b); e != nil {
		return nil, e
	} else if n != len(b) {
		return nil, io.ErrShortWrite
	}
	if err = f.Chmod(0400); err != nil {
		return nil, err
	}
	if err = f.Sync(); err != nil {
		return nil, err
	}
	if err = d.Sync(); err != nil {
		return nil, err
	}
	var before syscall.Stat_t
	if err = syscall.Fstat(fd, &before); err != nil {
		return nil, err
	}
	ro, err := syscall.Openat(int(d.Fd()), "attempt", syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	held := os.NewFile(uintptr(ro), "consumed-storage-attempt-readonly")
	fail := func(e error) (*os.File, error) { held.Close(); return nil, e }
	if syscall.Fstat(ro, &st) != nil || st.Dev != before.Dev || st.Ino != before.Ino || st.Mode&07777 != 0400 || st.Nlink != 1 {
		return fail(errors.New("storage intent identity changed"))
	}
	raw, e := io.ReadAll(io.LimitReader(held, int64(len(b)+1)))
	if e != nil || !bytes.Equal(raw, b) {
		return fail(errors.New("storage intent readback differs"))
	}
	return held, nil
}
