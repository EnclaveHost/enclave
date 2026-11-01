//go:build linux && amd64

package rpcdomain

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// Launch retains every preparation capability through Start, Wait and any
// uncertain cleanup. It deliberately has no Close/retry/release method. Cmd
// runs the exact pinned entry in fresh namespaces and at birth in its control
// cgroup. Constructing it is not accepted-platform or storage authorization.
type Launch struct {
	Cmd           *exec.Cmd
	Capabilities  Capabilities
	NamespaceRoot *os.File
}

// Command is the monitor's one-shot handoff after it has composed a verified
// root, authenticated both persistent attachments and installed role/network
// policy. The independent outer guardian must already cover preparation and
// Start. No CLI path, executable, UID, budget or new deadline is accepted.
// The monitor must register the fixed front UID before starting this command.
func (p *Prepared) Command(namespaceRoot *os.File) (*Launch, error) {
	if err := commandRoot(namespaceRoot); err != nil {
		return nil, err
	}
	c, err := p.Take()
	if err != nil {
		return nil, err
	}
	return command(c, namespaceRoot), nil
}

func commandRoot(f *os.File) error {
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if f == nil || syscall.Fstat(int(f.Fd()), &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFDIR || st.Uid != 0 || st.Mode&0022 != 0 || syscall.Fstatfs(int(f.Fd()), &fs) != nil || fs.Flags&7 != 7 {
		return errors.New("protected read-only nosuid/nodev composed namespace root required")
	}
	return nil
}

func command(c Capabilities, root *os.File) *Launch {
	cmd := exec.Command("/proc/self/fd/14")
	cmd.Args = []string{"rpc-native-init"}
	cmd.Env = []string{"PATH=/usr/bin:/bin", "LANG=C.UTF-8"}
	cmd.ExtraFiles = []*os.File{c.Owner, c.Deadline, c.Groups.Parent,
		c.Groups.EL, c.Groups.CL, c.Groups.Base, c.Groups.Probe, c.Control,
		c.Groups.Controller, c.Groups.Front, root, c.Entry}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Cloneflags:  syscall.CLONE_NEWNS | syscall.CLONE_NEWPID | syscall.CLONE_NEWNET | syscall.CLONE_NEWIPC | syscall.CLONE_NEWUTS,
		UseCgroupFD: true, CgroupFD: int(c.Control.Fd()),
	}
	// nil stdio becomes /dev/null; no pipe copy goroutines or private output.
	// Exact owner pidfd + original deadline are watched by PID1 after exec;
	// never substitute transport exit or a parent-thread death signal for it.
	return &Launch{Cmd: cmd, Capabilities: c, NamespaceRoot: root}
}
