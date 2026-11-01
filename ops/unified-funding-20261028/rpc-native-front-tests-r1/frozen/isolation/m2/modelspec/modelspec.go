// Package modelspec is what a model volume IS to the measured guests, standard library only: the config's "volumes"
// read as the shared runtime reads them (wasm/wasm_manager.py), the release's pinned table (rt/model-volumes.table,
// written by sdk/storage/model-volumes.mjs tableLine), and the check that a disk's dm-verity hash tree hashes to a
// table root. The per-app SNP guest's front, the Windows partition's monitor and guestd all read volumes through it;
// the per-app guest's init re-checks the same rules in C (modelvol.h).
package modelspec

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Max is how many model volumes one app runs with (modelvol.h MV_MAX).
const Max = 8

var (
	NameRE  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`) // wasm_manager _VOL_NAME_RE
	hex64RE = regexp.MustCompile(`^[0-9a-f]{64}$`)
	saltRE  = regexp.MustCompile(`^([0-9a-f]{2}){1,128}$`)
	numRE   = regexp.MustCompile(`^[1-9][0-9]{0,15}$`)
	graphRE = regexp.MustCompile(`^[A-Za-z0-9._+-]+(/[A-Za-z0-9._+-]+)*$`)
)

// ConfigVolumes is wasm_manager's reading of a config's "volumes": a JSON list, each entry str()-ed and stripped,
// empties dropped, repeats dropped. Anything else (no config, not an object, not a list) names none.
func ConfigVolumes(config string) []string {
	var doc map[string]json.RawMessage
	if strings.TrimSpace(config) == "" || json.Unmarshal([]byte(config), &doc) != nil {
		return nil
	}
	var list []any
	if json.Unmarshal(doc["volumes"], &list) != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, v := range list {
		var s string
		switch x := v.(type) {
		case string:
			s = x
		default:
			b, _ := json.Marshal(x)
			s = string(b)
		}
		s = strings.TrimSpace(s)
		if s != "" && !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// Entry is one line of the pinned table: name root salt 4096 4096 dataBlocks hashStartBlock imageBytes preload graph pin.
type Entry struct {
	Name, Root, Salt, Preload, Graph, Pin string
	DataBlocks, HashStart, ImageBytes     int64
}

// Serial is the per-app SNP guest's virtio serial for the volume's disk (modelvol.h).
func (e Entry) Serial() string { return "mv" + e.Root[:18] }

// ParseTable reads the table strictly: every field formed as the release writes it, no name twice.
func ParseTable(r io.Reader) (map[string]Entry, error) {
	out := map[string]Entry{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 4096), 4096)
	for sc.Scan() {
		f := strings.Split(sc.Text(), " ")
		if len(f) != 11 {
			return nil, errors.New("malformed model-volume table line")
		}
		num := func(s string) int64 {
			if !numRE.MatchString(s) {
				return -1
			}
			n, _ := strconv.ParseInt(s, 10, 64)
			return n
		}
		e := Entry{Name: f[0], Root: f[1], Salt: f[2], DataBlocks: num(f[5]), HashStart: num(f[6]), ImageBytes: num(f[7]), Preload: f[8], Graph: f[9], Pin: f[10]}
		switch {
		case !NameRE.MatchString(e.Name), !hex64RE.MatchString(e.Root), !saltRE.MatchString(e.Salt), f[3] != "4096", f[4] != "4096",
			e.DataBlocks < 1, e.HashStart <= e.DataBlocks, e.ImageBytes <= e.HashStart*4096, e.ImageBytes%4096 != 0,
			e.Preload != "ggml" && e.Preload != "sd" && e.Preload != "none", (e.Preload == "none") != (e.Graph == "-"),
			e.Graph != "-" && (len(e.Graph) > 240 || !graphRE.MatchString(e.Graph) || badSegment(e.Graph)), !hex64RE.MatchString(e.Pin):
			return nil, fmt.Errorf("malformed model-volume table entry %q", f[0])
		}
		if _, dup := out[e.Name]; dup {
			return nil, fmt.Errorf("model-volume table names %q twice", e.Name)
		}
		out[e.Name] = e
	}
	return out, sc.Err()
}

func badSegment(g string) bool {
	for _, s := range strings.Split(g, "/") {
		if s == "." || s == ".." {
			return true
		}
	}
	return false
}

// ReadTable is ParseTable over a file.
func ReadTable(path string) (map[string]Entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return ParseTable(f)
}

// HoldsRoot reports whether disk (a block device or image file) holds e's hash tree: the top-level hash block, the
// first at HashStart, hashes with the salt (dm-verity format 1: sha256(salt || block)) to the pinned root. That is the
// check dm-verity makes before it serves any block, so a disk that passes is the only one whose reads can verify; it
// lets a guest find a volume among attached disks without trusting where the host put it.
func HoldsRoot(disk io.ReaderAt, e Entry) bool {
	salt, err := hex.DecodeString(e.Salt)
	if err != nil {
		return false
	}
	blk := make([]byte, 4096)
	if n, _ := disk.ReadAt(blk, e.HashStart*4096); n != len(blk) {
		return false
	}
	h := sha256.New()
	h.Write(salt)
	h.Write(blk)
	return hex.EncodeToString(h.Sum(nil)) == e.Root
}

// M1 is the "M1" block naming volumes (dominit.c front_blocks, modelvol.h model_block): the per-app guest's front
// sends it to init, and the Windows partition's monitor leaves it in a domain for domexec.
func M1(names []string) []byte {
	var b strings.Builder
	b.WriteString("M1\n")
	for _, n := range names {
		b.WriteString("vol=" + n + "\n")
	}
	return []byte(b.String())
}
