package contract

// The W^X scan behind a domain's attested RuntimeSelfTest, shared by the front (m2/front: the SNP guest and M2/M4a,
// where the front is root and reads every process) and the NucBox monitor (m3/monitor: where the front runs as its own
// uid and cannot read the runtime, so root measures and hands the result to the front on its report channel).
//
// Two rules, from enclave-bf's review and enclave-87's ruling:
//   - a process whose mappings cannot be READ fails the scan. Only one PROVEN gone (its /proc entry absent, or ESRCH
//     mid-read) is skipped. Treating EACCES as "ended" let a scan that could read only its own process say wx=clean;
//   - the result names what it covered, by role (runtime, front, init, root, other), so "clean" cannot hide a scan that
//     never saw the runtime (the SNP front used to scan before the app existed).

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

// WXScan is what one scan saw.
type WXScan struct {
	Scope string         // all-processes | cgroup:<path>
	Roles map[string]int // processes with an address space, by role
	Found string         // "pid N (role): <maps line>", or "" when no mapping is both writable and executable
}

// Gone reports whether err means the process no longer exists (and so has no mappings to vouch for).
func Gone(err error) bool {
	return errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ESRCH)
}

// ScanWX reads every mapping of each pid and counts it under role(pid). role or the maps failing for any reason but
// Gone fails the whole scan. A scan that saw no process with an address space is an error, not a clean scan.
func ScanWX(scope string, pids []int, role func(pid int) (string, error)) (WXScan, error) {
	s := WXScan{Scope: scope, Roles: map[string]int{}}
	for _, pid := range pids {
		r, err := role(pid)
		if err != nil {
			if Gone(err) {
				continue
			}
			return s, fmt.Errorf("could not tell pid %d's role: %v: the scan cannot vouch for it", pid, err)
		}
		line, mapped, err := FirstWXMapping(pid)
		if err != nil {
			if Gone(err) {
				continue
			}
			return s, fmt.Errorf("could not read pid %d's mappings (%s): %v: the scan cannot vouch for it", pid, r, err)
		}
		if !mapped {
			continue // a kernel thread: no address space of its own
		}
		s.Roles[r]++
		if line != "" && s.Found == "" {
			s.Found = fmt.Sprintf("pid %d (%s): %s", pid, r, line)
		}
	}
	if s.Total() == 0 {
		return s, fmt.Errorf("no process with an address space could be read in scope %s: a scan that sees nothing is not a clean scan", scope)
	}
	return s, nil
}

// Total is the number of processes with an address space the scan read.
func (s WXScan) Total() int {
	n := 0
	for _, c := range s.Roles {
		n += c
	}
	return n
}

// Clean is the self-test's wx half when nothing was found: "wx=clean maps=N runtime=R <role>=n... scope=S", the roles
// after runtime in a fixed (sorted) order. The judge (m2/judge.mjs checkRuntimeSelfTest) requires the role counts to
// add up to maps, and runtime >= 1 where the runtime is a separate process.
func (s WXScan) Clean() string {
	var b strings.Builder
	fmt.Fprintf(&b, "wx=clean maps=%d runtime=%d", s.Total(), s.Roles["runtime"])
	var others []string
	for r := range s.Roles {
		if r != "runtime" {
			others = append(others, r)
		}
	}
	sort.Strings(others)
	for _, r := range others {
		fmt.Fprintf(&b, " %s=%d", r, s.Roles[r])
	}
	fmt.Fprintf(&b, " scope=%s", s.Scope)
	return b.String()
}

// FirstWXMapping returns the first writable-and-executable mapping of a process, and whether it has an address space
// at all (a kernel thread's maps is empty).
func FirstWXMapping(pid int) (line string, mapped bool, err error) {
	f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/maps")
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	return firstWX(f)
}

// firstWX reads a maps file. A line it cannot parse (fewer than two fields, or permissions shorter than "rwxp") is an
// ERROR, not a skip: the scan fails closed on anything it cannot read (enclave-5d's nit).
func firstWX(r io.Reader) (line string, mapped bool, err error) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		mapped = true
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 || len(fields[1]) < 4 {
			return "", mapped, fmt.Errorf("a maps line it cannot parse: %q", sc.Text())
		}
		if fields[1][1] == 'w' && fields[1][2] == 'x' {
			return sc.Text(), true, nil
		}
	}
	return "", mapped, sc.Err()
}

// UIDOf is a process's real uid, from /proc/<pid>/status.
func UIDOf(pid int) (int, error) {
	f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/status")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if rest, ok := strings.CutPrefix(sc.Text(), "Uid:"); ok {
			ids := strings.Fields(rest)
			if len(ids) == 0 {
				break
			}
			return strconv.Atoi(ids[0])
		}
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("pid %d: no Uid line", pid)
}
