package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
)

func monitorRPCBundle(t *testing.T) []byte {
	t.Helper()
	m := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("1", 64), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}}
	b, e := contract.Build(m, []byte{0, 97, 115, 109, 13, 0, 1, 0})
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func TestRPCFixedLoadContract(t *testing.T) {
	b := monitorRPCBundle(t)
	for _, r := range []request{{}, {CPU: 400, MemMiB: 19456}} {
		if _, e := rpcLoadInput(r, b); e != nil {
			t.Fatal(e)
		}
	}
	for _, r := range []request{{Name: "deadbeef.example"}, {Probe: true}, {CPU: 800}, {MemMiB: 20480}, {MemMiB: 1}} {
		if _, e := rpcLoadInput(r, b); e == nil {
			t.Fatal("host override accepted", r)
		}
	}
	if _, e := rpcLoadInput(request{}, []byte("ordinary wasm")); e == nil {
		t.Fatal("ordinary RPC fallback")
	}
}
func TestRPCCleanupRetainsFilesAndCapabilities(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "retained")
	if e := os.WriteFile(sentinel, []byte("dummy state"), 0600); e != nil {
		t.Fatal(e)
	}
	kill, e := os.CreateTemp(root, "kill-fixture-")
	if e != nil {
		t.Fatal(e)
	}
	defer kill.Close()
	d := &domain{ID: 1, dir: root, rpc: &rpcDomain{kill: kill}, life: contract.NewLifecycle(contract.Ending)}
	m := newMonitor(false, "/plat", "/domains", 40000, 5000)
	m.rpcAttempt = d
	d.release()
	d.release()
	if d.state() != contract.Ending {
		t.Fatal("uncertain cleanup advertised ended", d.state())
	}
	if b, e := os.ReadFile(kill.Name()); e != nil || string(b) != "1" {
		t.Fatal("kill not exactly once", string(b), e)
	}
	if _, e = os.Stat(sentinel); e != nil {
		t.Fatal("state removed", e)
	}
	if _, e = kill.Stat(); e != nil {
		t.Fatal("held control closed", e)
	}
	if m.rpcAttempt != d {
		t.Fatal("attempt forgotten")
	}
	if d.frontPath("front.sock") != filepath.Join(root, "run/front/front.sock") {
		t.Fatal("wrong front endpoint")
	}
	if !strings.HasPrefix(m.scanDomainWX(d), "wx=error:") {
		t.Fatal("unlaunched RPC claimed clean")
	}
}
func TestRPCPIDParsingRefusesPartialScope(t *testing.T) {
	for _, bad := range []string{"1 nope", "0", "-2", "1 1", "01", "+1"} {
		if _, e := parseRPCPIDs(bad); e == nil {
			t.Fatal("accepted", bad)
		}
	}
	if p, e := parseRPCPIDs("3\n1\n"); e != nil || len(p) != 2 || p[0] != 1 || p[1] != 3 {
		t.Fatal(p, e)
	}
	if _, e := rpcPIDs(nil); e == nil {
		t.Fatal("missing group accepted")
	}
	f, e := os.Open(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if _, e = rpcPIDs(f); e == nil {
		t.Fatal("ordinary directory accepted as cgroup")
	}
}
func TestRPCBuildDispatchAndSealedClock(t *testing.T) {
	m := newMonitor(false, "/plat", "/domains", 40000, 5000)
	m.hostPort = 9444
	if e := m.initRPCGuest(); e == nil {
		t.Fatal("missing sealed bootstrap clock accepted")
	}
	now, e := rpcservice.MonotonicNow()
	if e != nil {
		t.Fatal(e)
	}
	clock, e := rpcservice.NewEntryContract(now)
	if e != nil {
		t.Fatal(e)
	}
	defer clock.Close()
	m.rpcClock = clock
	if o, e := rpcservice.OriginalEntryOrigin(clock); e != nil || o != now {
		t.Fatal("origin changed", o, e)
	}
	b := monitorRPCBundle(t)
	if nativeRPCBuild {
		if e = m.initRPCGuest(); e != nil {
			t.Fatal(e)
		}
		// A consumed attempt refuses before touching the fixed broker or native OS.
		m.rpcAttempt = &domain{rpc: &rpcDomain{}}
		if _, e = m.load(bufio.NewReader(bytes.NewReader(b)), request{Size: len(b)}); e == nil || !strings.Contains(e.Error(), "consumed") {
			t.Fatal("RPC dispatch missing", e)
		}
		m.snp = true
		if e = m.initRPCGuest(); e == nil {
			t.Fatal("wrong backend accepted")
		}
	} else {
		if e = m.initRPCGuest(); e == nil {
			t.Fatal("RPC enabled in another build")
		}
		if _, e = m.load(bufio.NewReader(bytes.NewReader(b)), request{Size: len(b)}); e == nil {
			t.Fatal("V9 ordinary/desktop fallback")
		}
	}
}
