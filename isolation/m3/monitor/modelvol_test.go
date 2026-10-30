package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/m2/modelspec"
)

// a disk image whose top-level hash block hashes (salt || block) to the returned root, as a dm-verity tree does; the
// format itself is checked against veritysetup in isolation/m2/modelspec
func fakeVerityDisk(t *testing.T, path string, size, hashStart int64, seed byte) string {
	b := make([]byte, size)
	for i := range b[hashStart*4096 : hashStart*4096+4096] {
		b[hashStart*4096+int64(i)] = seed + byte(i)
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(append([]byte{0x00, 0xff}, b[hashStart*4096:hashStart*4096+4096]...))
	return hex.EncodeToString(h[:])
}

type modelRig struct {
	mm       *modelMounts
	setups   []string
	mounts   []string
	failNode string
}

// a partition with disks sda.. (name -> size, seed); the table pins volumes by root
func newModelRig(t *testing.T, table map[string]modelspec.Entry, disks map[string][2]int64) *modelRig {
	dir := t.TempDir()
	r := &modelRig{}
	r.mm = &modelMounts{table: table, mounted: map[string]string{}, claimed: map[string]string{},
		sysBlock: filepath.Join(dir, "sys"), dev: filepath.Join(dir, "dev"), root: filepath.Join(dir, "models"), wait: 300 * time.Millisecond,
		setup: func(mapName, disk string, e modelspec.Entry) (string, error) {
			r.setups = append(r.setups, mapName+" "+filepath.Base(disk)+" "+e.Root[:8])
			return "/dev/mapper/" + mapName, nil
		},
		mount: func(node, at string) error {
			if node == r.failNode {
				return errors.New("bad superblock")
			}
			r.mounts = append(r.mounts, node+" "+filepath.Base(at))
			return nil
		}}
	os.MkdirAll(r.mm.dev, 0o755)
	for name, d := range disks {
		os.MkdirAll(filepath.Join(r.mm.sysBlock, name), 0o755)
		os.WriteFile(filepath.Join(r.mm.sysBlock, name, "size"), []byte(fmt.Sprintf("%d\n", d[0]/512)), 0o444)
		fakeVerityDisk(t, filepath.Join(r.mm.dev, name), d[0], 11, byte(d[1]))
	}
	return r
}

func entry(name string, size, seed int64, t *testing.T) modelspec.Entry {
	root := fakeVerityDisk(t, filepath.Join(t.TempDir(), "x"), size, 11, byte(seed))
	return modelspec.Entry{Name: name, Root: root, Salt: "00ff", DataBlocks: 10, HashStart: 11, ImageBytes: size, Preload: "ggml", Graph: "model.gguf", Pin: strings.Repeat("11", 32)}
}

func TestModelVolumesMountOnlyThePinnedDisk(t *testing.T) {
	const size = 16 * 4096
	qwen, data := entry("qwen-a", size, 1, t), entry("data-b", size+4096, 2, t)
	table := map[string]modelspec.Entry{"qwen-a": qwen, "data-b": data}
	// sda: the right size, another tree (a decoy); sdb: qwen's; sdc: data's; vda: data's tree at the wrong size
	r := newModelRig(t, table, map[string][2]int64{"sda": {size, 9}, "sdb": {size, 1}, "sdc": {size + 4096, 2}, "vda": {size + 8192, 2}})
	var binds []string
	bind := func(src, dst string) error {
		binds = append(binds, filepath.Base(src)+"->"+filepath.Base(dst))
		return nil
	}

	d := &domain{AppConfig: []byte(`{"volumes":["data-b"," qwen-a ","data-b"]}`), dir: t.TempDir()}
	if err := stageModelVolumes(d, r.mm, bind); err != nil {
		t.Fatal(err)
	}
	if strings.Join(r.setups, ",") != "mv-data-b sdc "+data.Root[:8]+",mv-qwen-a sdb "+qwen.Root[:8] {
		t.Fatalf("verity over %v", r.setups)
	}
	if strings.Join(r.mounts, ",") != "/dev/mapper/mv-data-b data-b,/dev/mapper/mv-qwen-a qwen-a" || strings.Join(binds, ",") != "data-b->data-b,qwen-a->qwen-a" {
		t.Fatalf("mounts %v binds %v", r.mounts, binds)
	}
	if b, _ := os.ReadFile(filepath.Join(d.dir, "model.volumes")); string(b) != "M1\nvol=data-b\nvol=qwen-a\n" {
		t.Fatalf("marker %q", b)
	}
	if fi, _ := os.Stat(filepath.Join(d.dir, "model.volumes")); fi.Mode().Perm() != 0o444 {
		t.Fatalf("marker mode %v", fi.Mode())
	}
	if len(d.modelMounts) != 2 || d.modelMounts[1] != filepath.Join(d.dir, "models", "qwen-a") {
		t.Fatalf("reclaim list %v", d.modelMounts)
	}
	// a second domain shares the partition's verified mount: no second verity device
	d2 := &domain{AppConfig: []byte(`{"volumes":["qwen-a"]}`), dir: t.TempDir()}
	if err := stageModelVolumes(d2, r.mm, bind); err != nil || len(r.setups) != 2 {
		t.Fatalf("shared: %v %v", err, r.setups)
	}
	// no volumes: nothing, on any image
	for _, cfg := range []string{"", `{"a":1}`, `{"volumes":[]}`} {
		d := &domain{AppConfig: []byte(cfg), dir: t.TempDir()}
		if err := stageModelVolumes(d, nil, bind); err != nil || len(d.modelMounts) != 0 {
			t.Errorf("%q: %v", cfg, err)
		}
		if _, err := os.Stat(filepath.Join(d.dir, "model.volumes")); !os.IsNotExist(err) {
			t.Errorf("%q: a marker without volumes", cfg)
		}
	}
}

func TestModelVolumesRefusedNeverDropped(t *testing.T) {
	const size = 16 * 4096
	qwen := entry("qwen-a", size, 1, t)
	other := entry("other-c", size, 3, t)
	table := map[string]modelspec.Entry{"qwen-a": qwen, "other-c": other}
	bind := func(src, dst string) error { return nil }
	r := newModelRig(t, table, map[string][2]int64{"sda": {size, 1}})
	for name, c := range map[string]struct {
		mm        *modelMounts
		cfg       string
		want      string
		inference *contract.Inference
	}{
		"a Shield inference domain": {r.mm, `{"volumes":["qwen-a"]}`, "carries its own measured model", &contract.Inference{}},
		"a name the table lacks":    {r.mm, `{"volumes":["llama-70b"]}`, "not one this image's measured table carries", nil},
		"a name outside the form":   {r.mm, `{"volumes":["Qwen"]}`, "not one this image's measured table carries", nil},
		"no disk holds its tree":    {r.mm, `{"volumes":["other-c"]}`, "no attached disk holds its pinned hash tree", nil},
		"nine volumes":              {r.mm, `{"volumes":["a","b","c","d","e","f","g","h","i"]}`, "at most 8", nil},
		"an image without a table":  {&modelMounts{}, `{"volumes":["qwen-a"]}`, "carries no model-volume table", nil},
		"a malformed table":         {&modelMounts{bad: errors.New("x")}, `{"volumes":["qwen-a"]}`, "malformed", nil},
	} {
		d := &domain{AppConfig: []byte(c.cfg), dir: t.TempDir(), Inference: c.inference}
		if err := stageModelVolumes(d, c.mm, bind); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", name, err)
		}
		if _, err := os.Stat(filepath.Join(d.dir, "model.volumes")); !os.IsNotExist(err) {
			t.Errorf("%s: a marker for a refused domain", name)
		}
	}
	// a disk whose superblock fails verity: refused
	r.failNode = "/dev/mapper/mv-qwen-a"
	if err := stageModelVolumes(&domain{AppConfig: []byte(`{"volumes":["qwen-a"]}`), dir: t.TempDir()}, r.mm, bind); err == nil || !strings.Contains(err.Error(), "read-only mount over dm-verity") {
		t.Errorf("a failing mount: %v", err)
	}
}
