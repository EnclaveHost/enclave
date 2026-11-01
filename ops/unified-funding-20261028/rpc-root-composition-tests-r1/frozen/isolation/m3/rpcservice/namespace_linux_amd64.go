//go:build linux && amd64

package rpcservice

import (
	"errors"
	"io"
	"os"
	"runtime"
	"syscall"
)

// enterNamespace consumes only the held, monitor-composed root. The monitor
// must have verified its code and authenticated its writable attachments. A
// read-only mount and root ownership do not supply either authority.
//
// The original owner/deadline watchdog is already armed. This function runs
// only as PID1 in the mount/PID namespaces created with the control cgroup.
// No external path, host command, mount source or new timeout is accepted.
func enterNamespace(root *os.File) error {
	if os.Getpid() != 1 || os.Getuid() != 0 || os.Geteuid() != 0 {
		return errors.New("RPC namespace PID1 required")
	}
	if err := checkNamespaceRoot(root); err != nil {
		return err
	}
	// These operations must stay on the same thread. All Go threads already
	// share the freshly cloned mount namespace; no setns/unshare here.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	if err := syscall.Mount("", "/", "", syscall.MS_PRIVATE|syscall.MS_REC, ""); err != nil {
		return err
	}
	if err := syscall.Fchdir(int(root.Fd())); err != nil {
		return err
	}
	if err := syscall.Chroot("."); err != nil {
		return err
	}
	if err := syscall.Chdir("/"); err != nil {
		return err
	}
	// Never retain an outside root directory in the service supervisor. The
	// remaining outside capabilities are the explicitly assigned cgroup/pidfds.
	if err := root.Close(); err != nil {
		return err
	}
	fd, err := syscall.Open("/proc", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	p := os.NewFile(uintptr(fd), "rpc-proc-target")
	entries, err := p.Readdirnames(1)
	p.Close()
	if len(entries) != 0 || err != io.EOF {
		return errors.New("RPC proc target must be empty")
	}
	flags := uintptr(syscall.MS_NOSUID | syscall.MS_NODEV | syscall.MS_NOEXEC)
	if err = syscall.Mount("proc", "/proc", "proc", flags, "hidepid=2"); err != nil {
		return err
	}
	if err = syscall.Mount("", "/proc", "", flags|syscall.MS_REMOUNT|syscall.MS_RDONLY, "hidepid=2"); err != nil {
		return err
	}
	// An inherited ancestor proc view must never survive the switch. PID1 in
	// this mount must be us, not the monitor or the physical host's init.
	self, err := os.Readlink("/proc/self/ns/pid")
	if err != nil {
		return err
	}
	one, err := os.Readlink("/proc/1/ns/pid")
	if err != nil || self != one {
		return errors.New("RPC proc view is not the new PID namespace")
	}
	_, _, e := syscall.AllThreadsSyscall6(syscall.SYS_PRCTL, 38, 1, 0, 0, 0, 0) // NO_NEW_PRIVS
	if e != 0 {
		return e
	}
	return nil
}

func checkNamespaceRoot(root *os.File) error {
	if root == nil {
		return errors.New("held RPC namespace root required")
	}
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if syscall.Fstat(int(root.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&0022 != 0 || syscall.Fstatfs(int(root.Fd()), &fs) != nil || fs.Flags&7 != 7 {
		return errors.New("RPC namespace root must be root-owned, read-only, nosuid and nodev")
	}
	return nil
}
