// Disposable exact-kernel KVM acceptance probe. Refuses the host kernel.
package main

import (
	"context"
	"enclave.host/isolation/m3/desktop"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}
func require(ok bool, what string) {
	if !ok {
		panic(what)
	}
}
func child(mode string) {
	require(os.Getuid() == 1000, "child role")
	if mode == "cpu" {
		runtime.GOMAXPROCS(8)
		for i := 0; i < 8; i++ {
			go func() {
				var x uint64
				for {
					x = x*6364136223846793005 + 1
					if x == 0 {
						runtime.Gosched()
					}
				}
			}()
		}
		select {}
	}
	if mode == "idle" {
		for {
			time.Sleep(time.Hour)
		}
	}
	if mode == "memory" {
		b, e := syscall.Mmap(-1, 0, 9<<30, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_PRIVATE|syscall.MAP_ANON)
		must(e)
		for i := 0; i < len(b); i += 4096 {
			b[i] = 1
			if i > 0 && i%(1<<30) == 0 {
				fmt.Printf("RESOURCE_MEMORY_TOUCHED=%d\n", i)
			}
		}
		runtime.KeepAlive(b)
		panic("memory limit did not kill")
	}
	panic("bad child mode")
}
func launch(g *desktop.Group, args ...string) *exec.Cmd {
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.SysProcAttr = &syscall.SysProcAttr{UseCgroupFD: true, CgroupFD: g.FD(), Credential: &syscall.Credential{Uid: 1000, Gid: 1000, NoSetGroups: false}}
	must(cmd.Start())
	return cmd
}
func main() {
	var u syscall.Utsname
	must(syscall.Uname(&u))
	var release []byte
	for _, c := range u.Release {
		if c == 0 {
			break
		}
		release = append(release, byte(c))
	}
	require(string(release) == desktop.KernelRelease, "exact guest kernel required")
	if len(os.Args) == 2 && os.Getuid() == 1000 {
		child(os.Args[1])
		return
	}
	require(os.Getuid() == 0 && os.Getppid() == 1, "root child of guest PID1 required")
	oomCase := len(os.Args) == 2 && os.Args[1] == "--oom"
	_, _, e := syscall.Syscall6(syscall.SYS_PRCTL, 36, 1, 0, 0, 0, 0)
	require(e == 0, "subreaper")
	p, id, err := desktop.ReadInstalled("/plat/native-desktop-profile")
	must(err)
	resources, err := p.OpenMounted("/plat/native-desktop/rootfs", "/run/native-desktop/models")
	must(err)
	defer resources.Close()
	require(resources.RootMountID != resources.ModelMountID, "distinct mount identities")
	bad := p
	bad.Root.RootHash = strings.Repeat("a", 64)
	require(bad.VerifyMounted("/plat/native-desktop/rootfs", "/run/native-desktop/models") != nil, "wrong root refused")
	bad = p
	bad.Models.RootHash = strings.Repeat("a", 64)
	require(bad.VerifyMounted("/plat/native-desktop/rootfs", "/run/native-desktop/models") != nil, "wrong models refused")
	require(p.VerifyMounted("/plat/native-desktop/rootfs/usr", "/run/native-desktop/models") != nil, "subdirectory refused")
	must(os.Mkdir("/run/false-root", 0755))
	must(syscall.Mount("/plat/native-desktop/rootfs/usr", "/run/false-root", "", syscall.MS_BIND, ""))
	must(syscall.Mount("", "/run/false-root", "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV, ""))
	require(p.VerifyMounted("/run/false-root", "/run/native-desktop/models") != nil, "bind-mounted subdirectory refused")
	must(syscall.Unmount("/run/false-root", 0))
	must(os.Mkdir("/run/native-admission", 0700))
	var winner *desktop.Claim
	var lock sync.Mutex
	wins := 0
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, e := desktop.AcquireClaim("/run/native-admission")
			if e == nil {
				lock.Lock()
				winner = c
				wins++
				lock.Unlock()
			}
		}()
	}
	wg.Wait()
	require(wins == 1, "exactly one claim")
	must(os.MkdirAll("/sys/fs/cgroup", 0755))
	must(syscall.Mount("cgroup2", "/sys/fs/cgroup", "cgroup2", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, ""))
	must(os.WriteFile("/sys/fs/cgroup/cgroup.subtree_control", []byte("+cpu +memory +pids"), 0))
	raw, err := os.ReadFile("/proc/meminfo")
	must(err)
	var total uint64
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			_, err = fmt.Sscanf(line, "MemTotal: %d kB", &total)
			must(err)
		}
	}
	must(desktop.CheckCapacity(8192, runtime.NumCPU(), 4, total))
	g, err := desktop.NewGroup("/sys/fs/cgroup", winner, 400, 8192, 4)
	must(err)
	defer g.Close()
	_, err = desktop.NewGroup("/sys/fs/cgroup", winner, 400, 8192, 4)
	require(err != nil, "stale cgroup refused")
	snap, err := g.Snapshot()
	must(err)
	fmt.Println("RESOURCE_LIMITS=" + encode(snap))
	cpu := launch(g, "/resource-probe", "cpu")
	time.Sleep(2500 * time.Millisecond)
	snap, err = g.Snapshot()
	must(err)
	throttled := false
	for _, line := range strings.Split(snap["cpu.stat"], "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == "nr_throttled" {
			n, e := strconv.ParseUint(f[1], 10, 64)
			must(e)
			throttled = n > 0
		}
	}
	require(throttled, "CPU quota throttled")
	if oomCase {
		// Stop only the CPU load; cgroup.kill makes this kernel's group terminal.
		must(cpu.Process.Kill())
		require(cpu.Wait() != nil, "CPU load stopped")
		cpu = launch(g, "/resource-probe", "idle")
		mem := launch(g, "/resource-probe", "memory")
		done := make(chan error, 1)
		go func() { done <- mem.Wait() }()
		select {
		case err = <-done:
			fmt.Printf("RESOURCE_MEMORY_EXIT=%v\n", err)
			require(err != nil, "memory child killed")
		case <-time.After(45 * time.Second):
			events, readErr := os.ReadFile("/sys/fs/cgroup/desktop-" + winner.ID() + "/memory.events")
			fmt.Printf("RESOURCE_MEMORY_TIMEOUT_EVENTS=%s error=%v\n", events, readErr)
			current, readErr := os.ReadFile("/sys/fs/cgroup/desktop-" + winner.ID() + "/memory.current")
			fmt.Printf("RESOURCE_MEMORY_TIMEOUT_CURRENT=%s error=%v\n", current, readErr)
			panic("memory OOM deadline")
		}
		// OOM must actually be recorded by memcg, not merely an arbitrary child exit.
		events, err := os.ReadFile("/sys/fs/cgroup/desktop-" + winner.ID() + "/memory.events")
		must(err)
		fmt.Printf("RESOURCE_MEMORY_EVENTS=%s\n", strings.ReplaceAll(string(events), "\n", ";"))
		oom := false
		for _, line := range strings.Split(string(events), "\n") {
			f := strings.Fields(line)
			if len(f) == 2 && f[0] == "oom_group_kill" && f[1] != "0" {
				oom = true
			}
		}
		require(oom, "group OOM recorded")
		require(cpu.Wait() != nil, "group OOM killed idle sibling")
		cpu = nil
	} else {
		forks := launch(g, "/resource-pids")
		must(forks.Wait())
		empty, err := g.Empty()
		must(err)
		require(!empty, "escaped descendants still counted")
		require(g.Remove() != nil, "populated group cannot be removed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	must(g.Kill(ctx))
	cancel()
	require(g.FD() == -1, "killed group cannot be used for clone")
	if cpu != nil {
		_ = cpu.Wait()
	}
	empty, err := g.Empty()
	must(err)
	require(empty, "all descendants gone")
	for {
		var st syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &st, syscall.WNOHANG, nil)
		if err == syscall.ECHILD || pid == 0 {
			break
		}
		must(err)
	}
	must(g.Remove())
	_, err = desktop.NewGroup("/sys/fs/cgroup", winner, 400, 8192, 4)
	require(err != nil, "same claim cannot create another group after removal")
	must(winner.Close())
	_, err = desktop.AcquireClaim("/run/native-admission")
	require(err != nil, "claim remains consumed after teardown")
	fmt.Println("RESOURCE_ADMISSION_RESULT=" + encode(map[string]any{"passed": true, "profileSha256": id, "rootMountID": resources.RootMountID, "modelMountID": resources.ModelMountID, "atomicClaims": 32, "quotaThrottled": true, "groupOOM": oomCase, "pidsLimited": !oomCase, "escapedDescendantsKilled": !oomCase, "claimStillConsumed": true, "productionAdmission": false, "workerReservation": false}))
}
func encode(v any) string { b, e := json.Marshal(v); must(e); return string(b) }
