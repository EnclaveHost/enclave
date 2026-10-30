package main

// modelvol.go: the model volumes this host can attach to a per-app guest.
//
// What a volume IS comes from the pinned CPU template's measured table (rt/model-volumes.table; one line per volume:
// name, dm-verity root, salt, geometry, image bytes, preload kind and graph, distribution pin). What this host HAS is
// its store (-model-volumes <dir>: metal/volumes.mjs layout, <dir>/<name>/{volume.json,volume.img}, filled by
// `metal/volumes.mjs fetch` from replicas or built locally). A volume is offered only when the store's record states
// exactly the table's root and geometry and the image is the table's size: the guest verifies every block against the
// pinned root anyway, so this only keeps a host from advertising, and a lease from being claimed for, a volume whose
// guest would refuse to start.
//
// The guest learns which disk is which from its virtio serial: "mv" + the root's first 18 hex digits (modelvol.h).
// guestd writes the attach list beside the image (<image>.volumes, one "<serial> <path>" per line) for run-domain.sh,
// the way a Shield image carries <image>.shield.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"enclave.host/isolation/m2/modelspec"
)

const modelVolumesMax = modelspec.Max

type modelEntry = modelspec.Entry

type modelVolume struct {
	modelEntry
	Image string // the store's image path
}

// parseModelTable reads the measured table (modelspec.ParseTable: sdk/storage/model-volumes.mjs tableLine).
func parseModelTable(path string) (map[string]modelEntry, error) { return modelspec.ReadTable(path) }

// storeVolumes: the table's volumes this host's store holds intact (record and size agree with the pinned entry).
// The second result says why each other table volume is absent, for /health.
func storeVolumes(table map[string]modelEntry, store string) (map[string]modelVolume, map[string]string) {
	have, missing := map[string]modelVolume{}, map[string]string{}
	for name, e := range table {
		dir := filepath.Join(store, name)
		raw, err := os.ReadFile(filepath.Join(dir, "volume.json"))
		if err != nil {
			missing[name] = "not in this host's store"
			continue
		}
		var rec struct {
			Name       string `json:"name"`
			Image      string `json:"image"`
			ImageBytes int64  `json:"imageBytes"`
			Verity     struct {
				Alg            string `json:"alg"`
				Root           string `json:"root"`
				Salt           string `json:"salt"`
				DataBlockSize  int64  `json:"dataBlockSize"`
				HashBlockSize  int64  `json:"hashBlockSize"`
				DataBlocks     int64  `json:"dataBlocks"`
				HashStartBlock int64  `json:"hashStartBlock"`
			} `json:"verity"`
		}
		if json.Unmarshal(raw, &rec) != nil || rec.Name != name || rec.Verity.Alg != "sha256" || rec.Verity.Root != e.Root || rec.Verity.Salt != e.Salt ||
			rec.Verity.DataBlockSize != 4096 || rec.Verity.HashBlockSize != 4096 || rec.Verity.DataBlocks != e.DataBlocks ||
			rec.Verity.HashStartBlock != e.HashStart || rec.ImageBytes != e.ImageBytes {
			missing[name] = "the store's record is not the pinned volume"
			continue
		}
		img := filepath.Join(dir, "volume.img")
		if rec.Image != "" && rec.Image != "volume.img" {
			missing[name] = "unexpected image name in the store's record"
			continue
		}
		st, err := os.Lstat(img)
		if err != nil || !st.Mode().IsRegular() || st.Size() != e.ImageBytes || strings.ContainsAny(img, ", \n") {
			missing[name] = "the store's image is not the pinned size (or not a plain file)"
			continue
		}
		have[name] = modelVolume{modelEntry: e, Image: img}
	}
	return have, missing
}

// modelVolumesHealth: what /health advertises (the names the supervisor's volume gate matches, with what they are).
func (s *server) modelVolumesHealth() []map[string]any {
	names := make([]string, 0, len(s.ModelVolumes))
	for n := range s.ModelVolumes {
		names = append(names, n)
	}
	sort.Strings(names)
	out := []map[string]any{}
	for _, n := range names {
		v := s.ModelVolumes[n]
		out = append(out, map[string]any{"name": n, "bytes": v.ImageBytes, "backend": v.Preload, "root": v.Root, "pin": v.Pin, "kind": "model"})
	}
	return out
}

// modelRefusal: why a create's volumes cannot be attached here, or "".
func (s *server) modelRefusal(names []string, inference bool, legacy bool) string {
	if len(names) == 0 {
		return ""
	}
	switch {
	case inference:
		return "model volumes beside a Shield inference model: that image carries its own measured model"
	case legacy:
		return "model volumes need this release image, not a legacy guest"
	case len(names) > modelVolumesMax:
		return fmt.Sprintf("more than %d model volumes", modelVolumesMax)
	}
	seen := map[string]bool{}
	for _, n := range names {
		if seen[n] {
			return "a model volume named twice"
		}
		seen[n] = true
		if _, ok := s.ModelVolumes[n]; !ok {
			return fmt.Sprintf("model volume %q: this host's pinned table and store do not carry it", n)
		}
	}
	return ""
}

// writeVolumeAttach writes <image>.volumes for run-domain.sh: "<serial> <path>" per requested volume, in request order.
func (s *server) writeVolumeAttach(image string, names []string) error {
	if len(names) == 0 {
		return nil
	}
	var b strings.Builder
	for _, n := range names {
		v := s.ModelVolumes[n]
		fmt.Fprintf(&b, "%s %s\n", v.Serial(), v.Image)
	}
	return os.WriteFile(image+".volumes", []byte(b.String()), 0o600)
}
