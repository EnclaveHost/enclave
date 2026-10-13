//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"github.com/tailscale/wf"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"unsafe"
)

func noCircuitProcesses(programs []string) {
	wanted := map[string]bool{}
	names := map[string]bool{}
	for _, p := range programs {
		wanted[strings.ToLower(filepath.Clean(p))] = true
		names[strings.ToLower(filepath.Base(p))] = true
	}
	snap, e := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	check(e)
	defer windows.CloseHandle(snap)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	e = windows.Process32First(snap, &entry)
	for e == nil {
		if names[strings.ToLower(windows.UTF16ToString(entry.ExeFile[:]))] {
			h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
			if err == nil {
				buf := make([]uint16, 32768)
				n := uint32(len(buf))
				err = windows.QueryFullProcessImageName(h, 0, &buf[0], &n)
				windows.CloseHandle(h)
				check(err)
				if wanted[strings.ToLower(filepath.Clean(windows.UTF16ToString(buf[:n])))] {
					panic("stop circuit processes before removing its firewall")
				}
			} else {
				panic("could not verify matching process has stopped")
			}
		}
		e = windows.Process32Next(snap, &entry)
	}
	if e != windows.ERROR_NO_MORE_FILES {
		check(e)
	}
}
func removeCircuit(file string) {
	dir := filepath.Dir(filepath.Clean(file))
	if !filepath.IsAbs(file) || filepath.Base(file) != "firewall.json" || !strings.HasPrefix(filepath.Base(dir), "enclave-circuit-") {
		panic("exact private circuit manifest required")
	}
	b, e := os.ReadFile(file)
	check(e)
	var m Manifest
	check(json.Unmarshal(b, &m))
	if m.State == "removed" {
		fmt.Println(`{"type":"removed"}`)
		return
	}
	if len(m.Programs) < 1 || len(m.Programs) > 4 {
		panic("invalid circuit manifest")
	}
	for _, p := range m.Programs {
		if !strings.EqualFold(filepath.Dir(filepath.Clean(p)), dir) {
			panic("manifest names another directory")
		}
	}
	noCircuitProcesses(m.Programs)
	g, e := windows.GUIDFromString(m.Sublayer)
	check(e)
	layer := wf.SublayerID(g)
	session, e := wf.New(&wf.Options{Name: "Enclave circuit cleanup"})
	check(e)
	defer session.Close()
	layers, e := session.Sublayers()
	check(e)
	for _, l := range layers {
		if l.ID == layer && !strings.EqualFold(l.Name, "Enclave circuit "+filepath.Base(dir)) {
			panic("sublayer is not owned by this circuit")
		}
	}
	rules, e := session.Rules()
	check(e)
	wanted := map[string]bool{}
	for _, id := range m.Rules {
		wanted[id] = true
	}
	for _, r := range rules {
		if r.Sublayer == layer {
			if !wanted[r.ID.String()] || r.Name != "Enclave circuit policy" {
				panic("unexpected rule in circuit sublayer")
			}
		}
	}
	m.State = "removing"
	b, e = json.Marshal(m)
	check(e)
	check(os.WriteFile(file, b, 0600))
	for _, r := range rules {
		if r.Sublayer == layer {
			check(session.DeleteRule(r.ID))
		}
	}
	for _, l := range layers {
		if l.ID == layer {
			check(session.DeleteSublayer(layer))
		}
	}
	if m.AppContainerSID != "" {
		if !strings.HasPrefix(m.AppContainerSID, "S-1-15-2-") {
			panic("invalid package identity")
		}
		check(exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "CheckNetIsolation.exe"), "LoopbackExempt", "-d", "-p="+m.AppContainerSID).Run())
		profile := "Enclave.Circuit." + strings.TrimPrefix(filepath.Base(dir), "enclave-circuit-")
		hr, _, _ := windows.NewLazySystemDLL("userenv.dll").NewProc("DeleteAppContainerProfile").Call(uintptr(unsafe.Pointer(wide(profile))))
		if uint32(hr) != 0 {
			panic(fmt.Sprintf("profile removal HRESULT %08x", uint32(hr)))
		}
	}
	m.State = "removed"
	b, e = json.Marshal(m)
	check(e)
	check(os.WriteFile(file, b, 0600))
	fmt.Println(`{"type":"removed"}`)
}
