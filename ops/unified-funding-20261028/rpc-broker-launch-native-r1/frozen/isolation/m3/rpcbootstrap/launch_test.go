//go:build linux && amd64

package rpcbootstrap

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcservice"
	"enclave.host/isolation/m3/rpcstorage"
)

func launchFixture(t *testing.T, left time.Duration) (*Identity, *os.File, []byte, []byte) {
	t.Helper()
	m := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("1", 64), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}}
	bundle, e := contract.Build(m, []byte{0, 97, 115, 109, 13, 0, 1, 0})
	if e != nil {
		t.Fatal(e)
	}
	now, e := rpcservice.MonotonicNow()
	if e != nil || now < uint64(rpcservice.StartupWindow) {
		t.Fatal("clock", e)
	}
	origin := now - uint64(rpcservice.StartupWindow) + uint64(left)
	clock, e := rpcservice.NewEntryContract(origin)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { clock.Close() })
	req, e := rpcstorage.NewRequest(bundle, origin)
	if e != nil {
		t.Fatal(e)
	}
	rt := contract.RuntimeIdentity{Name: "wasmtime", Version: "49.0.3", Execution: contract.ExecJIT, TargetISA: contract.ISAx86_64, HostISA: contract.ISAx86_64, CPUFeatures: "baseline", WX: contract.WXEnforced, Cache: contract.CacheNone}
	i, e := New(req, rt)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(i.Close)
	rid, _ := contract.RuntimeID(rt)
	sum := sha256.Sum256(bundle)
	// Synthetic policy never goes to chain, owner service, exporter or roots.
	policy, _ := json.Marshal(map[string]any{"schema": "enclave-rpc-broker-policy/1", "runtime": hex.EncodeToString(rid[:]), "bundleSha256": hex.EncodeToString(sum[:]), "manifest": []byte("{}"), "chainId": uint64(8453), "ledger": "0x" + strings.Repeat("1", 40), "rpcs": []string{"https://invalid.example"}, "confirmations": uint64(1), "maxAgeSeconds": uint64(60)})
	return i, clock, bundle, policy
}
func TestBrokerLaunchPolicyAndConsumedFailure(t *testing.T) {
	i, clock, bundle, raw := launchFixture(t, time.Second)
	p, _ := i.Public()
	if _, e := i.StartBroker(p.Request.Boot, p.RequestSHA256, clock, bundle); e == nil {
		t.Fatal("unreported launch")
	}
	if e := boundPolicy(raw, p, bundle); e != nil {
		t.Fatal(e)
	}
	for _, field := range []string{"runtime", "bundleSha256", "schema", "maxAgeSeconds", "manifest", "extra"} {
		var v map[string]any
		json.Unmarshal(raw, &v)
		switch field {
		case "maxAgeSeconds":
			v[field] = 0
		case "manifest":
			v[field] = ""
		default:
			v[field] = "wrong"
		}
		bad, _ := json.Marshal(v)
		if e := boundPolicy(bad, p, bundle); e == nil {
			t.Fatal(field)
		}
	}
	duplicate := append([]byte(`{"runtime":"bad",`), raw[1:]...)
	if e := boundPolicy(duplicate, p, bundle); e == nil {
		t.Fatal("duplicate")
	}
	report(t, i)
	// Missing fixed local owner namespace must poison and wake, not unlock/retry.
	if _, e := os.Lstat("/run/native-rpc-owner"); !os.IsNotExist(e) {
		t.Fatal("fixture namespace exists", e)
	}
	if _, e := i.StartBroker(p.Request.Boot, p.RequestSHA256, clock, bundle); e == nil {
		t.Fatal("missing inputs")
	}
	if e := i.Wait(); e == nil {
		t.Fatal("failed launch released acquisition")
	}
	if _, e := i.StartBroker(p.Request.Boot, p.RequestSHA256, clock, bundle); e == nil {
		t.Fatal("retried failed launch")
	}
	if _, e := i.TakeCredential(); e == nil {
		t.Fatal("failed attempt key available")
	}
}
func TestBrokerReadinessRejectsIdentityAndDelay(t *testing.T) {
	i, _, _, _ := launchFixture(t, time.Second)
	p, _ := i.Public()
	fd, _, eno := syscall.Syscall(434, uintptr(os.Getpid()), 0, 0)
	if eno != 0 {
		t.Fatal(eno)
	}
	self := os.NewFile(fd, "self-pidfd")
	defer self.Close()
	for _, mode := range []string{"wrong", "oversized", "blocked"} {
		t.Run(mode, func(t *testing.T) {
			r, w, e := os.Pipe()
			if e != nil {
				t.Fatal(e)
			}
			defer r.Close()
			defer w.Close()
			if mode == "wrong" {
				w.Write([]byte("{}\n"))
				w.Close()
			}
			if mode == "oversized" {
				w.Write(bytes.Repeat([]byte("x"), 1025))
				w.Close()
			}
			ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
			defer cancel()
			e = readListening(ctx, r, &Broker{pid: os.Getpid(), pidfd: self}, p)
			if e == nil {
				t.Fatal("accepted", mode)
			}
			if mode == "blocked" && !errors.Is(e, context.DeadlineExceeded) {
				t.Fatal("deadline", e)
			}
			if mode == "wrong" && !strings.Contains(e.Error(), "identity/clock") {
				t.Fatal(e)
			}
			if mode == "oversized" && !strings.Contains(e.Error(), "oversized") {
				t.Fatal(e)
			}
		})
	}
}

