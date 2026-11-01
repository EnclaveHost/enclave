//go:build linux && amd64

package rpcservice

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"syscall"
)

const cgroup2Magic = 0x63677270
const stRdonly = 0x1

type fileID struct{ dev, ino uint64 }

// osBackend uses only the borrowed descriptors for every control read, write
// and CLONE_INTO_CGROUP. No cgroup path is opened or reopened.
type osBackend struct {
	parent *os.File
	groups [roleCount]*os.File
}

func openBackend(g Groups) (backend, error) {
	groups := [roleCount]*os.File{roleEL: g.EL, roleCL: g.CL, roleBase: g.Base, roleProbe: g.Probe}
	if g.Parent == nil {
		return nil, errors.New("rpcservice: parent cgroup descriptor required")
	}
	for _, r := range allRoles {
		if groups[r] == nil {
			return nil, fmt.Errorf("rpcservice: %s cgroup descriptor required", r)
		}
	}
	if os.Geteuid() != 0 || os.Getuid() != 0 {
		return nil, errors.New("rpcservice: measured supervisor must reduce root credentials per role")
	}
	status, err := os.ReadFile("/proc/self/status")
	if err != nil || !inheritedRestrictions(string(status)) {
		return nil, errors.New("rpcservice: inherited no_new_privs and empty ambient/inheritable capabilities required")
	}
	// Read-only is a sanity check, not evidence that the measured root is
	// mounted here; that remains the caller's precondition.
	for _, p := range []string{interpreter, wrapper} {
		var fs syscall.Statfs_t
		if err := syscall.Statfs(p, &fs); err != nil {
			return nil, fmt.Errorf("rpcservice: %s: %w", p, err)
		}
		if fs.Flags&stRdonly == 0 {
			return nil, fmt.Errorf("rpcservice: %s is not on a read-only mount", p)
		}
	}
	parentID, err := cgroupDir(g.Parent)
	if err != nil {
		return nil, fmt.Errorf("rpcservice: parent: %w", err)
	}
	if err := expectControls(g.Parent, parentControls()); err != nil {
		return nil, fmt.Errorf("rpcservice: parent: %w", err)
	}
	seen := map[fileID]string{parentID: "parent"}
	for _, r := range allRoles {
		f := groups[r]
		id, err := cgroupDir(f)
		if err != nil {
			return nil, fmt.Errorf("rpcservice: %s: %w", r, err)
		}
		if prev, dup := seen[id]; dup {
			return nil, fmt.Errorf("rpcservice: %s cgroup is the same inode as %s", r, prev)
		}
		seen[id] = r.String()
		if up, err := dotdot(f); err != nil || up != parentID {
			return nil, fmt.Errorf("rpcservice: %s cgroup is not a direct child of the parent", r)
		}
		if err := expectControls(f, roleControls(r)); err != nil {
			return nil, fmt.Errorf("rpcservice: %s: %w", r, err)
		}
		if err := expectControls(f, [][2]string{{"cgroup.type", "domain"}}); err != nil {
			return nil, fmt.Errorf("rpcservice: %s: %w", r, err)
		}
		if empty, err := populatedZero(f); err != nil || !empty {
			return nil, fmt.Errorf("rpcservice: %s cgroup is not empty before launch", r)
		}
		// Opening for write does not kill; only a write does.
		fd, err := syscall.Openat(int(f.Fd()), "cgroup.kill", syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if err != nil {
			return nil, fmt.Errorf("rpcservice: %s cgroup.kill unavailable: %w", r, err)
		}
		syscall.Close(fd)
	}
	return &osBackend{parent: g.Parent, groups: groups}, nil
}

func cgroupDir(f *os.File) (fileID, error) {
	fd := int(f.Fd())
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return fileID{}, err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&0022 != 0 {
		return fileID{}, errors.New("cgroup must be a root-owned directory without group/world write access")
	}
	var fs syscall.Statfs_t
	if err := syscall.Fstatfs(fd, &fs); err != nil {
		return fileID{}, err
	}
	if fs.Type != cgroup2Magic {
		return fileID{}, errors.New("descriptor is not on cgroup v2")
	}
	return fileID{st.Dev, st.Ino}, nil
}

func dotdot(f *os.File) (fileID, error) {
	fd, err := syscall.Openat(int(f.Fd()), "..", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fileID{}, err
	}
	defer syscall.Close(fd)
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return fileID{}, err
	}
	return fileID{st.Dev, st.Ino}, nil
}

