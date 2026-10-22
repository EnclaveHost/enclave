// jobprobe: a TEST-ONLY program for the bounded W2 validation on minipc (work/hosted-services-activation/winval).
// The REAL hostsvc-supervisor starts it in place of node.exe (supervisor.json "node"), so it runs as the job's first
// process, exactly where the runner runs. From inside, it reads the job's own documented counters
// (QueryInformationJobObject with a NULL handle = "the immediate job of the calling process"):
//   - JobObjectExtendedLimitInformation: LimitFlags, JobMemoryLimit, PeakJobMemoryUsed;
//   - JobObjectBasicProcessIdList: every process of the job;
//   - per process PROCESS_MEMORY_COUNTERS_EX.PrivateUsage ("the Commit Charge value ... for this process").
//
// It never touches a process outside its own job, commits at most the job limit, and exits by itself.
//
// Experiments (results.json in the working directory):
//
//	A  concurrent children commit 8 MiB steps (each page written) until the job refuses, then hold: the job's commit is
//	   sampled every 10 ms; at the end every child holds what it got;
//	B  while the job is full, one more process is created: is process creation itself held to the limit?
//	C  the exact boundary: after release, a binary search for the largest single commit that still succeeds, so the
//	   job's own charge (limit - largest) is compared with the sum of PrivateUsage;
//	D  peak semantics: single commits that the job MUST refuse (limit + 256 MiB, limit + 768 MiB); PeakJobMemoryUsed
//	   is read before and after each refusal while the committed sum is unchanged.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const mib = 1 << 20

var (
	k32                     = windows.NewLazySystemDLL("kernel32.dll")
	procGetProcessMemoryInf = k32.NewProc("K32GetProcessMemoryInfo")
	procGlobalMemoryStatus  = k32.NewProc("GlobalMemoryStatusEx")
)

type pmcEx struct {
	Cb                                                 uint32
	PageFaultCount                                     uint32
	PeakWorkingSetSize, WorkingSetSize                 uintptr
	QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage       uintptr
	QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage uintptr
	PagefileUsage, PeakPagefileUsage, PrivateUsage     uintptr
}

type memStatusEx struct {
	Length, MemoryLoad                             uint32
	TotalPhys, AvailPhys, TotalPageFile, AvailPage uint64
	TotalVirtual, AvailVirtual, AvailExtended      uint64
}

type pidList struct {
	Assigned, InList uint32
	Pids             [64]uintptr
}

type Snap struct {
	AtMs       int64              `json:"atMs"`
	LimitFlags uint32             `json:"limitFlags"`
	LimitMiB   float64            `json:"jobMemoryLimitMiB"`
	PeakMiB    float64            `json:"peakJobMemoryUsedMiB"`
	Processes  int                `json:"processes"`
	CommitMiB  float64            `json:"sumPrivateUsageMiB"`
	PerProcess map[string]float64 `json:"privateUsageMiB,omitempty"`
}

type Host struct {
	AvailPhysMiB   uint64 `json:"availPhysMiB"`
	AvailCommitMiB uint64 `json:"availCommitMiB"`
	CommitLimitMiB uint64 `json:"commitLimitMiB"`
	MemoryLoadPct  uint32 `json:"memoryLoadPct"`
}

var t0 = time.Now()

func host() Host {
	var m memStatusEx
	m.Length = uint32(unsafe.Sizeof(m))
	procGlobalMemoryStatus.Call(uintptr(unsafe.Pointer(&m)))
	return Host{m.AvailPhys / mib, m.AvailPage / mib, m.TotalPageFile / mib, m.MemoryLoad}
}

func snap(detail bool) Snap {
	var ext windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if err := windows.QueryInformationJobObject(0, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&ext)), uint32(unsafe.Sizeof(ext)), nil); err != nil {
		fatal("query extended limits of my own job: %v", err)
	}
	var pl pidList
	if err := windows.QueryInformationJobObject(0, windows.JobObjectBasicProcessIdList, uintptr(unsafe.Pointer(&pl)), uint32(unsafe.Sizeof(pl)), nil); err != nil {
		fatal("query the process list of my own job: %v", err)
	}
	s := Snap{AtMs: time.Since(t0).Milliseconds(), LimitFlags: ext.BasicLimitInformation.LimitFlags,
		LimitMiB: float64(ext.JobMemoryLimit) / mib, PeakMiB: float64(ext.PeakJobMemoryUsed) / mib, Processes: int(pl.InList)}
	if detail {
		s.PerProcess = map[string]float64{}
	}
	var sum uintptr
	for _, pid := range pl.Pids[:pl.InList] {
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			continue
		}
		var c pmcEx
		c.Cb = uint32(unsafe.Sizeof(c))
		if r, _, _ := procGetProcessMemoryInf.Call(uintptr(h), uintptr(unsafe.Pointer(&c)), uintptr(c.Cb)); r != 0 {
			sum += c.PrivateUsage
			if detail {
				s.PerProcess[strconv.Itoa(int(pid))] = float64(c.PrivateUsage) / mib
			}
		}
		windows.CloseHandle(h)
	}
	s.CommitMiB = float64(sum) / mib
	return s
}

func commit(bytes uintptr) (uintptr, error) {
	return windows.VirtualAlloc(0, bytes, windows.MEM_COMMIT|windows.MEM_RESERVE, windows.PAGE_READWRITE)
}

func touch(addr, bytes uintptr) {
	for off := uintptr(0); off < bytes; off += 4096 {
		*(*byte)(unsafe.Pointer(addr + off)) = 1
	}
}

