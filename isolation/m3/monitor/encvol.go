package main

// Encrypted volumes (the measured config's encVolumes; isolation/m2/encvol) in a partition domain. The front holds the
// key, the plane and the engine, but is not root; so the MONITOR stages each volume from the measured config, before
// the domain's first instruction:
//   - only in a SECRET domain (its front alone has egress, to the volume's S3 endpoint); anywhere else it is refused,
//     never dropped - the app is not started without its mounts;
//   - one tmpfs per volume at <domain>/enc/<name>, sized spec.TmpfsMiB (its cap and a little headroom), owned by the
//     runtime's uid and group, setgid, 02770: the front reaches it through the group domexec gives it;
//   - every volume's tmpfs counts against the domain's memory: the version's memory must hold them all plus
//     spec.GuestReserveMiB, or the load is refused;
//   - a root-owned, read-only /enc.volumes names them, one per line, for the front and secretrun to agree with.

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"enclave.host/isolation/m2/encvol/spec"
)

const encMarkerName = "enc.volumes"

// stageEncVolumes stages d's volumes and records their mount points for reclaim. No encVolumes: nothing.
func stageEncVolumes(d *domain, mount func(dir string, sizeMiB, uid int) error) error {
	specs, err := spec.ParseLayout(string(d.AppConfig))
	if err != nil {
		return err
	}
	if len(specs) == 0 {
		return nil
	}
	if d.SecretDeployment == "" {
		return errors.New("encrypted volumes need a secret domain on this tier: only its front has egress to the volume's S3 endpoint")
	}
	need := 0
	for _, s := range specs {
		need += spec.TmpfsMiB(s.MaxMB)
	}
	if need+spec.GuestReserveMiB > d.MemMiB {
		return fmt.Errorf("encrypted volumes need %d MiB of the domain's %d MiB (each is held in memory; %d MiB stays for the runtime and app)",
			need, d.MemMiB, spec.GuestReserveMiB)
	}
	root := filepath.Join(d.dir, "enc")
	if err := os.Mkdir(root, 0o755); err != nil {
		return err
	}
	var marker strings.Builder
	for _, s := range specs {
		mp := filepath.Join(root, s.Name)
		if err := os.Mkdir(mp, 0o700); err != nil {
			return err
		}
		if err := mount(mp, spec.TmpfsMiB(s.MaxMB), d.UID); err != nil {
			return fmt.Errorf("encrypted volume %s: %w", s.Name, err)
		}
		d.encMounts = append(d.encMounts, mp)
		marker.WriteString(s.Name + "\n")
	}
	return os.WriteFile(filepath.Join(d.dir, encMarkerName), []byte(marker.String()), 0o444)
}

func tmpfsVolume(dir string, sizeMiB, uid int) error {
	return syscall.Mount("tmpfs", dir, "tmpfs", syscall.MS_NOSUID|syscall.MS_NODEV|syscall.MS_NOEXEC,
		fmt.Sprintf("size=%dm,mode=2770,uid=%d,gid=%d", sizeMiB, uid, uid))
}
