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
//   - wx: is any page in this domain both writable and executable? W^X "enforced" means the runtime publishes
//     code write-then-protect and never keeps W+X, and that is visible in /proc/<pid>/maps. It is measured at
//     EACH ATTESTATION, not once at start (enclave-b4's finding, enclave-87's ruling): on the SNP guest the
//     front starts before the app exists, so a start-time scan never covered the runtime. And it names what it
//     covered by role, so a judge can refuse a scan that saw no runtime. On the NucBox (M3) the front runs as
//     its own uid and cannot read the runtime, so the MONITOR measures and returns the result with the report.
//
// exec_pages is probed once at start and is fatal there; a W+X mapping found at an attestation refuses that
// document. A domain that cannot substantiate its runtime identity attests nothing.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"syscall"

	"enclave.host/isolation/contract"
)

type runtimeState struct {
	ID        contract.RuntimeIdentity
	RID       [32]byte
	ExecPages string // "allowed", or why not; the wx half is measured at each attestation (selfTest)
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
	return &runtimeState{ID: id, RID: rid, ExecPages: execPages}, nil
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

// localSelfTest is the runtime self-test as THIS front can measure it, for a document being issued now: exec_pages
// from start, and a W^X scan of this domain made now (contract.ScanWX: an unreadable mapping FAILS it). It is used
// where the front can read every process of its domain - the SNP guest, M2 and M4a, where it is root. A process's
// role is its uid: root (init and the front) or runtime (the app, dropped to its own uid). A W+X mapping refuses the
// document.
//
// Scope matters for correctness, not tidiness. In M2 and M4a the domain is the whole guest, so every process in /proc
// belongs to it. In a cgroup other than the root the scan is cgroup-scoped, so it never reaches a NEIGHBOUR's process
// (which would let one domain fault another's attestation).
func localSelfTest(execPages, seccompStatement string) (string, error) {
	self, err := cgroupOf("self")
	if err != nil {
		return "", err
	}
	scope := "all-processes"
	if self != "" && self != "/" {
		scope = "cgroup:" + self
	}
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return "", err
	}
	var pids []int
	for _, e := range ents {
		pid, perr := strconv.Atoi(e.Name())
		if perr != nil {
			continue
		}
		if scope != "all-processes" {
			cg, cerr := cgroupOf(e.Name())
			if cerr != nil {
				if contract.Gone(cerr) {
					continue
				}
				return "", fmt.Errorf("pid %d's cgroup: %w", pid, cerr)
			}
			if cg != self {
				continue // a neighbour: not ours to judge
			}
		}
		pids = append(pids, pid)
	}
	scan, err := contract.ScanWX(scope, pids, func(pid int) (string, error) {
		uid, err := contract.UIDOf(pid)
		if err != nil {
			return "", err
		}
		if uid == 0 {
			return "root", nil
		}
		return "runtime", nil
	})
	if err != nil {
		return "", fmt.Errorf("W^X scan: %w", err)
	}
	if scan.Found != "" {
		return "", fmt.Errorf("the identity says wx=%s but this domain holds a writable AND executable mapping: %s", contract.WXEnforced, scan.Found)
	}
	// the runtime's seccomp filter (enclave-87: positive evidence): every runtime process must be under a filter NOW, and
	// init's statement (dominit, root-only: seccompStatement) says which one - carried as seccomp=<hash>. No statement
	// yet (the app not started) states none, which a judge refuses for a release that must state it.
	if err := scan.CheckRuntimeFiltered(); err != nil {
		return "", err
	}
	if seccompStatement != "" {
		b, err := os.ReadFile(seccompStatement)
		switch {
		case err == nil:
			h, perr := contract.ParseSeccompStatement(b)
			if perr != nil {
				return "", fmt.Errorf("init's seccomp statement: %w", perr)
			}
			scan.Seccomp = h
		case !errors.Is(err, fs.ErrNotExist):
			return "", fmt.Errorf("init's seccomp statement: %w", err)
		}
	}
	return "exec_pages=" + execPages + " " + scan.Clean(), nil
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
