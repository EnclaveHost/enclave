package main

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const testTableLine = " 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 00ff 4096 4096 100 101 450560 ggml model.gguf 1111111111111111111111111111111111111111111111111111111111111111\n"

func writeTable(t *testing.T, names ...string) string {
	p := filepath.Join(t.TempDir(), "model-volumes.table")
	var b strings.Builder
	for _, n := range names {
		b.WriteString(n + testTableLine)
	}
	os.WriteFile(p, []byte(b.String()), 0o444)
	return p
}

// wasm_manager.py: json.loads(cfg).get("volumes"), a list, str()-ed and stripped, empties and repeats dropped
func TestConfigVolumesReadsAsTheManagerDoes(t *testing.T) {
	for cfg, want := range map[string][]string{
		``:                   nil,
		`not json`:           nil,
		`{"volumes":"qwen"}`: nil,
		`{"volumes":[]}`:     nil,
		`{"volumes":[" qwen2.5-0.5b-gguf ","maya1-gguf","qwen2.5-0.5b-gguf",""]}`: {"qwen2.5-0.5b-gguf", "maya1-gguf"},
		`{"volumes":[5,"a"]}`: {"5", "a"},
		`{"other":1}`:         nil,
	} {
		if got := configVolumes(cfg); !reflect.DeepEqual(got, want) {
			t.Errorf("%s: %v, want %v", cfg, got, want)
		}
	}
}

func TestModelBlockOnlyForNamesTheMeasuredTableCarries(t *testing.T) {
	table := writeTable(t, "qwen2.5-0.5b-gguf", "maya1-gguf")
	b, err := modelBlock(`{"volumes":["maya1-gguf","qwen2.5-0.5b-gguf"]}`, table, false)
	if err != nil || string(b) != "M1\nvol=maya1-gguf\nvol=qwen2.5-0.5b-gguf\n" {
		t.Fatalf("block %q %v", b, err)
	}
	if b, err := modelBlock(`{"a":1}`, filepath.Join(t.TempDir(), "absent"), false); b != nil || err != nil {
		t.Fatalf("no volumes: %q %v", b, err)
	}
	for name, c := range map[string]struct {
		cfg, table string
		shield     bool
		want       string
	}{
		"a name the table lacks":            {`{"volumes":["llama-70b-gguf"]}`, table, false, "not one this image's measured table carries"},
		"an image with no table":            {`{"volumes":["maya1-gguf"]}`, filepath.Join(t.TempDir(), "absent"), false, "carries no model-volume table"},
		"a Shield inference image":          {`{"volumes":["maya1-gguf"]}`, table, true, "Shield inference image"},
		"nine volumes":                      {`{"volumes":["a","b","c","d","e","f","g","h","i"]}`, table, false, "at most 8"},
		"a name outside the manager's form": {`{"volumes":["Maya1"]}`, table, false, "not one this image's measured table carries"},
	} {
		if _, err := modelBlock(c.cfg, c.table, c.shield); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v", name, err)
		}
	}
	bad := filepath.Join(t.TempDir(), "bad")
	os.WriteFile(bad, []byte("maya1-gguf only three fields\n"), 0o444)
	if _, err := modelBlock(`{"volumes":["maya1-gguf"]}`, bad, false); err == nil || !strings.Contains(err.Error(), "malformed") {
		t.Errorf("a malformed table: %v", err)
	}
}

// the message init reads (dominit.c read_front_msg/front_blocks): tag, config, then NUL + each non-empty block
func TestHandToInitBlocks(t *testing.T) {
	read := func(f func(w *os.File) error) []byte {
		r, w, _ := os.Pipe()
		go f(w)
		b, _ := io.ReadAll(r)
		return b
	}
	got := read(func(w *os.File) error {
		return handToInitBlocks(w, `{"volumes":["m"]}`, false, []byte("E1\napi=x\n"), nil, []byte("M1\nvol=m\n"))
	})
	want := append(append(append([]byte(`C{"volumes":["m"]}`), 0), "E1\napi=x\n"...), append([]byte{0}, "M1\nvol=m\n"...)...)
	if !bytes.Equal(got, want) {
		t.Fatalf("%q, want %q", got, want)
	}
	if got := read(func(w *os.File) error { return handToInitBlocks(w, `{}`, true, nil, []byte("M1\nvol=m\n")) }); !bytes.Equal(got, append([]byte("P{}\x00"), "M1\nvol=m\n"...)) {
		t.Fatalf("public + M1 only: %q", got)
	}
	if got := read(func(w *os.File) error { return handToInitBlocks(w, `{}`, false) }); string(got) != "C{}" {
		t.Fatalf("no blocks: %q", got)
	}
	r, w, _ := os.Pipe()
	defer r.Close()
	if err := handToInitBlocks(w, "", false, []byte("M1\nvol=m\n")); err == nil {
		t.Fatal("blocks without a config")
	}
}
