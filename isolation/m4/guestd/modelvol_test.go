package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"enclave.host/isolation/contract"
)

const (
	rootA = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff"
	rootB = "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0"
	pinX  = "1111111111111111111111111111111111111111111111111111111111111111"
)

func modelLine(name, root string, preload, graph string) string {
	return fmt.Sprintf("%s %s 00ff 4096 4096 10 11 49152 %s %s %s\n", name, root, preload, graph, pinX)
}

// a store volume as metal/volumes.mjs lays it out: its record states 49152 bytes; the image is size bytes
func storeVolume(t *testing.T, store, name, root string, size int64) {
	dir := filepath.Join(store, name)
	os.MkdirAll(dir, 0o755)
	rec := fmt.Sprintf(`{"name":%q,"image":"volume.img","imageBytes":49152,"verity":{"alg":"sha256","root":%q,"salt":"00ff","dataBlockSize":4096,"hashBlockSize":4096,"dataBlocks":10,"hashOffset":40960,"hashStartBlock":11}}`, name, root)
	os.WriteFile(filepath.Join(dir, "volume.json"), []byte(rec), 0o644)
	f, _ := os.Create(filepath.Join(dir, "volume.img"))
	f.Truncate(size)
	f.Close()
}

func TestModelTableIsStrict(t *testing.T) {
	dir := t.TempDir()
	good := modelLine("qwen-a", rootA, "ggml", "model.gguf") + modelLine("data-b", rootB, "none", "-")
	p := filepath.Join(dir, "t")
	os.WriteFile(p, []byte(good), 0o444)
	tab, err := parseModelTable(p)
	if err != nil || len(tab) != 2 || tab["qwen-a"].Serial() != "mva1b2c3d4e5f6071829" || tab["data-b"].Preload != "none" {
		t.Fatalf("table %v %v", tab, err)
	}
	for i, bad := range []string{
		strings.Replace(good, "qwen-a", "Qwen-A", 1), strings.Replace(good, " 4096 4096 ", " 512 4096 ", 1),
		strings.Replace(good, " 10 11 ", " 10 10 ", 1), strings.Replace(good, " ggml ", " onnx ", 1),
		strings.Replace(good, " none - ", " none x.gguf ", 1), good + modelLine("qwen-a", rootA, "ggml", "m.gguf"),
		strings.Replace(good, " 49152 ", " 49153 ", 1), "short line\n",
	} {
		os.Remove(p) // the table is written read-only, as an image carries it
		os.WriteFile(p, []byte(bad), 0o444)
		if _, err := parseModelTable(p); err == nil {
			t.Errorf("bad table %d accepted", i)
		}
	}
}

func TestStoreOffersOnlyThePinnedVolumes(t *testing.T) {
	store := t.TempDir()
	tab := map[string]modelEntry{
		"qwen-a":  {Name: "qwen-a", Root: rootA, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "ggml", Graph: "model.gguf", Pin: pinX},
		"data-b":  {Name: "data-b", Root: rootB, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "none", Graph: "-", Pin: pinX},
		"gone-c":  {Name: "gone-c", Root: rootA, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "none", Graph: "-", Pin: pinX},
		"short-d": {Name: "short-d", Root: rootA, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "none", Graph: "-", Pin: pinX},
	}
	storeVolume(t, store, "qwen-a", rootA, 49152)
	storeVolume(t, store, "data-b", rootA, 49152) // the store's record names another root
	storeVolume(t, store, "short-d", rootA, 4096) // truncated image
	have, missing := storeVolumes(tab, store)
	if len(have) != 1 || have["qwen-a"].Image != filepath.Join(store, "qwen-a", "volume.img") {
		t.Fatalf("have %v", have)
	}
	if !strings.Contains(missing["data-b"], "not the pinned volume") || !strings.Contains(missing["gone-c"], "not in this host's store") ||
		!strings.Contains(missing["short-d"], "not the pinned size") {
		t.Fatalf("missing %v", missing)
	}
}

