package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"enclave.host/isolation/contract"
)

// Only the eight held groups in the actual launch are scanned. In particular,
// the empty parent is not mistaken for the whole tree. Unknown children,
// identity/role changes, missing clients, unfiltered workers or disappearing
// processes refuse a report rather than converting a partial scan to clean.
func (m *monitor) scanRPC(d *domain) string {
	scan, err := rpcWX(d)
	if err != nil {
		return "wx=error: " + err.Error()
	}
	if scan.Found != "" {
		return "wx=found " + scan.Found
	}
	return scan.Clean()
}

type rpcScanGroup struct {
	file     *os.File
	uid      int
	role     string
	required bool
}

func rpcPIDs(f *os.File) ([]int, error) {
	if f == nil {
		return nil, errors.New("missing held RPC group")
	}
	var fs syscall.Statfs_t
	if syscall.Fstatfs(int(f.Fd()), &fs) != nil || fs.Type != 0x63677270 {
		return nil, errors.New("RPC scan requires cgroup2")
	}
	fd, err := syscall.Openat(int(f.Fd()), "cgroup.procs", syscall.O_RDONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), "rpc-scan-procs")
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 65537))
	if err != nil || len(raw) > 65536 {
		return nil, errors.New("RPC group process list unavailable/oversize")
	}
	return parseRPCPIDs(string(raw))
}
func parseRPCPIDs(raw string) ([]int, error) {
	fields := strings.Fields(raw)
	if len(fields) > 4096 {
		return nil, errors.New("RPC process cap exceeded")
	}
	seen := map[int]bool{}
	out := make([]int, 0, len(fields))
	for _, s := range fields {
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 || strconv.Itoa(n) != s || seen[n] {
			return nil, errors.New("invalid/duplicate RPC process identity")
		}
		seen[n] = true
		out = append(out, n)
	}
	sort.Ints(out)
	return out, nil
}
func rpcWX(d *domain) (contract.WXScan, error) {
	fail := func(err error) (contract.WXScan, error) { return contract.WXScan{}, err }
	if d.rpc == nil || d.rpc.launch == nil {
		return fail(errors.New("RPC launch capabilities absent"))
	}
	c := d.rpc.launch.Capabilities
	g := c.Groups
	groups := []rpcScanGroup{{g.Parent, -1, "", false}, {c.Control, 0, "init", true}, {g.Front, 1053577, "front", true}, {g.Controller, 2105, "runtime", true}, {g.EL, 2101, "runtime", true}, {g.CL, 2102, "runtime", true}, {g.Base, 2103, "runtime", true}, {g.Probe, 2104, "runtime", false}}
	// Fixed child names must still map to the exact held directory identities.
	names := []string{"control", "front", "controller", "el", "cl", "base", "probe"}
	if !contract.NonzeroHash(c.ClaimID) {
		return fail(errors.New("missing RPC claim identity"))
	}
	for _, row := range groups {
		if row.file == nil {
			return fail(errors.New("missing held RPC role"))
		}
	}
	if _, e := rpcPIDs(g.Parent); e != nil {
		return fail(e)
	}
	tree, err := os.Open(fmt.Sprintf("/proc/self/fd/%d", g.Parent.Fd()))
	if err != nil {
		return fail(err)
	}
	entries, err := tree.ReadDir(129)
	tree.Close()
	if err != nil && err != io.EOF || len(entries) > 128 {
		return fail(err)
	}
	children := 0
	for _, e := range entries {
		if e.IsDir() {
			children++
		}
	}
	if children != len(names) {
		return fail(errors.New("RPC role tree differs"))
	}
	for i, name := range names {
		fd, e := syscall.Openat(int(g.Parent.Fd()), name, syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if e != nil {
			return fail(e)
		}
		var a, b syscall.Stat_t
		e = syscall.Fstat(fd, &a)
		syscall.Close(fd)
		if e != nil || syscall.Fstat(int(groups[i+1].file.Fd()), &b) != nil || a.Dev != b.Dev || a.Ino != b.Ino {
			return fail(errors.New("RPC role group identity changed"))
		}
	}
	snapshots := make([][]int, len(groups))
	byPID := map[int]rpcScanGroup{}
	pids := []int{}
	held := []int{}
	defer func() {
		for _, fd := range held {
			syscall.Close(fd)
		}
	}()
	for i, row := range groups {
		ids, e := rpcPIDs(row.file)
		if e != nil {
			return fail(e)
		}
		if i == 0 && len(ids) != 0 || row.required && len(ids) == 0 {
			return fail(errors.New("RPC parent populated or required role absent"))
		}
		snapshots[i] = ids
		for _, pid := range ids {
			if _, ok := byPID[pid]; ok {
				return fail(errors.New("RPC pid in multiple groups"))
			}
			fd, _, eno := syscall.Syscall(434, uintptr(pid), 0, 0)
			if eno != 0 {
				return fail(eno)
			}
			held = append(held, int(fd))
			byPID[pid] = row
			pids = append(pids, pid)
		}
	}
	scan, err := contract.ScanWX("cgroup:/rpc-"+c.ClaimID, pids, func(pid int) (string, error) {
		row := byPID[pid]
		uid, e := contract.UIDOf(pid)
		if e != nil {
			return "", e
		}
		if uid != row.uid {
			return "", errors.New("RPC role UID changed")
		}
		return row.role, nil
	})
	if err != nil {
		return fail(err)
	}
	if len(scan.RuntimePids) != len(pids)-len(snapshots[1])-len(snapshots[2]) || scan.Roles["init"] != len(snapshots[1]) || scan.Roles["front"] != len(snapshots[2]) {
		return fail(errors.New("RPC scan did not cover every role process"))
	}
	if err = scan.CheckRuntimeFiltered(); err != nil {
		return fail(err)
	}
	// No pid may have exited/recycled during the scan. The held pidfds are exact
	// lifetime handles; numbers alone, or ESRCH treated as success, are insufficient.
	for _, fd := range held {
		poll := struct {
			FD              int32
			Events, Revents int16
		}{FD: int32(fd), Events: 1}
		n, _, eno := syscall.Syscall(syscall.SYS_POLL, uintptr(unsafe.Pointer(&poll)), 1, 0)
		if eno != 0 || n != 0 {
			return fail(errors.New("RPC process exited/changed during scan"))
		}
	}
	for i, row := range groups {
		ids, e := rpcPIDs(row.file)
		if e != nil || fmt.Sprint(ids) != fmt.Sprint(snapshots[i]) {
			return fail(errors.New("RPC group population changed during scan"))
		}
	}
	return scan, nil
}