// Executes the release broker binary inside a real delegated cgroup at clone.
// Requires a disposable user/PID/mount/network namespace and external bounded
// systemd delegation. No fake cgroup files, broker stub, chain or owner service.
func TestLaunchActualBroker(t *testing.T) {
	parentPath := os.Getenv("RPC_LAUNCH_TEST_CGROUP")
	mode := os.Getenv("RPC_LAUNCH_TEST_CASE")
	var fs syscall.Statfs_t
	uid, e := os.ReadFile("/proc/self/uid_map")
	if parentPath == "" || e != nil || strings.Contains(string(uid), "4294967295") || syscall.Statfs("/run", &fs) != nil || fs.Type != 0x01021994 || (mode != "normal" && mode != "deadline") {
		t.Fatal("explicit isolated actual-cgroup fixture required")
	}
	left := 5 * time.Second
	if mode == "deadline" {
		left = 500 * time.Millisecond
	}
	i, clock, bundle, policy := launchFixture(t, left)
	p, _ := i.Public()
	report(t, i)
	if e = i.beginLaunch(p.Request.Boot, p.RequestSHA256); e != nil {
		t.Fatal(e)
	}
	parent, e := os.Open(parentPath)
	if e != nil {
		t.Fatal(e)
	}
	defer parent.Close()
	fds, e := syscall.Socketpair(syscall.AF_UNIX, syscall.SOCK_STREAM|syscall.SOCK_CLOEXEC, 0)
	if e != nil {
		t.Fatal(e)
	}
	relay := os.NewFile(uintptr(fds[0]), "relay")
	defer relay.Close()
	defer syscall.Close(fds[1])
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	b, e := i.launch(ctx, clock, bundle, policy, p.Certificate, relay, parent)
	if b != nil {
		defer b.Stop()
	}
	if e != nil {
		t.Fatal("actual broker launch", e)
	}
	if e = rpcservice.VerifyBrokerGroup(b.group, b.pid); e != nil {
		t.Fatal(e)
	}
	if b.LocalDead() {
		t.Fatal("dead at readiness")
	}
	cert, e := os.ReadFile("/run/native-rpc-broker-inputs/client.pem")
	if e != nil {
		t.Fatal(e)
	}
	key, e := os.ReadFile("/run/native-rpc-broker-inputs/client-key.pem")
	if e != nil {
		t.Fatal(e)
	}
	pair, e := tls.X509KeyPair(cert, key)
	clear(key)
	if e != nil || !bytes.Equal(pair.Certificate[0], p.Certificate) {
		t.Fatal("guest credential substitution", e)
	}
	if _, e = i.TakeCredential(); e == nil {
		t.Fatal("credential reused")
	}
	if e = i.beginLaunch(p.Request.Boot, p.RequestSHA256); e == nil {
		t.Fatal("launch retried")
	}
	start := time.Now()
	if mode == "normal" {
		b.Stop()
	}
	select {
	case <-b.Done():
	case <-time.After(time.Second):
		t.Fatal("exact process did not exit")
	}
	for !b.LocalDead() && time.Since(start) < time.Second {
		time.Sleep(time.Millisecond)
	}
	if !b.LocalDead() {
		t.Fatal("exact group not empty")
	}
	now, _ := rpcservice.MonotonicNow()
	if mode == "deadline" && (now < p.Request.Deadline || now-p.Request.Deadline > uint64(250*time.Millisecond)) {
		t.Fatal("original deadline not preserved")
	}
	if _, e = os.Stat("/run/native-rpc-broker-inputs/launch-intent"); e != nil {
		t.Fatal("intent disappeared")
	}
	if _, e = os.Stat("/run/native-rpc-storage/broker-started"); e != nil {
		t.Fatal("broker namespace disappeared")
	}
	t.Logf("actual broker pid=%d mode=%s localDead=true elapsedAfterReadiness=%s originalDeadlineNs=%d rootsGranted=false", b.pid, mode, time.Since(start), p.Request.Deadline)
}
