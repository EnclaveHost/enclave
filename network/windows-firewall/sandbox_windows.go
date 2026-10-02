//go:build windows

package main

// Start suspended in an AppContainer, verify its token and persistent firewall,
// then resume under a kill-on-close job. Only this circuit's folder is granted.
import (
	"encoding/json"
	"fmt"
	"github.com/tailscale/wf"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"unsafe"
)

type SandboxConfig struct {
	Directory  string   `json:"directory"`
	Executable string   `json:"executable"`
	Args       []string `json:"args"`
}
type securityCapabilities struct {
	SID          *windows.SID
	Capabilities *windows.SIDAndAttributes
	Count        uint32
	Reserved     uint32
}

func wide(s string) *uint16 { p, e := windows.UTF16PtrFromString(s); check(e); return p }
func appProfile(name string) *windows.SID {
	var sid *windows.SID
	dll := windows.NewLazySystemDLL("userenv.dll")
	p := wide(name)
	hr, _, _ := dll.NewProc("CreateAppContainerProfile").Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(p)), 0, 0, uintptr(unsafe.Pointer(&sid)))
	if uint32(hr) == 0x800700b7 {
		hr, _, _ = dll.NewProc("DeriveAppContainerSidFromAppContainerName").Call(uintptr(unsafe.Pointer(p)), uintptr(unsafe.Pointer(&sid)))
	}
	if uint32(hr) != 0 {
		panic(fmt.Sprintf("AppContainer profile HRESULT %08x", uint32(hr)))
	}
	return sid
}
func grantCircuit(dir string, sid *windows.SID) {
	token := windows.GetCurrentProcessToken()
	user, e := token.GetTokenUser()
	check(e)
	sddl := "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;" + user.User.Sid.String() + ")(A;OICI;GRGX;;;" + sid.String() + ")"
	sd, e := windows.SecurityDescriptorFromString(sddl)
	check(e)
	acl, _, e := sd.DACL()
	check(e)
	check(windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil))
	runtime.KeepAlive(sd)
	scratch := filepath.Join(dir, "state")
	check(os.MkdirAll(scratch, 0700))
	sd, e = windows.SecurityDescriptorFromString(strings.Replace(sddl, "GRGX;;;", "FA;;;", 1) + "S:(ML;OICI;NW;;;LW)")
	check(e)
	acl, _, e = sd.DACL()
	check(e)
	sacl, _, e := sd.SACL()
	check(e)
	check(windows.SetNamedSecurityInfo(scratch, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION|windows.LABEL_SECURITY_INFORMATION, nil, nil, acl, sacl))
	runtime.KeepAlive(sd)
}
func verifyFirewall(dir, executable string) string {
	b, e := os.ReadFile(filepath.Join(dir, "firewall.json"))
	check(e)
	var m Manifest
	check(json.Unmarshal(b, &m))
	if m.State != "active" || !strings.HasPrefix(m.AppContainerSID, "S-1-15-2-") {
		panic("active persistent circuit firewall required")
	}
	found := false
	for _, p := range m.Programs {
		if strings.EqualFold(filepath.Clean(p), executable) {
			found = true
		}
	}
	if !found {
		panic("worker executable has no firewall policy")
	}
	session, e := wf.New(&wf.Options{Name: "Enclave circuit verification"})
	check(e)
	defer session.Close()
	rules, e := session.Rules()
	check(e)
	installed := map[string]bool{}
	for _, r := range rules {
		if r.Sublayer.String() == m.Sublayer && r.Persistent && !r.Disabled {
			installed[r.ID.String()] = true
		}
	}
	if len(m.Rules) < 4 {
		panic("circuit firewall incomplete")
	}
	for _, id := range m.Rules {
		if !installed[id] {
			panic("circuit firewall missing rule")
		}
	}
	return m.AppContainerSID
}
func sandbox(file string) {
	b, e := os.ReadFile(file)
	check(e)
	var cfg SandboxConfig
	check(json.Unmarshal(b, &cfg))
	dir := filepath.Clean(cfg.Directory)
	exe := filepath.Clean(cfg.Executable)
	if !filepath.IsAbs(dir) || !regexp.MustCompile(`^enclave-circuit-[a-f0-9]{32}$`).MatchString(filepath.Base(dir)) || !strings.EqualFold(filepath.Dir(exe), dir) || !strings.EqualFold(filepath.Ext(exe), ".exe") || len(cfg.Args) > 32 {
		panic("dedicated circuit executable required")
	}
	info, e := os.Lstat(exe)
	check(e)
	if !info.Mode().IsRegular() {
		panic("regular private executable required")
	}
	policySID := verifyFirewall(dir, exe)
	profile := "Enclave.Circuit." + strings.TrimPrefix(filepath.Base(dir), "enclave-circuit-")
	sid := appProfile(profile)
	if sid.String() != policySID {
		panic("AppContainer firewall identity mismatch")
	}
	defer windows.FreeSid(sid)
	grantCircuit(dir, sid)
	check(exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "CheckNetIsolation.exe"), "LoopbackExempt", "-a", "-p="+sid.String()).Run())
	// No network or other capability is granted. Loopback has an explicit
	// exemption and is still constrained by package-wide WFP filters.
	capabilities := securityCapabilities{SID: sid}
	attrs, e := windows.NewProcThreadAttributeList(2)
	check(e)
	defer attrs.Delete()
	check(attrs.Update(0x20009, unsafe.Pointer(&capabilities), unsafe.Sizeof(capabilities)))
	handles := make([]windows.Handle, 3)
	originals := []windows.Handle{windows.Handle(os.Stdin.Fd()), windows.Handle(os.Stdout.Fd()), windows.Handle(os.Stderr.Fd())}
	for i, h := range originals {
		check(windows.DuplicateHandle(windows.CurrentProcess(), h, windows.CurrentProcess(), &handles[i], 0, true, windows.DUPLICATE_SAME_ACCESS))
		defer windows.CloseHandle(handles[i])
	}
	check(attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST, unsafe.Pointer(&handles[0]), uintptr(len(handles))*unsafe.Sizeof(handles[0])))
	si := windows.StartupInfoEx{}
	si.Cb = uint32(unsafe.Sizeof(si))
	si.ProcThreadAttributeList = attrs.List()
	desktop, closeDesktop := privateDesktop(fmt.Sprintf("%s.%d", profile, os.Getpid()), sid)
	defer closeDesktop()
	si.Desktop = wide(desktop)
	si.Flags = windows.STARTF_USESTDHANDLES
	si.StdInput = handles[0]
	si.StdOutput = handles[1]
	si.StdErr = handles[2]
	args := append([]string{exe}, cfg.Args...)
	for i := range args {
		args[i] = windows.EscapeArg(args[i])
	}
	env := []string{"TEMP=" + filepath.Join(dir, "state"), "TMP=" + filepath.Join(dir, "state"), "PATH=" + filepath.Join(os.Getenv("SystemRoot"), "System32")}
	for _, key := range []string{"SystemRoot", "SystemDrive", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH", "USERNAME", "USERDOMAIN", "COMPUTERNAME"} {
		if value := os.Getenv(key); value != "" {
			env = append(env, key+"="+value)
		}
	}
	sort.Slice(env, func(i, j int) bool { return strings.ToUpper(env[i]) < strings.ToUpper(env[j]) })
	env16 := []uint16{}
	for _, v := range env {
		x, e := windows.UTF16FromString(v)
		check(e)
		env16 = append(env16, x...)
	}
	env16 = append(env16, 0)
	var pi windows.ProcessInformation
	check(windows.CreateProcess(wide(exe), wide(strings.Join(args, " ")), nil, nil, true, windows.EXTENDED_STARTUPINFO_PRESENT|windows.CREATE_SUSPENDED|windows.CREATE_NO_WINDOW|windows.CREATE_UNICODE_ENVIRONMENT, &env16[0], wide(dir), &si.StartupInfo, &pi))
	defer windows.CloseHandle(pi.Process)
	defer windows.CloseHandle(pi.Thread)
	resumed := false
	defer func() {
		if !resumed {
			_ = windows.TerminateProcess(pi.Process, 1)
		}
	}()
	var token windows.Token
	check(windows.OpenProcessToken(pi.Process, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES, &token))
	defer token.Close()
	var isContainer uint32
	var length uint32
	check(windows.GetTokenInformation(token, 29, (*byte)(unsafe.Pointer(&isContainer)), 4, &length))
	if isContainer != 1 {
		panic("worker is not an AppContainer")
	}
	tokenSID := make([]byte, 1024)
	check(windows.GetTokenInformation(token, 31, &tokenSID[0], uint32(len(tokenSID)), &length))
	actualSID := *(**windows.SID)(unsafe.Pointer(&tokenSID[0]))
	if !actualSID.Equals(sid) {
		panic("worker AppContainer identity mismatch")
	}
	capabilityInfo := make([]byte, 1024)
	check(windows.GetTokenInformation(token, 30, &capabilityInfo[0], uint32(len(capabilityInfo)), &length))
	if (*windows.Tokengroups)(unsafe.Pointer(&capabilityInfo[0])).GroupCount != 0 {
		panic("worker retained capabilities")
	}
	privs := make([]byte, 4096)
	check(windows.GetTokenInformation(token, windows.TokenPrivileges, &privs[0], uint32(len(privs)), &length))
	var notify windows.LUID
	check(windows.LookupPrivilegeValue(nil, wide("SeChangeNotifyPrivilege"), &notify))
	all := (*windows.Tokenprivileges)(unsafe.Pointer(&privs[0]))
	for i, p := range all.AllPrivileges() {
		if p.Luid != notify {
			all.AllPrivileges()[i].Attributes = windows.SE_PRIVILEGE_REMOVED
		}
	}
	check(windows.AdjustTokenPrivileges(token, false, all, 0, nil, nil))
	check(windows.GetTokenInformation(token, windows.TokenPrivileges, &privs[0], uint32(len(privs)), &length))
	for _, p := range (*windows.Tokenprivileges)(unsafe.Pointer(&privs[0])).AllPrivileges() {
		if p.Luid != notify {
			panic("worker retained service privilege")
		}
	}
	integrity := make([]byte, 1024)
	check(windows.GetTokenInformation(token, windows.TokenIntegrityLevel, &integrity[0], uint32(len(integrity)), &length))
	label := (*windows.SIDAndAttributes)(unsafe.Pointer(&integrity[0]))
	if label.Sid.String() != "S-1-16-4096" {
		panic("worker is not low integrity")
	}
	job, e := windows.CreateJobObject(nil, nil)
	check(e)
	defer windows.CloseHandle(job)
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_ACTIVE_PROCESS | windows.JOB_OBJECT_LIMIT_PROCESS_MEMORY
	limits.BasicLimitInformation.ActiveProcessLimit = 8
	limits.ProcessMemoryLimit = 512 << 20
	_, e = windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits)))
	check(e)
	check(windows.AssignProcessToJobObject(job, pi.Process))
	fmt.Fprintf(os.Stderr, "AppContainer verified: %s, PID %d\n", sid.String(), pi.ProcessId)
	_, e = windows.ResumeThread(pi.Thread)
	check(e)
	resumed = true
	_, e = windows.WaitForSingleObject(pi.Process, windows.INFINITE)
	check(e)
	var code uint32
	check(windows.GetExitCodeProcess(pi.Process, &code))
	runtime.KeepAlive(capabilities)
	runtime.KeepAlive(env16)
	if code != 0 {
		panic(fmt.Sprintf("sandboxed worker exited %d", code))
	}
}