func TestCreateAttachesExactlyTheRequestedPinnedVolumes(t *testing.T) {
	r := newRig(t)
	store := t.TempDir()
	tab := map[string]modelEntry{
		"qwen-a": {Name: "qwen-a", Root: rootA, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "ggml", Graph: "model.gguf", Pin: pinX},
		"data-b": {Name: "data-b", Root: rootB, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: 49152, Preload: "none", Graph: "-", Pin: pinX},
	}
	storeVolume(t, store, "qwen-a", rootA, 49152)
	storeVolume(t, store, "data-b", rootB, 49152)
	r.s.ModelVolumes, r.s.ModelMissing = storeVolumes(tab, store)
	r.s.ModelTable, r.s.RuntimeNN = true, true

	// health: the volumes as the supervisor's gate reads them, and the capability only with -release
	_, h := r.do("GET", "/health", nil)
	vols, _ := h["volumes"].([]any)
	names := []string{}
	for _, v := range vols {
		m := v.(map[string]any)
		if m["kind"] == "model" {
			names = append(names, fmt.Sprint(m["name"], ":", m["backend"]))
		}
	}
	if strings.Join(names, ",") != "data-b:none,qwen-a:ggml" {
		t.Fatalf("advertised %v", names)
	}
	sup := h["supports"].(map[string]any)
	if sup["modelVolumes"] != false || sup["nnPreload"] != true {
		t.Fatalf("supports without -release: %v", sup)
	}
	r.s.Release = true
	_, h = r.do("GET", "/health", nil)
	if h["supports"].(map[string]any)["modelVolumes"] != true {
		t.Fatal("supports.modelVolumes with the table and -release")
	}
	r.s.Release = false

	p, _ := r.bundle("A", contract.Policy{})
	body := func(name string, vols ...string) map[string]any {
		return map[string]any{"image": "file://" + p, "name": name, "cpuShare": 0.25, "gpuShare": 0, "appPort": 8080,
			"ports": []any{}, "config": "", "configCid": "", "egress": "", "volumes": vols}
	}
	for name, c := range map[string]struct {
		vols []string
		want string
	}{
		"0xb1": {[]string{"llama-70b"}, "do not carry it"},
		"0xb2": {[]string{"qwen-a", "qwen-a"}, "named twice"},
		"0xb3": {[]string{"a", "b", "c", "d", "e", "f", "g", "h", "i"}, "more than 8"},
	} {
		if code, out := r.do("POST", "/vms", body(name, c.vols...)); code != 422 || !strings.Contains(fmt.Sprint(out["error"]), c.want) {
			t.Errorf("%v: %d %v", c.vols, code, out)
		}
	}
	// a Shield inference image carries its own measured model; a legacy guest has no table: both refused
	if why := r.s.modelRefusal([]string{"qwen-a"}, true, false); !strings.Contains(why, "Shield inference") {
		t.Errorf("beside inference: %q", why)
	}
	if why := r.s.modelRefusal([]string{"qwen-a"}, false, true); !strings.Contains(why, "legacy") {
		t.Errorf("legacy: %q", why)
	}
	code, out := r.do("POST", "/vms", body("0xa1", "qwen-a", "data-b"))
	if code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	r.s.launching.Wait()
	id := out["id"].(string)
	got, err := os.ReadFile(filepath.Join(r.s.Root, id, "guest.cpio.gz.volumes"))
	want := "mva1b2c3d4e5f6071829 " + filepath.Join(store, "qwen-a", "volume.img") + "\n" +
		"mv0f1e2d3c4b5a697887 " + filepath.Join(store, "data-b", "volume.img") + "\n"
	if err != nil || string(got) != want {
		t.Fatalf("attach list %q %v, want %q", got, err, want)
	}
	// a create without volumes writes no list (an image without one attaches nothing)
	code, out = r.do("POST", "/vms", body("0xa2"))
	if code != 201 {
		t.Fatalf("create: %d %v", code, out)
	}
	r.s.launching.Wait()
	if _, err := os.Stat(filepath.Join(r.s.Root, out["id"].(string), "guest.cpio.gz.volumes")); !os.IsNotExist(err) {
		t.Fatalf("a list without volumes: %v", err)
	}
}
