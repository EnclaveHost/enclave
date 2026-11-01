package catalog

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"enclave.host/isolation/contract"
)

type desktopVectors struct {
	ComponentHex string `json:"component_hex"`
	OK           []struct {
		Name      string          `json:"name"`
		Record    json.RawMessage `json:"record"`
		Mapping   DesktopMapping  `json:"mapping"`
		BundleHex string          `json:"bundle_hex"`
	} `json:"ok"`
	Refused []struct {
		Name         string          `json:"name"`
		Record       json.RawMessage `json:"record"`
		ComponentHex string          `json:"component_hex"`
	} `json:"refused"`
}

func TestDesktopManifestCannotBypassRecordValidation(t *testing.T) {
	raw, err := os.ReadFile("desktop_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v desktopVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	base, err := hex.DecodeString(v.OK[0].BundleHex)
	if err != nil {
		t.Fatal(err)
	}
	component, _ := hex.DecodeString(v.ComponentHex)
	off := len(contract.BundleMagic)
	size := int(binary.LittleEndian.Uint32(base[off:]))
	manifestBytes := base[off+4 : off+4+size]
	cases := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"unmasked profile", func(m map[string]any) { m["desktop"].(map[string]any)["profile"] = "unmasked" }},
		{"zero profile hash", func(m map[string]any) {
			m["desktop"].(map[string]any)["profileSha256"] = string(bytes.Repeat([]byte("0"), 64))
		}},
		{"undersized GPU share", func(m map[string]any) { m["desktop"].(map[string]any)["gpuMilli"] = 499 }},
		{"device passthrough", func(m map[string]any) { m["desktop"].(map[string]any)["device"] = "/dev/dri/renderD128" }},
		{"missing config", func(m map[string]any) { delete(m, "configBase64") }},
		{"missing owner binding", func(m map[string]any) { delete(m, "secretDeployment") }},
		{"privileged HTTP", func(m map[string]any) { m["http"] = 443 }},
		{"missing Moonlight ports", func(m map[string]any) { delete(m, "ports") }},
		{"insufficient memory", func(m map[string]any) { m["policy"].(map[string]any)["memMiB"] = 1024 }},
		{"mixed inference profile", func(m map[string]any) {
			m["inference"] = map[string]any{"model": "qwen2.5-0.5b-q8-gguf", "gpuMilli": 500}
		}},
		{"non-catalog label", func(m map[string]any) { m["label"] = "desktop" }},
		{"no companion", func(m map[string]any) { delete(m, "desktop") }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var manifest map[string]any
			if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
				t.Fatal(err)
			}
			c.mutate(manifest)
			mb, err := contract.Canonical(manifest)
			if err != nil {
				t.Fatal(err)
			}
			bundle := []byte(contract.BundleMagic)
			bundle = binary.LittleEndian.AppendUint32(bundle, uint32(len(mb)))
			bundle = append(bundle, mb...)
			bundle = binary.LittleEndian.AppendUint32(bundle, uint32(len(component)))
			bundle = append(bundle, component...)
			if _, _, err := contract.ParseDesktop(bundle); err == nil {
				t.Fatal("offline parser accepted malformed desktop")
			}
		})
	}
}

func TestDesktopIndependentVectors(t *testing.T) {
	raw, err := os.ReadFile("desktop_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v desktopVectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.OK) < 7 || len(v.Refused) < 25 {
		t.Fatal("insufficient independent desktop vectors")
	}
	component, err := hex.DecodeString(v.ComponentHex)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range v.OK {
		t.Run(c.Name, func(t *testing.T) {
			d, err := ParseDesktopRecord(c.Record)
			if err != nil {
				t.Fatal(err)
			}
			got, bundle, err := MapDesktop(d, component)
			if err != nil {
				t.Fatal(err)
			}
			want, err := hex.DecodeString(c.BundleHex)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, c.Mapping) || !bytes.Equal(bundle, want) {
				t.Fatalf("mapping/bundle differs from independent reference: %+v", got)
			}
			m, artifact, err := contract.ParseDesktop(bundle)
			if err != nil || m.Desktop == nil || !bytes.Equal(artifact, component) {
				t.Fatalf("offline parse: %v", err)
			}
			if _, _, err := contract.Parse(bundle); err == nil {
				t.Fatal("ordinary runtime parser admitted experimental desktop")
			}
		})
	}
	for _, c := range v.Refused {
		t.Run("refused/"+c.Name, func(t *testing.T) {
			d, err := ParseDesktopRecord(c.Record)
			if err != nil {
				return
			}
			comp, err := hex.DecodeString(c.ComponentHex)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := MapDesktop(d, comp); err == nil {
				t.Fatal("accepted refused vector")
			}
		})
	}
}