// A service logon's inherited desktop rejects the restricted token during DLL
// initialization. Create a private desktop instead of granting access to the
// user's desktop or to other services' window stations.
func privateDesktop(profile string, sid *windows.SID) (string, func()) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	user, e := windows.GetCurrentProcessToken().GetTokenUser()
	check(e)
	sd, e := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;" + user.User.Sid.String() + ")(A;;GA;;;" + sid.String() + ")S:(ML;;NW;;;LW)")
	check(e)
	sa := windows.SecurityAttributes{SecurityDescriptor: sd}
	sa.Length = uint32(unsafe.Sizeof(sa))
	user32 := windows.NewLazySystemDLL("user32.dll")
	old, _, e := user32.NewProc("GetProcessWindowStation").Call()
	if old == 0 {
		check(e)
	}
	station, _, e := user32.NewProc("CreateWindowStationW").Call(uintptr(unsafe.Pointer(wide(profile))), 1, 0x10000000, uintptr(unsafe.Pointer(&sa)))
	if station == 0 {
		check(e)
	}
	ok, _, e := user32.NewProc("SetProcessWindowStation").Call(station)
	if ok == 0 {
		user32.NewProc("CloseWindowStation").Call(station)
		check(e)
	}
	desk, _, e := user32.NewProc("CreateDesktopW").Call(uintptr(unsafe.Pointer(wide("Worker"))), 0, 0, 0, 0x10000000, uintptr(unsafe.Pointer(&sa)))
	user32.NewProc("SetProcessWindowStation").Call(old)
	if desk == 0 {
		user32.NewProc("CloseWindowStation").Call(station)
		check(e)
	}
	runtime.KeepAlive(sd)
	return profile + `\Worker`, func() { user32.NewProc("CloseDesktop").Call(desk); user32.NewProc("CloseWindowStation").Call(station) }
}