func errno(err error) string {
	if e, ok := err.(syscall.Errno); ok {
		return fmt.Sprintf("%d %s", uintptr(e), e.Error())
	}
	return err.Error()
}

func fatal(f string, a ...any) { fmt.Fprintf(os.Stderr, "jobprobe: "+f+"\n", a...); os.Exit(1) }

func writeJSON(path string, v any) {
	b, _ := json.MarshalIndent(v, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		fatal("%v", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		fatal("%v", err)
	}
}

func exists(p string) bool { _, err := os.Stat(p); return err == nil }

// child <i> <stepMiB> <dir>: commit+write steps until refused, report, hold until <dir>\release (60 s at most).
// stepMiB 0 = commit nothing (the process-creation probe).
func child(i string, step int, dir string) {
	rep := map[string]any{"pid": os.Getpid()}
	got := 0
	for step > 0 {
		a, err := commit(uintptr(step) * mib)
		if err != nil {
			rep["refused"] = errno(err)
			break
		}
		touch(a, uintptr(step)*mib)
		got += step
		time.Sleep(2 * time.Millisecond) // interleave with the siblings
	}
	rep["grantedMiB"] = got
	writeJSON(filepath.Join(dir, "child-"+i+".json"), rep)
	for end := time.Now().Add(60 * time.Second); time.Now().Before(end) && !exists(filepath.Join(dir, "release")); {
		time.Sleep(50 * time.Millisecond)
	}
}

func main() {
	if len(os.Args) == 5 && os.Args[1] == "child" {
		step, _ := strconv.Atoi(os.Args[3])
		child(os.Args[2], step, os.Args[4])
		return
	}
	dir, _ := os.Getwd()
	self, _ := os.Executable()
	const children, step = 3, 8
	out := map[string]any{"args": os.Args[1:], "hostStart": host(), "start": snap(true)}
	start := out["start"].(Snap)
	if start.LimitFlags&windows.JOB_OBJECT_LIMIT_JOB_MEMORY == 0 {
		fatal("my job has no JOB_OBJECT_LIMIT_JOB_MEMORY: not started by the supervisor?")
	}
	limit := start.LimitMiB

	// A: concurrent children
	var procs []*exec.Cmd
	for i := 0; i < children; i++ {
		c := exec.Command(self, "child", strconv.Itoa(i), strconv.Itoa(step), dir)
		if err := c.Start(); err != nil {
			fatal("start child %d: %v", i, err)
		}
		procs = append(procs, c)
	}
	var maxS Snap
	samples := 0
	for end := time.Now().Add(60 * time.Second); time.Now().Before(end); {
		s := snap(false)
		samples++
		if s.CommitMiB > maxS.CommitMiB {
			maxS = s
		}
		done := 0
		for i := 0; i < children; i++ {
			if exists(filepath.Join(dir, fmt.Sprintf("child-%d.json", i))) {
				done++
			}
		}
		if done == children {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	reports := []any{}
	for i := 0; i < children; i++ {
		var r map[string]any
		b, _ := os.ReadFile(filepath.Join(dir, fmt.Sprintf("child-%d.json", i)))
		json.Unmarshal(b, &r)
		reports = append(reports, r)
	}
	full := snap(true)
	out["A"] = map[string]any{"children": children, "stepMiB": step, "samples": samples, "maxSampled": maxS, "holding": full,
		"reports": reports, "host": host()}

	// B: one more process while the job is full
	extra := exec.Command(self, "child", "extra", "0", dir)
	b := map[string]any{"before": snap(false)}
	if err := extra.Start(); err != nil {
		b["start"] = "refused: " + err.Error()
	} else {
		b["start"] = "started"
		for end := time.Now().Add(15 * time.Second); time.Now().Before(end) && !exists(filepath.Join(dir, "child-extra.json")); {
			time.Sleep(20 * time.Millisecond)
		}
		b["reported"] = exists(filepath.Join(dir, "child-extra.json"))
		b["with"] = snap(true)
		procs = append(procs, extra)
	}
	out["B"] = b

	// release, wait for every child
	os.WriteFile(filepath.Join(dir, "release"), nil, 0o644)
	for _, c := range procs {
		c.Wait()
	}
	time.Sleep(200 * time.Millisecond)
	after := snap(true)

	// C: binary search (1 MiB) for the largest single commit that succeeds now
	lo, hi := 0, int(limit)+1 // lo succeeds (0), hi fails
	for hi-lo > 1 {
		mid := (lo + hi) / 2
		if a, err := commit(uintptr(mid) * mib); err == nil {
			windows.VirtualFree(a, 0, windows.MEM_RELEASE)
			lo = mid
		} else {
			hi = mid
		}
	}
	cs := snap(true)
	out["C"] = map[string]any{"afterRelease": after, "largestSingleCommitMiB": lo, "firstRefusedMiB": hi, "snap": cs,
		"jobChargeImpliedMiB": limit - float64(lo), "note": "job charge implied by the boundary = limit - largest successful commit (1 MiB resolution)"}

	// D: refused requests and the peak counter
	d := []any{}
	for _, over := range []int{256, 768} {
		before := snap(false)
		req := int(limit-before.CommitMiB) + over
		_, err := commit(uintptr(req) * mib)
		res := "SUCCEEDED (unexpected)"
		if err != nil {
			res = "refused: " + errno(err)
		}
		afterD := snap(false)
		d = append(d, map[string]any{"requestMiB": req, "committedPlusRequestMiB": before.CommitMiB + float64(req), "result": res,
			"before": before, "after": afterD})
	}
	out["D"] = d
	out["hostEnd"] = host()
	writeJSON(filepath.Join(dir, "results.json"), out)
	fmt.Println("jobprobe done: results.json written")
}
