package main

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/contract/catalog"
)

func TestExclusiveOfflinePackage(t *testing.T) {
	d := catalog.RPCDerivation{Derivation: catalog.V9, Catalog: catalog.Ref{App: "0x" + strings.Repeat("a", 64)},
		CID: "b" + strings.Repeat("a", 58), RuntimeID: strings.Repeat("b", 64), Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, HTTP: 8000, Ports: contract.RPCPorts(),
		SecretDeployment: "0x" + strings.Repeat("c", 64), ConfigBase64: base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)),
		RPC: contract.RPC{Profile: contract.RPCProfile, ProfileSha256: strings.Repeat("d", 64), L1VolumeID: strings.Repeat("e", 64), BaseVolumeID: strings.Repeat("f", 64)}}
	root := t.TempDir()
	record := filepath.Join(root, "record.json")
	component := filepath.Join(root, "controller.wasm")
	out := filepath.Join(root, "out")
	raw, _ := json.Marshal(d)
	os.WriteFile(record, raw, 0600)
	// Empty component is only a wire-format fixture, never a functional app.
	os.WriteFile(component, []byte{0, 97, 115, 109, 13, 0, 1, 0}, 0600)
	if err := prepare(record, component, out); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(out, "app.bundle"))
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = contract.ParseRPC(b); err != nil {
		t.Fatal(err)
	}
	if _, _, err = contract.Parse(b); err == nil {
		t.Fatal("offline package admitted as production")
	}
	if err = prepare(record, component, out); err == nil {
		t.Fatal("overwrote output")
	}
	after, _ := os.ReadFile(filepath.Join(out, "app.bundle"))
	if string(after) != string(b) {
		t.Fatal("changed consumed output")
	}
	d.Policy.MemMiB = 65536
	raw, _ = json.Marshal(d)
	os.WriteFile(record, raw, 0600)
	bad := filepath.Join(root, "bad")
	if err = prepare(record, component, bad); err == nil {
		t.Fatal("invalid budget accepted")
	}
	if _, err = os.Stat(bad); !os.IsNotExist(err) {
		t.Fatal("invalid request created output")
	}
}
