//go:build native_desktop

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

// Real monitor + domexec + immutable native graph in a disposable KVM guest.
// No release secret is injected: secretrun must remain waiting. A privileged
// fixture client takes the controller UID to exercise the internal lifecycle;
// that is NOT evidence of the owner-release/authentication or Moonlight path.
func TestNativeGuestKVM(t *testing.T) {
	cmdline, _ := os.ReadFile("/proc/cmdline")
	if os.Geteuid() != 0 || !strings.Contains(string(cmdline), "native.monitor.probe=1") {
		t.Skip("disposable native monitor KVM fixture only")
	}
	m := newMonitor(false, "/plat", "/domains", 40000, 5000)
	m.hostPort = 9444
	m.tier, m.format = contract.TierHyperV, contract.FormatHyperV
	if _, ok := raisePtraceScope("/proc/sys/kernel/yama/ptrace_scope", 2); !ok {
		t.Fatal("Yama hold")
	}
	for _, h := range kernelHolds {
		if line, ok := holdSysctl(h.name, h.path, h.want, h.atLeast, h.refused, os.WriteFile); !ok {
			t.Fatal(line)
		}
	}
	if err := m.initNativeGuest(); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("unix", "/run/monitor.sock")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if err = os.Chmod("/run/monitor.sock", 0666); err != nil {
		t.Fatal(err)
	}
	go m.serveReports(ln)
	artifact, err := os.ReadFile(nativeRootPath + "/usr/local/libexec/kvm-box/shield-desktop.wasm")
	if err != nil {
		t.Fatal(err)
	}
	man := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.DesktopPorts(), Policy: contract.Policy{CPUPercent: 400, MemMiB: 8192, Vcpus: 4},
		Desktop: &contract.Desktop{Profile: contract.DesktopProfile, ProfileSha256: m.native.sha, GPUMilli: 500}, SecretDeployment: "0x" + strings.Repeat("1", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"egress":"public-web"}`))}
	bundle, err := contract.Build(man, artifact)
	if err != nil {
		t.Fatal(err)
	}
	d, err := m.load(bufio.NewReader(bytes.NewReader(bundle)), request{Size: len(bundle)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { m.retire(d, "fixture cleanup") })
	query := func(uid int, action string) (map[string]any, error) {
		out, e := exec.Command("/probe-native-client", strconv.Itoa(d.proc.Pid), strconv.Itoa(uid), action).CombinedOutput()
		if e != nil {
			return nil, fmt.Errorf("native client uid=%d action=%s: %w (%s)", uid, action, e, out)
		}
		var v map[string]any
		e = json.Unmarshal(out, &v)
		return v, e
	}
	until := func(state string, deadline time.Duration) {
		t.Helper()
		end := time.Now().Add(deadline)
		var last error
		nextSnapshot := time.Now().Add(10 * time.Second)
		for time.Now().Before(end) {
			if d.state() != contract.Running {
				t.Fatalf("domain ended before %s", state)
			}
			if strings.Contains(string(cmdline), "native.graphics.probe=1") && time.Now().After(nextSnapshot) {
				pids, _ := os.ReadFile(filepath.Join(d.cgroup, "cgroup.procs"))
				var snapshot []map[string]string
				for _, pid := range strings.Fields(string(pids)) {
					comm, _ := os.ReadFile("/proc/" + pid + "/comm")
					wchan, _ := os.ReadFile("/proc/" + pid + "/wchan")
					snapshot = append(snapshot, map[string]string{"pid": pid, "comm": strings.TrimSpace(string(comm)), "wchan": strings.TrimSpace(string(wchan))})
				}
				encoded, _ := json.Marshal(snapshot)
				fmt.Printf("NATIVE_STARTUP_SNAPSHOT=%s\n", encoded)
				nextSnapshot = time.Now().Add(10 * time.Second)
			}
			v, e := query(5001, "status")
			last = e
			if e == nil && v["status"] == state {
				return
			}
			if e == nil && v["status"] == "failed" {
				t.Fatalf("native supervisor failed: %v", v)
			}
			time.Sleep(100 * time.Millisecond)
		}
		t.Fatalf("native %s deadline: %v", state, last)
	}
	until("stopped", 15*time.Second)
	for _, uid := range []int{1000, 1001, 1002, 1003} {
		if _, err = query(uid, "status"); err == nil {
			t.Fatalf("UID %d bypassed controller network gate", uid)
		}
	}
	if d.seccomp.Load() == nil {
		t.Fatal("controller seccomp statement missing")
	}
	if _, err = query(5001, "start"); err != nil {
		t.Fatal(err)
	}
	until("running", 65*time.Second)
	if wx := m.scanDomainWX(d); !strings.HasPrefix(wx, "wx=clean ") {
		t.Fatal(wx)
	}
	snapshot, err := d.native.group.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot["memory.max"] != "8589934592" || snapshot["cpu.max"] != "400000 100000" || snapshot["pids.max"] != "1024" {
		t.Fatal(snapshot)
	}
	// The native controller itself has not received its secret pipe. Nothing
	// may have replaced the waiting secretrun with an unsealed Wasm execution.
	raw, err := os.ReadFile(filepath.Join(d.cgroup, "cgroup.procs"))
	if err != nil {
		t.Fatal(err)
	}
	waiting := 0
	for _, pid := range strings.Fields(string(raw)) {
		p, _ := strconv.Atoi(pid)
		uid, e := contract.UIDOf(p)
		if e != nil || uid != d.UID {
			continue
		}
		cmd, _ := os.ReadFile("/proc/" + pid + "/cmdline")
		if !bytes.HasPrefix(cmd, []byte("/plat/secretrun\x00")) {
			t.Fatal("unsealed controller executed")
		}
		waiting++
	}
	if waiting != 1 {
		t.Fatalf("expected one waiting controller release reader; got %d", waiting)
	}
	if strings.Contains(string(cmdline), "native.graphics.probe=1") {
		var desktopPID string
		for _, pid := range strings.Fields(string(raw)) {
			p, _ := strconv.Atoi(pid)
			uid, e := contract.UIDOf(p)
			cmd, _ := os.ReadFile("/proc/" + pid + "/cmdline")
			if e == nil && uid == 1000 && bytes.HasPrefix(cmd, []byte("/usr/bin/fluxbox\x00")) {
				if desktopPID != "" {
					t.Fatal("ambiguous desktop session")
				}
				desktopPID = pid
			}
		}
		if desktopPID == "" {
			t.Fatal("no running desktop session")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		probe := exec.CommandContext(ctx, "/probe-native-graphics", desktopPID)
		probe.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: d.native.group.FD()}
		out, err := probe.CombinedOutput()
		if err != nil {
			t.Fatalf("desktop graphics: %v (%s)", err, out)
		}
		var result map[string]any
		if err = json.Unmarshal(out, &result); err != nil || result["passed"] != true {
			t.Fatalf("desktop graphics result: %v (%s)", err, out)
		}
		fmt.Printf("NATIVE_GRAPHICS_RESULT=%s\n", bytes.TrimSpace(out))
	}
	revocation := strings.Contains(string(cmdline), "native.monitor.revoke=1")
	if revocation {
		// The host fixture closes its authenticated worker control transport
		// only after this marker. The lease watcher must retire the live graph.
		fmt.Println("NATIVE_MONITOR_REVOKE_READY")
		end := time.Now().Add(20 * time.Second)
		for d.state() != contract.Ended && time.Now().Before(end) {
			time.Sleep(50 * time.Millisecond)
		}
		// Synchronize with the watcher: release's Once waits for the original
		// cleanup call to finish. No explicit retire may mask a missing watcher.
		if d.state() != contract.Ended {
			t.Fatal("worker revocation did not end the native domain")
		}
		d.release()
	} else {
		if _, err = query(5001, "stop"); err != nil {
			t.Fatal(err)
		}
		until("stopped", 10*time.Second)
		m.retire(d, "fixture completed")
	}
	if d.state() != contract.Ended {
		t.Fatal("native lifecycle not ended")
	}
	if _, err = os.Stat(d.dir); !os.IsNotExist(err) {
		t.Fatal("domain directory not removed", err)
	}
	if _, err = os.Stat(d.cgroup); !os.IsNotExist(err) {
		t.Fatal("cgroup not removed", err)
	}
	if _, err = os.Stat(nativeClaimDir + "/claimed"); err != nil {
		t.Fatal("one-use claim was removed", err)
	}
	if _, err = m.load(bufio.NewReader(bytes.NewReader(bundle)), request{Size: len(bundle)}); err == nil {
		t.Fatal("guest admitted a second native domain")
	}
	if m.noDomains != "" {
		t.Fatal("native cleanup poisoned the guest", m.noDomains)
	}
	fmt.Printf(`NATIVE_MONITOR_RESULT={"workerRevocation":%t,"passed":true,"nativeGraph":true,"secretReleased":false,"controllerExecuted":false,"gpuExecuted":false,"productionRelease":false,"claimSingleUse":true,"cgroupRemoved":true,"domainRemoved":true}`+"\n", revocation)
}
