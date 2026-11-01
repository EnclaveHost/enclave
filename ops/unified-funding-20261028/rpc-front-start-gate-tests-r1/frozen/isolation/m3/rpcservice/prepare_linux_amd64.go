//go:build linux && amd64

package rpcservice

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"syscall"
)

// PreparedGroups is the monitor-owned, unused eight-cgroup topology. Creation
// performs no launch, membership move, deletion or retry. Failed directories
// remain consumed. A caller must already own the one-shot app claim.
type PreparedGroups struct {
	mu      sync.Mutex
	groups  Groups
	control *os.File
	taken   bool
}

// PrepareGroups uses a held root-owned cgroup2 parent with cpu/memory/pids
// already enabled. The nonce is from the monitor's consumed claim. No paths,
// budgets, existing groups, or host-provided membership can be adopted.
func PrepareGroups(parent *os.File, nonce string) (*PreparedGroups, error) {
	if parent == nil || len(nonce) != 64 || strings.Trim(nonce, "0123456789abcdef") != "" || strings.Trim(nonce, "0") == "" {
		return nil, errors.New("RPC claim nonce and held cgroup root required")
	}
	if _, err := cgroupDir(parent); err != nil {
		return nil, err
	}
	controllers, err := readAt(parent, "cgroup.subtree_control")
	if err != nil {
		return nil, err
	}
	if !hasControllers(controllers) {
		return nil, errors.New("RPC cpu/memory/pids controllers must already be enabled")
	}
	top, err := newGroupAt(parent, "rpc-"+nonce, parentControls())
	if err != nil {
		return nil, err
	}
	p := &PreparedGroups{groups: Groups{Parent: top}}
	fail := func(err error) (*PreparedGroups, error) { p.closeUnused(); return nil, err }
	if err = writeAt(top, "cgroup.subtree_control", "+cpu +memory +pids"); err != nil {
		return fail(err)
	}
	controllers, err = readAt(top, "cgroup.subtree_control")
	if err != nil || !hasControllers(controllers) {
		return fail(errors.New("RPC child controllers did not remain enabled"))
	}
	targets := []**os.File{&p.groups.EL, &p.groups.CL, &p.groups.Base, &p.groups.Probe, &p.groups.Controller, &p.groups.Front}
	for _, r := range allRoles {
		f, e := newGroupAt(top, r.String(), roleControls(r))
		if e != nil {
			return fail(e)
		}
		*targets[int(r)] = f
	}
	p.control, err = newGroupAt(top, "control", [][2]string{{"memory.max", "134217728"}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"pids.max", "128"}, {"cpu.max", "max 100000"}})
	if err != nil {
		return fail(err)
	}
	return p, nil
}
func hasControllers(raw string) bool {
	have := map[string]bool{}
	for _, v := range strings.Fields(raw) {
		if have[v] {
			return false
		}
		have[v] = true
	}
	return have["cpu"] && have["memory"] && have["pids"]
}
func newGroupAt(parent *os.File, name string, limits [][2]string) (*os.File, error) {
	if err := syscall.Mkdirat(int(parent.Fd()), name, 0700); err != nil {
		return nil, err
	}
	fd, err := syscall.Openat(int(parent.Fd()), name, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), name)
	fail := func(e error) (*os.File, error) { f.Close(); return nil, e }
	if _, err = cgroupDir(f); err != nil {
		return fail(err)
	}
	if err = expectControls(f, [][2]string{{"cgroup.type", "domain"}, {"cgroup.procs", ""}}); err != nil {
		return fail(err)
	}
	if empty, e := populatedZero(f); e != nil || !empty {
		return fail(errors.New("new RPC cgroup already populated"))
	}
	for _, c := range limits {
		if c[0] != "cgroup.type" {
			if err = writeAt(f, c[0], c[1]); err != nil {
				return fail(err)
			}
		}
		if err = expectControls(f, [][2]string{c}); err != nil {
			return fail(err)
		}
	}
	// Readability alone is insufficient: the monitor must retain kill authority.
	kill, err := syscall.Openat(fd, "cgroup.kill", syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return fail(fmt.Errorf("RPC cgroup.kill: %w", err))
	}
	syscall.Close(kill)
	return f, nil
}
func (p *PreparedGroups) closeUnused() error {
	var errs []error
	for _, f := range []*os.File{p.control, p.groups.Front, p.groups.Controller, p.groups.Probe, p.groups.Base, p.groups.CL, p.groups.EL, p.groups.Parent} {
		if f != nil {
			errs = append(errs, f.Close())
		}
	}
	return errors.Join(errs...)
}

// Abandon is legal only before Take. No process can have received the hidden
// descriptors through this API yet. Never removes the directories or claim.
func (p *PreparedGroups) Abandon() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken {
		return errors.New("RPC groups already transferred; retain until exact quiescence")
	}
	p.taken = true
	return p.closeUnused()
}

// Take transfers all capabilities once, before launch. The monitor retains them
// through any in-flight clone/control operation and exact final cleanup. This
// is not a launch authorization or a storage-release result.
func (p *PreparedGroups) Take() (Groups, *os.File, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken {
		return Groups{}, nil, errors.New("RPC groups already consumed")
	}
	p.taken = true
	return p.groups, p.control, nil
}
