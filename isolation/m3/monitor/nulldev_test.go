package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The null device a domain's quiet workload gets as its stdio (domexec.c NULL_FD) must BE the null device: the real one
// passes, and a regular file or a missing node refuses the domain (enclave-d1's canary of 4cdd5169: the runtime opened
// /dev/null inside the domain's chroot, which has no /dev, and every m3 domain ended before it served).
func TestTheQuietWorkloadsNullDeviceIsTheNullDevice(t *testing.T) {
	f, err := openNullDevice()
	if err != nil {
		t.Fatalf("the guest's own /dev/null was refused: %v", err)
	}
	f.Close()

	dir := t.TempDir()
	fake := filepath.Join(dir, "null")
	if err := os.WriteFile(fake, nil, 0o666); err != nil {
		t.Fatal(err)
	}
	if f, err := openNullDeviceAt(fake); err == nil || !strings.Contains(err.Error(), "is not the null device") {
		if f != nil {
			f.Close()
		}
		t.Fatalf("a regular file passed for the null device: %v", err)
	}
	if _, err := openNullDeviceAt(filepath.Join(dir, "absent")); err == nil {
		t.Fatal("a missing node passed for the null device")
	}
	if _, err := openNullDeviceAt("/dev/zero"); err == nil || !strings.Contains(err.Error(), "is not the null device") {
		t.Fatalf("another character device (/dev/zero, 1:5) passed for the null device: %v", err)
	}
}
