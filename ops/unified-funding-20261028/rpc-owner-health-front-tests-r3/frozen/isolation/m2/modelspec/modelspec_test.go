package modelspec

import (
	"crypto/rand"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
)

func TestConfigVolumesReadsAsTheManagerDoes(t *testing.T) {
	for cfg, want := range map[string][]string{
		``: nil, `not json`: nil, `{"volumes":"qwen"}`: nil, `{"volumes":[]}`: nil, `{"other":1}`: nil, `[1]`: nil,
		`{"volumes":[" qwen2.5-0.5b-gguf ","maya1-gguf","qwen2.5-0.5b-gguf",""]}`: {"qwen2.5-0.5b-gguf", "maya1-gguf"},
		`{"volumes":[5,"a"]}`: {"5", "a"},
	} {
		if got := ConfigVolumes(cfg); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", cfg, got, want)
		}
	}
	if string(M1([]string{"a", "b"})) != "M1\nvol=a\nvol=b\n" {
		t.Fatal("M1")
	}
}

func TestTableIsStrict(t *testing.T) {
	ok := "a.gguf 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 00ff 4096 4096 100 101 450560 ggml dir/m.gguf " + strings.Repeat("11", 32) + "\n"
	tab, err := ParseTable(strings.NewReader(ok))
	if err != nil || tab["a.gguf"].HashStart != 101 || tab["a.gguf"].Graph != "dir/m.gguf" || tab["a.gguf"].Serial() != "mv0123456789abcdef01" {
		t.Fatalf("%v %v", tab, err)
	}
	for _, bad := range []string{
		strings.Replace(ok, "a.gguf", "A.GGUF", 1), strings.Replace(ok, " 101 ", " 100 ", 1), strings.Replace(ok, " ggml ", " onnx ", 1),
		strings.Replace(ok, " dir/m.gguf ", " ../m.gguf ", 1), strings.Replace(ok, " dir/m.gguf ", " /m.gguf ", 1),
		strings.Replace(ok, " ggml dir/m.gguf ", " none dir/m.gguf ", 1), strings.Replace(ok, " 450560 ", " 409600 ", 1),
		strings.Replace(ok, " 450560 ", " 450561 ", 1), ok + ok, strings.Replace(ok, " 4096 4096 ", " 512 4096 ", 1),
		strings.Replace(ok, " 00ff ", " 0ff ", 1), strings.Replace(ok, " 100 ", " 0100 ", 1),
	} {
		if _, err := ParseTable(strings.NewReader(bad)); err == nil {
			t.Errorf("accepted %q", bad[:60])
		}
	}
}

// HoldsRoot against a hash tree veritysetup itself wrote, in the layout metal/volumes.mjs builds (data, then the hash
// superblock at the data's end, then the tree: hashStartBlock = hashOffset/4096 + 1).
func TestHoldsRootOnARealVerityImage(t *testing.T) {
	vs, err := exec.LookPath("veritysetup")
	if err != nil {
		t.Skip("veritysetup is not installed")
	}
	img := filepath.Join(t.TempDir(), "volume.img")
	const dataBlocks = 300 // more than one 4096-byte hash block of leaves (128 per block): a two-level tree
	data := make([]byte, dataBlocks*4096)
	rand.Read(data)
	if err := os.WriteFile(img, data, 0o600); err != nil {
		t.Fatal(err)
	}
	salt := "a1b2c3d4"
	out, err := exec.Command(vs, "format", "--data-block-size", "4096", "--hash-block-size", "4096", "--data-blocks", "300",
		"--hash-offset", "1228800", "--salt", salt, img, img).CombinedOutput()
	if err != nil {
		t.Fatalf("veritysetup: %v %s", err, out)
	}
	m := regexp.MustCompile(`Root hash:\s+([0-9a-f]{64})`).FindSubmatch(out)
	if m == nil {
		t.Fatalf("no root in %s", out)
	}
	st, _ := os.Stat(img)
	e := Entry{Name: "v", Root: string(m[1]), Salt: salt, DataBlocks: dataBlocks, HashStart: 1228800/4096 + 1, ImageBytes: st.Size()}
	f, _ := os.Open(img)
	defer f.Close()
	if !HoldsRoot(f, e) {
		t.Fatal("the image veritysetup formatted does not hold its own root")
	}
	for name, mut := range map[string]func(Entry) Entry{
		"another root":         func(e Entry) Entry { e.Root = strings.Repeat("0", 64); return e },
		"another salt":         func(e Entry) Entry { e.Salt = "a1b2c3d5"; return e },
		"the superblock":       func(e Entry) Entry { e.HashStart--; return e },
		"past the image's end": func(e Entry) Entry { e.HashStart = st.Size() / 4096; return e },
	} {
		if HoldsRoot(f, mut(e)) {
			t.Errorf("%s: held", name)
		}
	}
}
