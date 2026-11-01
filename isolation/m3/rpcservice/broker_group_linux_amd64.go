//go:build linux && amd64

package rpcservice

import (
	"errors"
	"os"
	"strconv"
	"strings"
	"syscall"
)

var brokerControls = [][2]string{{"memory.max", "134217728"}, {"memory.swap.max", "0"}, {"memory.oom.group", "1"}, {"pids.max", "32"}, {"cpu.max", "100000 100000"}}

// PrepareBrokerGroup exclusively consumes a name before launch. The held parent
// must be an actual root-owned cgroup2 delegation with its controllers enabled.
// The caller retains both handles through all ambiguous outcomes; no adoption,
// membership move, removal or retry is performed here.
func PrepareBrokerGroup(parent *os.File, nonce string) (*os.File, *os.File, error) {
	if parent == nil || len(nonce) != 64 || strings.Trim(nonce, "0123456789abcdef") != "" || strings.Trim(nonce, "0") == "" {
		return nil, nil, errors.New("exact broker nonce required")
	}
	if _, e := cgroupDir(parent); e != nil {
		return nil, nil, e
	}
	c, e := readAt(parent, "cgroup.subtree_control")
	if e != nil || !hasControllers(c) {
		return nil, nil, errors.New("broker controllers unavailable")
	}
	g, e := newGroupAt(parent, "rpc-broker-"+nonce, brokerControls)
	if e != nil {
		return nil, nil, e
	}
	fd, e := syscall.Openat(int(g.Fd()), "cgroup.kill", syscall.O_WRONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if e != nil {
		return g, nil, e
	}
	return g, os.NewFile(uintptr(fd), "broker-kill"), nil
}

// VerifyBrokerGroup checks actual membership and all limits against the same
// held group used for CLONE_INTO_CGROUP. PID must be backed by a live held pidfd.
func VerifyBrokerGroup(g *os.File, pid int) error {
	if g == nil || pid <= 0 {
		return errors.New("held broker group and process required")
	}
	if _, e := cgroupDir(g); e != nil {
		return e
	}
	if e := expectControls(g, brokerControls); e != nil {
		return e
	}
	members, e := readAt(g, "cgroup.procs")
	if e != nil {
		return e
	}
	if members != strconv.Itoa(pid) {
		return errors.New("broker group membership differs")
	}
	return nil
}

// BrokerGroupEmpty is only local process quiescence, never a writer fence or
// permission to release a provider/storage reservation.
func BrokerGroupEmpty(g *os.File) (bool, error) { return populatedZero(g) }
