package catalog

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

func rpcRecord() RPCDerivation {
	return RPCDerivation{Derivation: V9, Catalog: Ref{App: "0x" + strings.Repeat("a", 64), Version: 0},
		CID: "b" + strings.Repeat("a", 58), RuntimeID: strings.Repeat("b", 64),
		Policy: contract.Policy{CPUPercent: 400, MemMiB: 19456, Vcpus: 4}, HTTP: 8000, Ports: contract.RPCPorts(),
		ConfigBase64:     base64.StdEncoding.EncodeToString([]byte(`{"baseChainId":8453,"ethereumChainId":1,"schema":"enclave-rpc-app/1","startupSeconds":900}`)),
		SecretDeployment: "0x" + strings.Repeat("c", 64), RPC: contract.RPC{Profile: contract.RPCProfile,
			ProfileSha256: strings.Repeat("d", 64), L1VolumeID: strings.Repeat("e", 64), BaseVolumeID: strings.Repeat("f", 64)}}
}

func TestRPCMappingAndAdmissionSeparation(t *testing.T) {
	d := rpcRecord()
	raw, _ := contract.Canonical(d)
	parsed, err := ParseRPCRecord(raw)
	if err != nil {
		t.Fatal(err)
	}
	m, b, err := MapRPC(parsed, componentPreamble)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = contract.ParseRPC(b); err != nil {
		t.Fatal(err)
	}
	if _, _, err = contract.Parse(b); err == nil {
		t.Fatal("ordinary guest admitted native RPC")
	}
	if _, _, err = contract.ParseDesktop(b); err == nil {
		t.Fatal("desktop guest admitted native RPC")
	}
	if m.BundleBytes != len(b) || m.Record.Policy.MemMiB != 19456 {
		t.Fatal("mapping lost budget")
	}
	for _, change := range []func(*RPCDerivation){
		func(d *RPCDerivation) { d.RPC.ProfileSha256 = strings.Repeat("1", 64) },
		func(d *RPCDerivation) { d.RPC.L1VolumeID = strings.Repeat("2", 64) },
		func(d *RPCDerivation) { d.RPC.BaseVolumeID = strings.Repeat("3", 64) },
		func(d *RPCDerivation) { d.SecretDeployment = "0x" + strings.Repeat("4", 64) },
	} {
		other := rpcRecord()
		change(&other)
		got, _, e := MapRPC(other, componentPreamble)
		if e != nil || got.AppID == m.AppID {
			t.Fatal("mutable identity binding", e)
		}
	}
	// The returned record owns its slice; a caller cannot change pinned ports.
	parsed.Ports[0] = "tcp:18651"
	if m.Record.Ports[0] != "tcp:30303" {
		t.Fatal("aliased ports")
	}
	legacy, err := contract.Build(contract.Manifest{World: contract.WorldHTTP, Policy: contract.Policy{CPUPercent: 100, MemMiB: 256, Vcpus: 1}}, componentPreamble)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = contract.Parse(legacy); err != nil {
		t.Fatal("legacy changed", err)
	}
	if _, _, err = contract.ParseRPC(legacy); err == nil {
		t.Fatal("legacy relabelled RPC")
	}
}

func TestRPCRefusesUnsafeRequests(t *testing.T) {
	for name, change := range map[string]func(*RPCDerivation){
		"desktop version":   func(d *RPCDerivation) { d.Derivation = V8 },
		"zero catalog":      func(d *RPCDerivation) { d.Catalog.App = "0x" + strings.Repeat("0", 64) },
		"zero runtime":      func(d *RPCDerivation) { d.RuntimeID = strings.Repeat("0", 64) },
		"zero profile":      func(d *RPCDerivation) { d.RPC.ProfileSha256 = strings.Repeat("0", 64) },
		"desktop profile":   func(d *RPCDerivation) { d.RPC.Profile = contract.DesktopProfile },
		"alias volumes":     func(d *RPCDerivation) { d.RPC.BaseVolumeID = d.RPC.L1VolumeID },
		"host path":         func(d *RPCDerivation) { d.RPC.L1VolumeID = "/vm/original.qcow2" },
		"engine exposure":   func(d *RPCDerivation) { d.Ports = append(d.Ports, "tcp:18651") },
		"missing peer port": func(d *RPCDerivation) { d.Ports = d.Ports[1:] },
		"zero owner":        func(d *RPCDerivation) { d.SecretDeployment = "0x" + strings.Repeat("0", 64) },
		"less RAM":          func(d *RPCDerivation) { d.Policy.MemMiB-- },
		"more RAM":          func(d *RPCDerivation) { d.Policy.MemMiB++ },
		"more CPU":          func(d *RPCDerivation) { d.Policy.CPUPercent++ },
		"remote provider": func(d *RPCDerivation) {
			d.ConfigBase64 = base64.StdEncoding.EncodeToString([]byte(`{"rpc":"https://example.org"}`))
		},
		"deadline extension": func(d *RPCDerivation) {
			b, _ := base64.StdEncoding.DecodeString(d.ConfigBase64)
			d.ConfigBase64 = base64.StdEncoding.EncodeToString(bytes.ReplaceAll(b, []byte("900"), []byte("901")))
		},
	} {
		t.Run(name, func(t *testing.T) {
			d := rpcRecord()
			change(&d)
			if _, _, err := MapRPC(d, componentPreamble); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	if _, _, err := MapRPC(rpcRecord(), []byte("ELF")); err == nil {
		t.Fatal("native artifact masquerades as portable controller")
	}
}

func TestRPCRejectsMissingUnknownAndMixedFields(t *testing.T) {
	raw, _ := contract.Canonical(rpcRecord())
	for _, change := range []func(map[string]any){
		func(d map[string]any) { delete(d["catalog"].(map[string]any), "version") },
		func(d map[string]any) { d["rpc"].(map[string]any)["command"] = "/bin/sh" },
		func(d map[string]any) { d["rpc"] = nil },
	} {
		var v map[string]any
		json.Unmarshal(raw, &v)
		change(v)
		bad, _ := json.Marshal(v)
		if _, err := ParseRPCRecord(bad); err == nil {
			t.Fatal("accepted missing/null/command")
		}
	}
	_, b, _ := MapRPC(rpcRecord(), componentPreamble)
	start := len(contract.BundleMagic)
	size := int(binary.LittleEndian.Uint32(b[start:]))
	var v map[string]any
	json.Unmarshal(b[start+4:start+4+size], &v)
	v["desktop"] = map[string]any{"profile": contract.DesktopProfile, "profileSha256": strings.Repeat("d", 64), "gpuMilli": 500}
	mb, _ := contract.Canonical(v)
	bad := append([]byte(contract.BundleMagic), 0, 0, 0, 0)
	binary.LittleEndian.PutUint32(bad[start:], uint32(len(mb)))
	bad = append(bad, mb...)
	bad = binary.LittleEndian.AppendUint32(bad, uint32(len(componentPreamble)))
	bad = append(bad, componentPreamble...)
	if _, _, err := contract.ParseRPC(bad); err == nil {
		t.Fatal("mixed profiles accepted")
	}
	b[len(b)-1] ^= 1
	if _, _, err := contract.ParseRPC(b); err == nil {
		t.Fatal("changed controller accepted")
	}
}
