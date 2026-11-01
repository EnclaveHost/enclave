package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
)

func TestRPCFrontIdentityGate(t *testing.T) {
	dir := t.TempDir()
	put := func(name string, data []byte) string {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0444); err != nil {
			t.Fatal(err)
		}
		return p
	}
	wasm := []byte{0, 97, 115, 109, 13, 0, 1, 0} // wire fixture only
	man := contract.Manifest{World: contract.WorldCLI, HTTP: 8000, Ports: contract.RPCPorts(), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, RPC: &contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("a", 64), L1VolumeID: strings.Repeat("b", 64), BaseVolumeID: strings.Repeat("c", 64)}, SecretDeployment: "0x" + strings.Repeat("d", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`))}
	bundle, err := contract.Build(man, wasm)
	if err != nil {
		t.Fatal(err)
	}
	sum := contract.AppID(bundle)
	bp, wp, sp := put("app.bundle", bundle), put("app.wasm", wasm), put("app.sha256", []byte(hex.EncodeToString(sum[:])))
	id, _, err := loadedAppIDForBuild(bp, wp, sp)
	if !nativeRPCFront {
		if err == nil {
			t.Fatal("non-RPC front admitted RPC bundle")
		}
		return
	}
	if err != nil || !bytes.Equal(id, sum[:]) {
		t.Fatal("RPC identity differs", id, err)
	}
	ordinary, err := contract.Build(contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}, wasm)
	if err != nil {
		t.Fatal(err)
	}
	oid := contract.AppID(ordinary)
	bad := append([]byte(nil), bundle...)
	bad[len(bad)-1] ^= 1
	for _, c := range []struct{ name, b, w, s string }{
		{"missing-bundle", filepath.Join(dir, "missing"), wp, sp},
		{"missing-component", bp, filepath.Join(dir, "missing"), sp},
		{"missing-statement", bp, wp, filepath.Join(dir, "missing")},
		{"wrong-statement", bp, wp, put("wrong.sha256", []byte(strings.Repeat("f", 64)))},
		{"different-component", bp, put("different.wasm", append(wasm, 0)), sp},
		{"tampered-bundle", put("bad.bundle", bad), wp, sp},
		{"ordinary-bundle", put("ordinary.bundle", ordinary), wp, put("ordinary.sha256", []byte(hex.EncodeToString(oid[:])))},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := loadedAppIDForBuild(c.b, c.w, c.s); err == nil {
				t.Fatal("invalid RPC identity accepted")
			}
		})
	}
	// Same controller, different storage/deployment/profile remains a different
	// app identity. A stale statement must never authorize the changed bundle.
	for _, field := range []string{"l1", "base", "profile", "deployment"} {
		changed := man
		r := *man.RPC
		changed.RPC = &r
		switch field {
		case "l1":
			r.L1VolumeID = strings.Repeat("1", 64)
		case "base":
			r.BaseVolumeID = strings.Repeat("2", 64)
		case "profile":
			r.ProfileSha256 = strings.Repeat("3", 64)
		case "deployment":
			changed.SecretDeployment = "0x" + strings.Repeat("4", 64)
		}
		bb, e := contract.Build(changed, wasm)
		if e != nil {
			t.Fatal(e)
		}
		if _, _, e = loadedAppIDForBuild(put(field+".bundle", bb), wp, sp); e == nil {
			t.Fatal("changed binding accepted old identity", field)
		}
	}
}

// This executes main's actual decision before key creation, rather than only
// testing the parser helper. The child receives no credentials or network.
func TestRPCFrontMainHelper(t *testing.T) {
	if os.Getenv("RPC_FRONT_ID_HELPER") != "1" {
		return
	}
	if !nativeRPCFront {
		os.Exit(99)
	}
	flag.CommandLine = flag.NewFlagSet("front", flag.ExitOnError)
	dir := os.Getenv("RPC_FRONT_ID_DIR")
	os.Args = []string{"front", "-app-wasm", filepath.Join(dir, "missing.wasm"), "-app-bundle", filepath.Join(dir, "missing.bundle"), "-app-sha", filepath.Join(dir, "app.sha256"), "-runtime-identity", filepath.Join(dir, "missing-runtime.json")}
	main()
	os.Exit(98)
}
func TestRPCFrontMainRefusesStatementOnlyFallback(t *testing.T) {
	if !nativeRPCFront {
		t.Skip("dedicated RPC build only")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.sha256"), []byte(strings.Repeat("a", 64)), 0444); err != nil {
		t.Fatal(err)
	}
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-test.run=^TestRPCFrontMainHelper$")
	cmd.Env = []string{"RPC_FRONT_ID_HELPER=1", "RPC_FRONT_ID_DIR=" + dir}
	out, err := cmd.CombinedOutput()
	if err == nil || ctx.Err() != nil || !bytes.Contains(out, []byte("app identity:")) || bytes.Contains(out, []byte("runtime identity:")) {
		t.Fatalf("main bypassed loaded-code identity: %v %s", err, out)
	}
}