func expectControls(f *os.File, want [][2]string) error {
	for _, c := range want {
		actual, err := readAt(f, c[0])
		if err != nil {
			return fmt.Errorf("%s: %w", c[0], err)
		}
		if actual != c[1] {
			return fmt.Errorf("%s is %q, want %q", c[0], actual, c[1])
		}
	}
	return nil
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

func populatedZero(f *os.File) (bool, error) {
	raw, err := readAt(f, "cgroup.events")
	if err != nil {
		return false, err
	}
	seen, empty := false, false
	for _, line := range strings.Split(raw, "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "populated" {
			if seen || fields[1] != "0" && fields[1] != "1" {
				return false, errors.New("invalid population state")
			}
			seen, empty = true, fields[1] == "0"
		}
	}
	if !seen {
		return false, errors.New("population state unavailable")
	}
	return empty, nil
}

func (b *osBackend) group(r role) (*os.File, error) {
	f := b.groups[r]
	if int(f.Fd()) < 0 {
		return nil, fmt.Errorf("%s cgroup descriptor was closed", r)
	}
	return f, nil
}

// start places the wrapper in its role cgroup at clone time. os/exec returns
// the clone3 error when CLONE_INTO_CGROUP is unsupported; there is no fallback
// launch. Stdio stays nil (/dev/null): no pipes, so Wait cannot block on a
// descendant holding one open. Pdeathsig is tied to the creating OS thread and
// is defence in depth only; the independent monitor death guard is required.
func (b *osBackend) start(r role) (process, error) {
	f, err := b.group(r)
	if err != nil {
		return nil, err
	}
	// Pdeathsig is tied to the creating OS thread. Keep that thread alive
	// through Wait; a short-lived runtime thread must not kill healthy clients.
	started := make(chan struct {
		p   process
		err error
	}, 1)
	go func() {
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		cmd := roleCommand(r, int(f.Fd()))
		err := cmd.Start()
		runtime.KeepAlive(f)
		if err != nil {
			started <- struct {
				p   process
				err error
			}{nil, err}
			return
		}
		p := &waitedProcess{done: make(chan struct{})}
		started <- struct {
			p   process
			err error
		}{p, nil}
		p.err = cmd.Wait()
		close(p.done)
	}()
	rv := <-started
	return rv.p, rv.err
}

func (b *osBackend) kill(r role) error {
	f, err := b.group(r)
	if err != nil {
		return err
	}
	return writeAt(f, "cgroup.kill", "1")
}

func (b *osBackend) empty(r role) (bool, error) {
	f, err := b.group(r)
	if err != nil {
		return false, err
	}
	return populatedZero(f)
}

// Role identities belong to the dedicated RPC image, never the desktop image.
// Its mount setup must grant only the respective writable data subtree.
var roleUIDs = [roleCount]uint32{2101, 2102, 2103, 2104}

func roleCommand(r role, cgroupFD int) *exec.Cmd {
	args := argv(r)
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Env = cleanEnv()
	cmd.Dir = workDir
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: cgroupFD, Pdeathsig: syscall.SIGKILL,
		Credential: &syscall.Credential{Uid: roleUIDs[r], Gid: roleUIDs[r], Groups: []uint32{}}}
	return cmd
}

type waitedProcess struct {
	done chan struct{}
	err  error
}

func (p *waitedProcess) Wait() error { <-p.done; return p.err }
func inheritedRestrictions(status string) bool {
	wanted := map[string]string{"NoNewPrivs:": "1", "CapAmb:": "0000000000000000", "CapInh:": "0000000000000000"}
	seen := make(map[string]bool)
	for _, line := range strings.Split(status, "\n") {
		v := strings.Fields(line)
		if len(v) == 0 {
			continue
		}
		if want, ok := wanted[v[0]]; ok {
			if seen[v[0]] || len(v) != 2 || v[1] != want {
				return false
			}
			seen[v[0]] = true
		}
	}
	return len(seen) == len(wanted)
}
