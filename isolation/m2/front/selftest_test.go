package main

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"

	"enclave.host/isolation/contract"
)

// FRONT_WX_CHILD: this test binary as a stand-in RUNTIME for localSelfTest's test below ("rwx" plants a writable-and-
// executable page, "clean" does not); it says "ready" and waits for stdin to close.
func TestMain(m *testing.M) {
	switch os.Getenv("FRONT_WX_CHILD") {
	case "rwx":
		if _, err := syscall.Mmap(-1, 0, 4096, syscall.PROT_READ|syscall.PROT_WRITE|syscall.PROT_EXEC, syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS); err != nil {
			os.Exit(2)
		}
		fallthrough
	case "clean":
		os.Stdout.WriteString("ready\n")
		bufio.NewReader(os.Stdin).ReadString('\n')
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// wxMonitor is fakeMonitor with the W^X scan the m3 monitor now returns beside the report; set() changes what the NEXT
// request is told, so a test can see whether the front measures per document or reuses an old answer.
type wxMonitor struct {
	mu sync.Mutex
	wx string
}

func (m *wxMonitor) set(wx string) { m.mu.Lock(); m.wx = wx; m.mu.Unlock() }

func startWXMonitor(t *testing.T) (*wxMonitor, string) {
	m := &wxMonitor{}
	p := filepath.Join(t.TempDir(), "monitor.sock")
	l, err := net.Listen("unix", p)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			var req map[string]string
			_ = json.NewDecoder(c).Decode(&req)
			m.mu.Lock()
			out := map[string]string{"report": base64.StdEncoding.EncodeToString([]byte("REPORT")), "format": contract.FormatHyperV, "tier": "T0-hv"}
			if m.wx != "" {
				out["wx"] = m.wx
			}
			m.mu.Unlock()
			_ = json.NewEncoder(c).Encode(out)
			c.Close()
		}
	}()
	return m, p
}

func attestOnce(t *testing.T, f *front) (int, doc, string) {
	t.Helper()
	w := httptest.NewRecorder()
	f.attest(w, httptest.NewRequest(http.MethodGet, "/.well-known/enclave-attestation?nonce="+strings.Repeat("ab", 32), nil))
	var d doc
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &d); err != nil {
			t.Fatal(err)
		}
	}
	return w.Code, d, w.Body.String()
}

// M3: the self-test in each document is the monitor's scan made for THAT request (enclave-b4's finding, enclave-87's
// ruling). A clean scan is carried as it is; a W+X mapping found, or a scan that failed, REFUSES the document; no scan at
// all (an old monitor) says wx=unmeasured, which the judge rejects. A front that measured once at start and reused it
// would serve the second document below clean.
func TestTheSelfTestIsMeasuredAtEachAttestation(t *testing.T) {
	mon, sock := startWXMonitor(t)
	f := &front{spki: []byte("spki"), appSha: make([]byte, 32), monitor: sock,
		rt: &runtimeState{RID: [32]byte{1}, ExecPages: "allowed"}}

	clean := "wx=clean maps=3 runtime=1 front=1 init=1 scope=cgroup:/dom1"
	mon.set(clean)
	code, d, body := attestOnce(t, f)
	if code != http.StatusOK || d.RuntimeSelfTest != "exec_pages=allowed "+clean {
		t.Fatalf("a clean scan: %d %q (%s)", code, d.RuntimeSelfTest, body)
	}

	mon.set("wx=found pid 7 (runtime): 7f0000000000-7f0000001000 rwxp 00000000 00:00 0")
	if code, _, body := attestOnce(t, f); code != http.StatusInternalServerError || !strings.Contains(body, "rwxp") {
		t.Fatalf("a W+X mapping in the runtime was not refused: %d %s", code, body)
	}

	mon.set("wx=error: could not read pid 9's mappings (runtime): permission denied: the scan cannot vouch for it")
	if code, _, body := attestOnce(t, f); code != http.StatusInternalServerError || !strings.Contains(body, "cannot vouch") {
		t.Fatalf("a failed scan was not refused: %d %s", code, body)
	}

	mon.set("")
	code, d, body = attestOnce(t, f)
	if code != http.StatusOK || !strings.Contains(d.RuntimeSelfTest, "wx=unmeasured") {
		t.Fatalf("no scan from the monitor: %d %q (%s)", code, d.RuntimeSelfTest, body)
	}
}

// The SNP/M2 path, where the front (root) measures itself: a runtime (the app, on its own uid) with a W+X mapping
// PLANTED is FOUND and refuses the document; a clean one is counted as runtime=1 beside root=1 (this process, standing in
// for the front and init). It needs a process table of its own, so the test re-runs itself as pid 1 of a new pid and user
// namespace (unshare --map-auto: root inside, and uid 1000 mapped for the runtime) with a fresh /proc.
func TestLocalSelfTestSeesTheRuntime(t *testing.T) {
	if os.Getenv("FRONT_WX_INNER") == "" {
		if exec.Command("unshare", "--map-root-user", "--map-auto", "-U", "true").Run() != nil {
			t.Skip("no unshare --map-auto here")
		}
		cmd := exec.Command("unshare", "--map-root-user", "--map-auto", "-pf", "--mount-proc", os.Args[0], "-test.run=^TestLocalSelfTestSeesTheRuntime$", "-test.v")
		cmd.Env = append(os.Environ(), "FRONT_WX_INNER=1")
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.Contains(string(out), "--- PASS: TestLocalSelfTestSeesTheRuntime") {
			t.Fatalf("inside the namespace: %v\n%s", err, out)
		}
		for _, l := range strings.Split(string(out), "\n") {
			if strings.Contains(l, "selftest_test.go") {
				t.Log(strings.TrimSpace(l))
			}
		}
		return
	}
	// the go-build directory is 0700, which the runtime's uid cannot enter: run it from a copy it can
	dir, err := os.MkdirTemp("", "front-wx-") // not t.TempDir: its parent directory is 0700
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	bin, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	self := filepath.Join(dir, "front.test")
	if err := os.WriteFile(self, bin, 0o755); err != nil || os.Chmod(dir, 0o755) != nil {
		t.Fatal(err)
	}
	run := func(kind string) {
		cmd := exec.Command(self, "-test.run=^$")
		cmd.Env = append(os.Environ(), "FRONT_WX_CHILD="+kind, "FRONT_WX_INNER=")
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 1000, Gid: 1000}}
		in, _ := cmd.StdinPipe()
		out, _ := cmd.StdoutPipe()
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { in.Close(); cmd.Wait() }()
		if line, _ := bufio.NewReader(out).ReadString('\n'); line != "ready\n" {
			t.Fatalf("the %s runtime did not start: %q", kind, line)
		}
		st, err := localSelfTest("allowed")
		switch kind {
		case "clean":
			if err != nil || !strings.HasPrefix(st, "exec_pages=allowed wx=clean maps=2 runtime=1 root=1 scope=") {
				t.Fatalf("a clean runtime: %q %v", st, err)
			}
			t.Logf("clean: %s", st)
		case "rwx":
			if err == nil || !strings.Contains(err.Error(), "(runtime)") || !strings.Contains(err.Error(), "rwxp") {
				t.Fatalf("a W+X mapping planted in the runtime was not found: %q %v", st, err)
			}
			t.Logf("planted: %v", err)
		}
	}
	run("clean")
	run("rwx")
}
