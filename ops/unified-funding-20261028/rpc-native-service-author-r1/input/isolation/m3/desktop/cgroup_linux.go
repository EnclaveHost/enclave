//go:build linux && amd64

package desktop

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// Claim is consumed before launch side effects. Never unlink its file, including
// after failed setup: only a new guest boot may admit another desktop domain.
// The measured image must refuse ordinary domains before calling this function.
type Claim struct {
	nonce string
	file  *os.File
	used  atomic.Bool
}

func (c *Claim) ID() string   { return c.nonce }
func (c *Claim) Close() error { return c.file.Close() }
func AcquireClaim(dir string) (*Claim, error) {
	d, err := rootDirectory(dir)
	if err != nil {
		return nil, err
	}
	defer d.Close()
	st, err := d.Stat()
	if err != nil {
		return nil, err
	}
	var fs syscall.Statfs_t
	if st.Mode().Perm() != 0700 || syscall.Fstatfs(int(d.Fd()), &fs) != nil || fs.Type != 0x01021994 {
		return nil, errors.New("claim directory must be root-only guest tmpfs")
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(int(d.Fd()), "claimed", syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, fmt.Errorf("desktop guest already claimed or unavailable: %w", err)
	}
	f := os.NewFile(uintptr(fd), "desktop-claim")
	value := hex.EncodeToString(nonce)
	if _, err = f.WriteString(value + "\n"); err == nil {
		err = f.Chmod(0400)
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return &Claim{nonce: value, file: f}, nil
}

// Group keeps the same cgroup inode through configuration, CLONE_INTO_CGROUP
// and kill. No path reopen is used for controls; Close does not free resources.
type Group struct {
	file     *os.File
	parent   *os.File
	name     string
	terminal atomic.Bool
}

func (g *Group) FD() int {
	if g.terminal.Load() {
		return -1
	}
	return int(g.file.Fd())
}
func (g *Group) Snapshot() (map[string]string, error) {
	result := map[string]string{}
	for _, name := range []string{"cpu.max", "memory.max", "memory.swap.max", "memory.oom.group", "pids.max", "cgroup.events", "cpu.stat"} {
		v, err := readAt(g.file, name)
		if err != nil {
			return nil, err
		}
		result[name] = v
	}
	return result, nil
}
func readAt(d *os.File, name string) (string, error) {
	fd, err := syscall.Openat(int(d.Fd()), name, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return "", err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return "", err
	}
	if len(b) > 4096 {
		return "", errors.New("oversized cgroup control")
	}
	return strings.TrimSpace(string(b)), nil
}
func writeAt(d *os.File, name, value string) error {
	fd, err := syscall.Openat(int(d.Fd()), name, syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	f := os.NewFile(uintptr(fd), name)
	defer f.Close()
	n, err := f.WriteString(value)
	if err != nil {
		return err
	}
	if n != len(value) {
		return io.ErrShortWrite
	}
	return nil
}
func CheckCapacity(memMiB, guestVCPUs, wantVCPUs int, totalKiB uint64) error {
	if memMiB < 8192 || memMiB > 65536 || wantVCPUs < 4 || wantVCPUs > 16 || guestVCPUs < wantVCPUs || totalKiB < (uint64(memMiB)+512)*1024 {
		return errors.New("guest lacks desktop allocation plus platform reserve")
	}
	return nil
}
func NewGroup(parentPath string, claim *Claim, cpuPercent, memMiB, vcpus int) (*Group, error) {
	if claim == nil || claim.file == nil || len(claim.nonce) != 64 {
		return nil, errors.New("desktop claim required")
	}
	// A closed/replaced descriptor is not a claim. The nonce is pinned in it.
	st, err := claim.file.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Mode().Perm() != 0400 || st.Size() != 65 {
		return nil, errors.New("invalid desktop claim")
	}
	if st.Sys().(*syscall.Stat_t).Nlink != 1 || !claim.used.CompareAndSwap(false, true) {
		return nil, errors.New("desktop claim already consumed or unlinked")
	}
	limits, err := Limits(cpuPercent, memMiB, vcpus)
	if err != nil {
		return nil, err
	}
	p, err := rootDirectory(parentPath)
	if err != nil {
		return nil, err
	}
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(p.Fd()), &fs) != nil || fs.Type != 0x63677270 {
		p.Close()
		return nil, errors.New("not cgroup v2")
	}
	controllers, err := readAt(p, "cgroup.subtree_control")
	if err != nil {
		p.Close()
		return nil, err
	}
	have := map[string]bool{}
	for _, v := range strings.Fields(controllers) {
		have[v] = true
	}
	if !have["cpu"] || !have["memory"] || !have["pids"] {
		p.Close()
		return nil, errors.New("required cgroup controllers are not enabled")
	}
	name := "desktop-" + claim.nonce
	if err = syscall.Mkdirat(int(p.Fd()), name, 0700); err != nil {
		p.Close()
		return nil, err
	}
	fd, err := syscall.Openat(int(p.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		p.Close()
		return nil, err
	}
	g := &Group{file: os.NewFile(uintptr(fd), name), parent: p, name: name}
	fail := func(e error) (*Group, error) { g.Close(); return nil, e } // Leave failed setup claimed, not reusable.
	kind, err := readAt(g.file, "cgroup.type")
	if err != nil || kind != "domain" {
		return fail(errors.New("not an empty domain cgroup"))
	}
	procs, err := readAt(g.file, "cgroup.procs")
	if err != nil || procs != "" {
		return fail(errors.New("new cgroup already populated"))
	}
	for _, limit := range limits {
		if err = writeAt(g.file, limit[0], limit[1]); err != nil {
			return fail(fmt.Errorf("%s: %w", limit[0], err))
		}
		actual, e := readAt(g.file, limit[0])
		if e != nil || actual != limit[1] {
			return fail(fmt.Errorf("%s did not retain limit", limit[0]))
		}
	}
	return g, nil
}
func (g *Group) Empty() (bool, error) {
	raw, err := readAt(g.file, "cgroup.events")
	if err != nil {
		return false, err
	}
	seen := false
	empty := false
	for _, line := range strings.Split(raw, "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "populated" {
			if seen || f[1] != "0" && f[1] != "1" {
				return false, errors.New("invalid population state")
			}
			seen = true
			empty = f[1] == "0"
		}
	}
	if !seen {
		return false, errors.New("population state unavailable")
	}
	return empty, nil
}
func (g *Group) Kill(ctx context.Context) error {
	g.terminal.Store(true) // Teardown consumes the launch handle even if kill fails.
	if err := writeAt(g.file, "cgroup.kill", "1"); err != nil {
		return err
	}
	tick := time.NewTicker(10 * time.Millisecond)
	defer tick.Stop()
	for {
		empty, err := g.Empty()
		if err != nil {
			return err
		}
		if empty {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.C:
		}
	}
}
func (g *Group) Close() error {
	a := g.file.Close()
	b := g.parent.Close()
	if a != nil {
		return a
	}
	return b
}

// Remove is legal only after kernel-confirmed emptiness. A failure must keep the
// host capacity reservation held and poison this guest. Revoking worker stream
// permission does not release that reservation; the manager retains it until
// VM removal is confirmed. The consumed claim is never reset.
func (g *Group) Remove() error {
	empty, err := g.Empty()
	if err != nil {
		return err
	}
	if !empty {
		return errors.New("desktop cgroup still populated")
	}
	fd, err := syscall.Openat(int(g.parent.Fd()), g.name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer syscall.Close(fd)
	var a, b syscall.Stat_t
	if syscall.Fstat(fd, &a) != nil || syscall.Fstat(int(g.file.Fd()), &b) != nil || a.Dev != b.Dev || a.Ino != b.Ino {
		return errors.New("cgroup path no longer names owned inode")
	}
	name, err := syscall.BytePtrFromString(g.name)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall(syscall.SYS_UNLINKAT, g.parent.Fd(), uintptr(unsafe.Pointer(name)), 0x200)
	if errno != 0 {
		return errno
	}
	return nil
}
