//go:build linux && amd64

package desktop

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"testing"
)

func table(w verityTarget) []byte {
	b := make([]byte, 1024)
	le := binary.LittleEndian
	le.PutUint32(b[:4], 4)
	le.PutUint32(b[12:16], uint32(len(b)))
	le.PutUint32(b[16:20], 312)
	le.PutUint32(b[20:24], 1)
	le.PutUint32(b[28:32], 1|1<<5|1<<4)
	le.PutUint64(b[40:48], 0xfd00)
	t := b[312:]
	le.PutUint64(t[8:16], w.Blocks*8)
	copy(t[24:40], "verity")
	copy(t[40:], fmt.Sprintf("1 8:0 8:16 4096 4096 %d %d sha256 %s %s", w.Blocks, w.HashStart, w.RootHash, w.Salt))
	return b
}
func TestActiveVerityTable(t *testing.T) {
	p, _ := fixture(t)
	w := verityTarget{p.Root.DataBlocks, 0, p.Root.RootHash, p.Root.Salt}
	if e := validateTable(table(w), 0xfd00, w); e != nil {
		t.Fatal(e)
	}
	cases := []struct {
		name string
		f    func([]byte)
	}{
		{"writable", func(b []byte) { b[28] &= ^byte(1) }}, {"suspended", func(b []byte) { b[28] |= 2 }}, {"inactive", func(b []byte) { b[28] |= 64 }}, {"no active", func(b []byte) { b[28] &= ^byte(32) }}, {"truncated", func(b []byte) { b[29] |= 1 }}, {"multiple targets", func(b []byte) { b[20] = 2 }}, {"other device", func(b []byte) { b[40] = 1 }}, {"out of bounds", func(b []byte) { binary.LittleEndian.PutUint32(b[16:20], 1020) }}, {"linear", func(b []byte) { copy(b[336:352], []byte("linear\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00")) }}, {"wrong length", func(b []byte) { b[320]++ }}, {"unchecked reads", func(b []byte) {
			for i := 352; i < len(b); i++ {
				if b[i] == 0 {
					copy(b[i:], " 1 check_at_most_once\x00")
					break
				}
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			b := table(w)
			c.f(b)
			if validateTable(b, 0xfd00, w) == nil {
				t.Fatal("unsafe table accepted")
			}
		})
	}
	wrong := w
	wrong.RootHash = p.Models.RootHash
	if validateTable(table(w), 0xfd00, wrong) == nil {
		t.Fatal("wrong hash accepted")
	}
}

func TestFilesystemRootVersusBindSubdirectory(t *testing.T) {
	good := []byte("42 1 253:0 / /plat/root ro,nosuid,nodev - squashfs /dev/dm-0 ro\n")
	if e := verifyMountRoot(good, 42, "253:0"); e != nil {
		t.Fatal(e)
	}
	for _, raw := range [][]byte{[]byte("42 1 253:0 /usr /plat/root ro - squashfs /dev/dm-0 ro\n"), []byte("42 1 253:1 / /plat/root ro - squashfs /dev/dm-1 ro\n"), []byte("43 1 253:0 / /plat/root ro - squashfs /dev/dm-0 ro\n"), append(append([]byte{}, good...), good...)} {
		if verifyMountRoot(raw, 42, "253:0") == nil {
			t.Fatal("wrong mounted root accepted")
		}
	}
}

func TestModelVerityBackingLayout(t *testing.T) {
	p, _ := fixture(t)
	w := verityTarget{p.Models.DataBlocks, p.Models.HashStartBlock, p.Models.RootHash, p.Models.Salt}
	split := table(w)
	if validateTable(split, 0xfd00, w) == nil {
		t.Fatal("split model data/hash devices accepted")
	}
	together := bytes.Replace(split, []byte("1 8:0 8:16 "), []byte("1 8:0 8:0 "), 1)
	// Preserve the reply's declared buffer size after the shorter parameter.
	together = append(together, 0)
	if e := validateTable(together, 0xfd00, w); e != nil {
		t.Fatal(e)
	}
	root := verityTarget{p.Root.DataBlocks, 0, p.Root.RootHash, p.Root.Salt}
	together = bytes.Replace(table(root), []byte("1 8:0 8:16 "), []byte("1 8:0 8:0 "), 1)
	together = append(together, 0)
	if validateTable(together, 0xfd00, root) == nil {
		t.Fatal("root with shared data/hash device accepted")
	}
}
