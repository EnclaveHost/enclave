//go:build linux && amd64

package main

// The monitor's model-volume code against a REAL kernel: this test binary is PID 1 of a throwaway QEMU/KVM guest
// (isolation/m3/test-modelvol-qemu.sh) whose disks are SCSI (sd*, as Hyper-V's storvsc presents them). It loads the
// device-mapper modules as the partition's init does, then stages a domain's volume exactly as a load does:
// newModelMounts over the measured table, the disk found by its hash tree, /mverity, the read-only ext4 mount, the
// read-only bind into the domain, the marker. Every outcome is one "MVTEST ..." console line; the guest then powers
// off. Skipped anywhere else.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"unsafe"
)

const sysFinitModule = 313 // linux/amd64; not in package syscall's table

func TestModelVolumesOnARealKernel(t *testing.T) {
	if os.Getenv("MVQEMU") == "" || os.Getpid() != 1 {
		t.Skip("runs only as PID 1 of the guest isolation/m3/test-modelvol-qemu.sh boots")
	}
	defer func() {
		fmt.Println("MVTEST end")
		syscall.Sync()
		syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	}()
	for _, m := range [][3]string{{"proc", "/proc", "proc"}, {"sysfs", "/sys", "sysfs"}, {"devtmpfs", "/dev", "devtmpfs"}, {"tmpfs", "/tmp", "tmpfs"}} {
		os.MkdirAll(m[1], 0o755)
		syscall.Mount(m[0], m[1], m[2], 0, "")
	}
	for _, ko := range []string{"/dm-mod.ko.zst", "/dm-bufio.ko.zst", "/reed_solomon.ko.zst", "/dm-verity.ko.zst"} {
		f, err := os.Open(ko)
		if err != nil {
			fmt.Printf("MVTEST insmod %s: %v\n", ko, err)
			continue
		}
		params := []byte{0} // no module parameters; 4 = MODULE_INIT_COMPRESSED_FILE
		if _, _, e := syscall.Syscall(sysFinitModule, f.Fd(), uintptr(unsafe.Pointer(&params[0])), 4); e != 0 && e != syscall.EEXIST {
			fmt.Printf("MVTEST insmod %s: %v\n", ko, e)
		}
		f.Close()
	}
	mm := newModelMounts("/plat")
	d := &domain{AppConfig: []byte(`{"volumes":["fixture-a"]}`), dir: "/domains/1"}
	os.MkdirAll(d.dir, 0o755)
	if err := stageModelVolumes(d, mm, bindReadOnly); err != nil {
		fmt.Printf("MVTEST refused: %v\n", err)
		return
	}
	marker, _ := os.ReadFile(filepath.Join(d.dir, modelMarkerName))
	fmt.Printf("MVTEST staged marker=%q\n", marker)
	at := filepath.Join(d.dir, "models", "fixture-a")
	var st syscall.Statfs_t
	if syscall.Statfs(at, &st) == nil {
		fmt.Printf("MVTEST bound ro=%v\n", st.Flags&0x1 != 0) // ST_RDONLY
	}
	f, err := os.Open(filepath.Join(at, "payload.bin"))
	if err != nil {
		fmt.Printf("MVTEST read-failed open: %v\n", err)
		return
	}
	h := sha256.New()
	n, err := io.Copy(h, f)
	f.Close()
	if err != nil {
		fmt.Printf("MVTEST read-failed after %d bytes: %v\n", n, err)
	} else {
		fmt.Printf("MVTEST read %d bytes sha256=%s\n", n, hex.EncodeToString(h.Sum(nil)))
	}
	_, werr := os.OpenFile(filepath.Join(at, "payload.bin"), os.O_WRONLY, 0)
	fmt.Printf("MVTEST write-refused=%v\n", werr != nil && os.IsPermission(werr) || isEROFS(werr))
	_, cerr := os.Create(filepath.Join(at, "new-file"))
	fmt.Printf("MVTEST create-refused=%v\n", isEROFS(cerr))
}

func isEROFS(err error) bool {
	pe, ok := err.(*os.PathError)
	return ok && pe.Err == syscall.EROFS
}
