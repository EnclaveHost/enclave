//go:build linux && amd64

package rpcservice

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m3/rpcplatform"
)

func controllerFixture(t *testing.T) (bundle, wasm, statement, profile []byte) {
	t.Helper()
	digest := func(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
	wasm = []byte{0, 97, 115, 109, 13, 0, 1, 0} // synthetic component; not executable RPC proof
	pin := strings.Repeat("1", 64)
	p := rpcplatform.Profile{ControllerSha256: digest(wasm), EntrySha256: pin, Kernel: rpcplatform.Kernel{BootSha256: pin, ElfSha256: pin, Release: rpcplatform.KernelRelease}, Profile: contract.RPCProfile, Root: rpcplatform.RootVolume{DataBlocks: 262144, HashBytes: 8458240, HashSha256: pin, ImageBytes: 1073741824, ImageSha256: pin, RootHash: pin, Salt: pin}, Schema: rpcplatform.Schema}
	var err error
	profile, err = p.Canonical()
	if err != nil {
		t.Fatal(err)
	}
	m := contract.Manifest{RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: digest(profile), L1VolumeID: strings.Repeat("a", 64), BaseVolumeID: strings.Repeat("b", 64)}, World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}}
	bundle, err = contract.Build(m, wasm)
	if err != nil {
		t.Fatal(err)
	}
	statement = []byte(digest(bundle))
	return
}
func TestControllerLoadedIdentityBeforeLaunch(t *testing.T) {
	b, w, s, p := controllerFixture(t)
	for _, statement := range [][]byte{s, append(append([]byte{}, s...), '\n')} {
		if err := controllerIdentity(b, w, statement, p); err != nil {
			t.Fatal(err)
		}
	}
	for _, bad := range []struct {
		name       string
		b, w, s, p []byte
	}{
		{"missing-bundle", nil, w, s, p}, {"different-component", b, append(append([]byte{}, w...), 1), s, p}, {"wrong-statement", b, w, []byte(strings.Repeat("d", 64)), p}, {"whitespace-statement", b, w, append([]byte(" "), s...), p}, {"wrong-profile", b, w, s, []byte(strings.Replace(string(p), strings.Repeat("1", 64), strings.Repeat("2", 64), 1))},
	} {
		t.Run(bad.name, func(t *testing.T) {
			if controllerIdentity(bad.b, bad.w, bad.s, bad.p) == nil {
				t.Fatal("unbound controller accepted")
			}
		})
	}
}
func TestControllerImmutableFileRefusesWritableOrSymlink(t *testing.T) {
	p := t.TempDir() + "/component"
	if err := os.WriteFile(p, []byte("x"), 0444); err != nil {
		t.Fatal(err)
	}
	if _, err := immutableFile(p, 8); err == nil {
		t.Fatal("writable mount accepted")
	}
	if err := os.Symlink(p, p+".link"); err != nil {
		t.Fatal(err)
	}
	if _, err := immutableFile(p+".link", 8); err == nil {
		t.Fatal("symlink accepted")
	}
}
func TestControllerCommandHasNoFilesystemDNSOrAmbientEnv(t *testing.T) {
	c := roleCommand(roleController, 23)
	want := []string{controllerLoader, "--library-path", controllerRuntimeDir, controllerRuntime, "run", "-S", "cli,tcp=y,udp=n,inherit-network=y,allow-ip-name-lookup=n", "-C", "cache=n,parallel-compilation=n", "-W", "max-memory-size=67108864", controllerWasm}
	if !slices.Equal(c.Args, want) || c.Path != controllerLoader || !slices.Equal(c.Env, cleanEnv()) || c.SysProcAttr.Credential.Uid != 2105 {
		t.Fatal("controller command/role drift", c.Args)
	}
	for _, arg := range c.Args {
		if arg == "--dir" || arg == "--env" || arg == "--allow-precompiled" {
			t.Fatal("unexpected authority", arg)
		}
	}
	var sum uint64 = 128 << 20 // supervisor control within parent
	for _, r := range allRoles {
		sum += roleLimits[r].memory
	}
	if roleLimits[roleController].memory != 256<<20 || sum > parentMemory-(1<<30) {
		t.Fatal("controller lost its limit or leaves less than 1 GiB for future front/guest overhead")
	}
}
func TestControllerStartFailureNeverStartsChains(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	f.startErr[roleController] = errors.New("runtime unavailable")
	st := await(t, runAsync(supervisor(t, f, time.Second, testTiming)))
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, false)
	wantOrder(t, f, roleController)
}
func TestControllerExitKillsChainGroup(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	s := supervisor(t, f, time.Second, testTiming)
	done := runAsync(s)
	eventually(t, "all clients", func() bool { return s.State().ClientsStarted })
	f.exit(roleController, errors.New("controller crash"))
	st := await(t, done)
	wantFinal(t, st, OutcomeFailed, CleanupConfirmed, true)
	if !f.allEmpty() || !strings.Contains(st.Reason, "controller wrapper exited") {
		t.Fatal(st)
	}
}
func TestBlockedControllerLaunchCannotResetDeadline(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	f := &fakeBackend{hook: func(r role) {
		if r == roleController {
			close(entered)
			<-release
		}
	}}
	tm := testTiming
	tm.cleanupBound = 25 * time.Millisecond
	s := supervisor(t, f, 40*time.Millisecond, tm)
	done := runAsync(s)
	<-entered
	st := await(t, done)
	wantFinal(t, st, OutcomeDeadline, CleanupUncertain, false)
	close(release)
	eventually(t, "late controller settled", func() bool { return len(f.order()) == 1 && f.allEmpty() })
	wantOrder(t, f, roleController)
	if s.State() != st {
		t.Fatal("late controller changed terminal state")
	}
}
func TestControllerPopulationPreventsCleanupConfirmation(t *testing.T) {
	f := &fakeBackend{probe: probeReadyAfter(0)}
	f.stuck[roleController] = true
	tm := testTiming
	tm.cleanupBound = 20 * time.Millisecond
	s := supervisor(t, f, time.Second, tm)
	done := runAsync(s)
	eventually(t, "all clients", func() bool { return s.State().ClientsStarted })
	s.Stop()
	st := await(t, done)
	wantFinal(t, st, OutcomeStopped, CleanupUncertain, true)
	if !strings.Contains(st.Reason, "controller") {
		t.Fatal(st)
	}
	f.exit(roleController, nil)
}
func TestEntryOldRoleTopologyFrameRefused(t *testing.T) {
	boot := [16]byte{1}
	b, err := encodeEntry(boot, 100)
	if err != nil {
		t.Fatal(err)
	}
	copy(b[:8], "ERPCONE1")
	if _, _, err = decodeEntry(b, boot, 101); err == nil {
		t.Fatal("old topology frame accepted")
	}
}
