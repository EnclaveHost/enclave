package main

// Model volumes (the measured config's "volumes", as the shared runtime reads them) in a partition domain.
//
// What a name IS comes from the platform tree's measured table (<plat>/rt/model-volumes.table, pinned when the image
// was built; isolation/m2/modelspec): its dm-verity root, salt and geometry. The host only attaches disks (a Hyper-V
// partition: SCSI, windows/vbslike/manager wmi-launcher.mjs; QEMU: virtio), and says nothing about which disk is which:
// the monitor takes the attached disk of the volume's exact size whose hash tree hashes to the PINNED root
// (modelspec.HoldsRoot), brings dm-verity up over it against that root (/mverity, isolation/m2/mverity.h) and mounts
// ext4 read-only, nodev, nosuid, noexec at /models/<name>, once per partition. Every block a domain then reads is
// verified against the root; a disk swapped or altered after the match fails at the read, never returns other bytes.
//
// A domain gets exactly the volumes its measured config names, bind-mounted read-only at <domain>/models/<name>, and a
// root-owned, read-only /model.volumes (modelspec.M1) for domexec, which adds the preopens, the env names and, when the
// runtime carries wasi-nn with ggml, the preloads (isolation/m2/modelvol.h, the per-app guest's own code). Refused, the
// domain never started, never a silent drop: a config naming volumes on an image without the table, a name the table
// lacks, a volume whose disk is not attached (or does not verify), more than modelspec.Max, and a Shield inference
// domain (its image carries its own measured model).

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"enclave.host/isolation/m2/modelspec"
)

const (
	modelTableName  = "rt/model-volumes.table" // under the platform tree
	modelMarkerName = "model.volumes"          // in the domain's root, for domexec
)

type modelMounts struct {
	mu      sync.Mutex
	table   map[string]modelspec.Entry // nil: this image carries no table
	bad     error                      // the table is present and malformed: every volume is refused
	mounted map[string]string          // name -> its verified read-only mount
	claimed map[string]string          // disk -> the volume it carries

	sysBlock, dev, root string
	wait                time.Duration // how long a load waits for a volume's disk to appear (SCSI scans are asynchronous)
	setup               func(mapName, disk string, e modelspec.Entry) (string, error)
	mount               func(node, at string) error
}

func newModelMounts(plat string) *modelMounts {
	mm := &modelMounts{mounted: map[string]string{}, claimed: map[string]string{}, sysBlock: "/sys/block", dev: "/dev", root: "/models",
		wait: 20 * time.Second, setup: verityByHelper("/mverity"), mount: mountVerifiedRO}
	t, err := modelspec.ReadTable(filepath.Join(plat, modelTableName))
	switch {
	case err == nil:
		mm.table = t
		fmt.Printf("MON model volumes: the measured table carries %d\n", len(t))
	case !errors.Is(err, os.ErrNotExist):
		mm.bad = err
		fmt.Printf("MON ERROR model volumes: %v; a domain naming any is refused\n", err)
	}
	return mm
}

// verityByHelper runs the measured dm-verity helper (metal/guest/mverity.c over isolation/m2/mverity.h): the table is
// built from the PINNED entry only, and the helper prints the node it made.
func verityByHelper(helper string) func(string, string, modelspec.Entry) (string, error) {
	return func(mapName, disk string, e modelspec.Entry) (string, error) {
		out, err := exec.Command(helper, mapName, disk, "4096", "4096", strconv.FormatInt(e.DataBlocks, 10),
			strconv.FormatInt(e.HashStart, 10), "sha256", e.Root, e.Salt).Output()
		if err != nil {
			return "", fmt.Errorf("dm-verity: %w", err)
		}
		return strings.TrimSpace(string(out)), nil
	}
}

func mountVerifiedRO(node, at string) error {
	return syscall.Mount(node, at, "ext4", syscall.MS_RDONLY|syscall.MS_NODEV|syscall.MS_NOSUID|syscall.MS_NOEXEC, "")
}

