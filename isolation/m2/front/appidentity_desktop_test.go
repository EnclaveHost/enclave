package main

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

func TestDesktopFrontIdentityGate(t *testing.T) {
	dir := t.TempDir()
	put := func(name string, data []byte) string {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, data, 0444); err != nil {
			t.Fatal(err)
		}
		return p
	}
	wasm := []byte{0, 97, 115, 109, 13, 0, 1, 0}
	bundle, err := contract.Build(contract.Manifest{
		World: contract.WorldCLI, HTTP: 8000, Ports: contract.DesktopPorts(),
		Policy:           contract.Policy{CPUPercent: 400, MemMiB: 8192, Vcpus: 4},
		Desktop:          &contract.Desktop{Profile: contract.DesktopProfile, ProfileSha256: strings.Repeat("a", 64), GPUMilli: 500},
		SecretDeployment: "0x" + strings.Repeat("1", 64),
		ConfigBase64:     base64.StdEncoding.EncodeToString([]byte(`{"egress":"public-web"}`)),
	}, wasm)
	if err != nil {
		t.Fatal(err)
	}
	sum := contract.AppID(bundle)
	bp, wp, sp := put("app.bundle", bundle), put("app.wasm", wasm), put("app.sha256", []byte(hex.EncodeToString(sum[:])))
	id, _, err := loadedAppIDForBuild(bp, wp, sp)
	if !nativeDesktopFront {
		if err == nil {
			t.Fatal("ordinary front admitted desktop format")
		}
		return
	}
	if err != nil || !bytes.Equal(id, sum[:]) {
		t.Fatalf("native identity: %x %v", id, err)
	}
	ordinary, err := contract.Build(contract.Manifest{Policy: contract.Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}, wasm)
	if err != nil {
		t.Fatal(err)
	}
	ordinaryID := contract.AppID(ordinary)
	bad := append([]byte(nil), bundle...)
	bad[len(bad)-1] ^= 1
	for _, c := range []struct{ name, b, w, s string }{
		{"missing bundle", filepath.Join(dir, "missing"), wp, sp},
		{"missing component", bp, filepath.Join(dir, "missing"), sp},
		{"missing statement", bp, wp, filepath.Join(dir, "missing")},
		{"wrong statement", bp, wp, put("wrong.sha256", []byte(strings.Repeat("f", 64)))},
		{"different component", bp, put("different.wasm", append(wasm, 0)), sp},
		{"tampered bundle", put("bad.bundle", bad), wp, sp},
		{"ordinary bundle", put("ordinary.bundle", ordinary), wp, put("ordinary.sha256", []byte(hex.EncodeToString(ordinaryID[:])))},
	} {
		t.Run(c.name, func(t *testing.T) {
			if _, _, err := loadedAppIDForBuild(c.b, c.w, c.s); err == nil {
				t.Fatal("invalid desktop identity accepted")
			}
		})
	}
}
