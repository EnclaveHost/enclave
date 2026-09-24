// The runtime identity this domain states, and the two things it checks before stating it.
//
// ABI/2 (isolation/contract/RUNTIME.md) binds the runtime into report_data[0:32]: the app is a portable
// WebAssembly component, so WHAT compiled it and HOW matters as much as which bundle it was. The identity
// itself is written into the image at build time (build-domain.sh), which puts it inside the launch
// measurement on the kernel-hashes path - it is not something the host hands us at boot.
//
// But a file saying "wx: enforced" is a claim, and this project's rule is that a claim measured code makes
// about itself has to be one it actually tested (the monitor's VMPL0 refusal, isolation/m3/monitor). So
// before the front states an identity it checks the two properties a domain can check about itself:
//
//   - exec_pages: may this domain hold an executable page at all? mmap RW, then mprotect RX. A domain
//     that CANNOT (a stock Pixel pVM, measured; a Windows VBS enclave, ERROR_DYNAMIC_CODE_BLOCKED,
//     windows/PARITY.md) may not honestly claim execution=jit, because no JIT can run there.
//   - wx: is any page in this domain both writable and executable RIGHT NOW? Every mapping of every
//     process in this domain's cgroup is read. W^X "enforced" means the runtime publishes code
//     write-then-protect and never keeps W+X, and that is visible in /proc/<pid>/maps.
//
// A fault is fatal: the front exits rather than serving, exactly as the monitor does on an incoherent
// boundary tuple. A domain that cannot substantiate its runtime identity attests nothing.
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"enclave.host/isolation/contract"
)

type runtimeState struct {
	ID       contract.RuntimeIdentity
	RID      [32]byte
	SelfTest string // "exec_pages=allowed wx=clean maps=7 scope=cgroup:/dom1"
}

// loadRuntime reads the identity, validates it against the contract, checks it against this domain, and
// returns the state the attestation document and the ABI/2 binding are built from. A missing file is not
// an error: that domain keeps ABI/1, which is what every backend does until its owner wires ABI/2.
func loadRuntime(path string) (*runtimeState, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var id contract.RuntimeIdentity
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields() // an unknown field is a different identity than the one we would hash
	if err := dec.Decode(&id); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if err := id.Validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	rid, err := contract.RuntimeID(id)
	if err != nil {
		return nil, err
	}

	execPages := probeExecPages()
	if id.Execution == contract.ExecJIT && execPages != "allowed" {
		return nil, fmt.Errorf("the identity says execution=%s but this domain may not hold an executable page (exec_pages=%s): no JIT can run here, so the identity is false",
			contract.ExecJIT, execPages)
	}
	scope, pids, wx, err := scanWX()
	if err != nil {
		return nil, fmt.Errorf("W^X scan: %w", err)
	}
	if wx != "" {
		return nil, fmt.Errorf("the identity says wx=%s but this domain holds a writable AND executable mapping: %s",
			contract.WXEnforced, wx)
	}
	return &runtimeState{ID: id, RID: rid, SelfTest: fmt.Sprintf(
		"exec_pages=%s wx=clean maps=%d scope=%s", execPages, pids, scope)}, nil
}

// probeExecPages asks whether this domain may hold an executable page: the JIT pattern, one page, on
// purpose - mmap it writable, then ask for it executable. Refused means no JIT can run in this domain,
// whatever a configuration file says.
func probeExecPages() string {
	b, err := syscall.Mmap(-1, 0, 4096, syscall.PROT_READ|syscall.PROT_WRITE,
		syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS)
	if err != nil {
		return "no-mapping:" + err.Error()
	}
	defer syscall.Munmap(b)
	if err := syscall.Mprotect(b, syscall.PROT_READ|syscall.PROT_EXEC); err != nil {
		return "refused:" + err.Error()
	}
	// leave nothing executable behind: this probe is not a place to keep a page
	if err := syscall.Mprotect(b, syscall.PROT_READ); err != nil {
		return "allowed-unrevertable:" + err.Error()
	}
	return "allowed"
}

// scanWX reads every mapping of every process in THIS domain and returns the first that is both
// writable and executable, or "" when there is none.
//
// Scope matters for correctness, not tidiness. In M2 and M4a the domain is the whole guest, so every
// process in /proc belongs to it. In M3 several domains share a guest and each has its own cgroup
// (monitor/main.go: /sys/fs/cgroup/dom<N>, the front among its processes), and a scan that reached into
// a NEIGHBOUR would let one domain's runtime fault another domain's attestation - a cross-domain denial
// of service dressed as a security check, the N5 property in reverse. So the scan is cgroup-scoped
// whenever this process is in a cgroup other than the root.
func scanWX() (scope string, scanned int, found string, err error) {
	self, err := cgroupOf("self")
	if err != nil {
		return "", 0, "", err
	}
	scope = "all-processes"
	if self != "" && self != "/" {
		scope = "cgroup:" + self
	}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return "", 0, "", err
	}
	for _, e := range ents {
		pid, perr := strconv.Atoi(e.Name())
		if perr != nil {
			continue
		}
		if scope != "all-processes" {
			cg, cerr := cgroupOf(e.Name())
			if cerr != nil || cg != self { // a process that ended, or a neighbour: not ours to judge
				continue
			}
		}
		line, mapped, ferr := firstWXMapping(pid)
		if ferr != nil {
			continue // the process ended mid-scan; its mappings went with it
		}
		if !mapped {
			continue // a kernel thread: no address space of its own, and a guest's /proc is mostly these
		}
		scanned++
		if line != "" && found == "" {
			found = fmt.Sprintf("pid %d: %s", pid, line)
		}
	}
	if scanned == 0 {
		return scope, 0, "", fmt.Errorf("no process with an address space could be read in scope %s: a scan that sees nothing is not a clean scan", scope)
	}
	return scope, scanned, found, nil
}

// cgroupOf returns the cgroup-v2 path of a process ("0::<path>" in /proc/<pid>/cgroup), or "" when the
// kernel offers no v2 hierarchy.
func cgroupOf(pid string) (string, error) {
	raw, err := os.ReadFile("/proc/" + pid + "/cgroup")
	if err != nil {
		if pid == "self" && os.IsNotExist(err) {
			return "", nil // no cgroup support at all: scope is the whole domain
		}
		return "", err
	}
	for _, l := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(l, "0::") {
			return strings.TrimPrefix(l, "0::"), nil
		}
	}
	return "", nil
}

// firstWXMapping returns the first writable-and-executable mapping of a process, and whether the process
// has an address space at all: a kernel thread's maps file is empty, and counting those would make the
// scan's own count meaningless (74 "processes" in a guest running three).
func firstWXMapping(pid int) (line string, mapped bool, err error) {
	f, err := os.Open("/proc/" + strconv.Itoa(pid) + "/maps")
	if err != nil {
		return "", false, err
	}
	defer f.Close()
	s := bufio.NewScanner(f)
	s.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for s.Scan() {
		mapped = true
		fields := strings.Fields(s.Text())
		if len(fields) < 2 || len(fields[1]) < 4 {
			continue
		}
		if fields[1][1] == 'w' && fields[1][2] == 'x' {
			return s.Text(), true, nil
		}
	}
	return "", mapped, s.Err()
}