// findDisk: an unclaimed disk of the entry's exact size holding its hash tree, or "".
func (mm *modelMounts) findDisk(e modelspec.Entry) string {
	ents, _ := os.ReadDir(mm.sysBlock)
	names := []string{}
	for _, de := range ents {
		n := de.Name()
		if (strings.HasPrefix(n, "sd") || strings.HasPrefix(n, "vd")) && mm.claimed[n] == "" {
			names = append(names, n)
		}
	}
	sort.Strings(names)
	for _, n := range names {
		raw, err := os.ReadFile(filepath.Join(mm.sysBlock, n, "size")) // 512-byte sectors
		if err != nil {
			continue
		}
		sectors, err := strconv.ParseInt(strings.TrimSpace(string(raw)), 10, 64)
		if err != nil || sectors*512 != e.ImageBytes {
			continue
		}
		f, err := os.Open(filepath.Join(mm.dev, n))
		if err != nil {
			continue
		}
		ok := modelspec.HoldsRoot(f, e)
		f.Close()
		if ok {
			return n
		}
	}
	return ""
}

// ensure mounts name once per partition and returns where.
func (mm *modelMounts) ensure(name string) (string, error) {
	mm.mu.Lock()
	defer mm.mu.Unlock()
	if at, ok := mm.mounted[name]; ok {
		return at, nil
	}
	e, ok := mm.table[name]
	if !ok {
		return "", fmt.Errorf("model volume %q is not one this image's measured table carries", name)
	}
	disk := ""
	for deadline := time.Now().Add(mm.wait); ; time.Sleep(200 * time.Millisecond) {
		if disk = mm.findDisk(e); disk != "" || time.Now().After(deadline) {
			break
		}
	}
	if disk == "" {
		return "", fmt.Errorf("model volume %q: no attached disk holds its pinned hash tree", name)
	}
	node, err := mm.setup("mv-"+name, filepath.Join(mm.dev, disk), e)
	if err != nil {
		return "", fmt.Errorf("model volume %q: %w", name, err)
	}
	mm.claimed[disk] = name
	at := filepath.Join(mm.root, name)
	if err := os.MkdirAll(at, 0o755); err != nil {
		return "", err
	}
	// a disk whose superblock does not verify fails here, through the verity device
	if err := mm.mount(node, at); err != nil {
		return "", fmt.Errorf("model volume %q: read-only mount over dm-verity: %w", name, err)
	}
	mm.mounted[name] = at
	fmt.Printf("MON model volume %s verified on %s (root %s) and mounted read-only\n", name, disk, e.Root[:16])
	return at, nil
}

// stageModelVolumes gives d the volumes its measured config names, or refuses it. No volumes: nothing.
func stageModelVolumes(d *domain, mm *modelMounts, bind func(src, dst string) error) error {
	names := modelspec.ConfigVolumes(string(d.AppConfig))
	if len(names) == 0 {
		return nil
	}
	switch {
	case d.Inference != nil:
		return errors.New("the config names model volumes, and a Shield inference domain carries its own measured model: the app is not started without its volumes")
	case len(names) > modelspec.Max:
		return fmt.Errorf("the config names %d model volumes; a domain mounts at most %d", len(names), modelspec.Max)
	case mm == nil || mm.bad != nil:
		return errors.New("the config names model volumes, and this image's model-volume table is malformed")
	case mm.table == nil:
		return errors.New("the config names model volumes, and this image carries no model-volume table: the app is not started without its volumes")
	}
	for _, n := range names {
		if !modelspec.NameRE.MatchString(n) {
			return fmt.Errorf("model volume %q is not one this image's measured table carries", n)
		}
	}
	for _, n := range names {
		src, err := mm.ensure(n)
		if err != nil {
			return err
		}
		dst := filepath.Join(d.dir, "models", n)
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		if err := bind(src, dst); err != nil {
			return fmt.Errorf("model volume %s: %w", n, err)
		}
		d.modelMounts = append(d.modelMounts, dst)
	}
	return os.WriteFile(filepath.Join(d.dir, modelMarkerName), modelspec.M1(names), 0o444)
}

func bindReadOnly(src, dst string) error {
	if err := syscall.Mount(src, dst, "", syscall.MS_BIND, ""); err != nil {
		return err
	}
	return syscall.Mount("", dst, "", syscall.MS_BIND|syscall.MS_REMOUNT|syscall.MS_RDONLY|syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC, "")
}
