// Measured public-model loader. Copy before verification prevents host block
// mutations after verification from changing the model used inside SNP.
package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"syscall"
	"time"
)

func main() {
	if err := load(); err != nil {
		fmt.Fprintln(os.Stderr, "MODEL ERROR", err)
		os.Exit(1)
	}
}
func load() error {
	const dir = "/models/qwen3.8-27b-mtp-q4-vl-gguf/"
	dest := dir + "model.gguf"
	if _, err := os.Stat("/rt/shield-original-source-reclaim.enabled"); err == nil {
		// initramfs may be ramfs, which cannot punch holes. An explicit PRIVATE
		// tmpfs gives the native loader reclaimable pages without host mappings.
		private := dir + "private"
		if err := os.Mkdir(private, 0755); err != nil {
			return err
		}
		if err := syscall.Mount("tmpfs", private, "tmpfs", syscall.MS_NODEV|syscall.MS_NOSUID, "size=18g,mode=0755"); err != nil {
			return err
		}
		dest = private + "/model.gguf"
		if err := os.Symlink("private/model.gguf", dir+"model.gguf"); err != nil {
			return err
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := copyVerified("/dev/vda", dest, 17559178144, "3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e"); err != nil {
		return err
	}
	// Preserve the published model's filename for existing app configurations.
	// Both names refer to the same verified private copy; no second weights allocation.
	return os.Symlink("model.gguf", dir+"Qwen3.8-27B-UD-Q4_K_XL.gguf")
}

func copyVerified(source, dest string, size int64, expected string) error {
	start := time.Now()
	in, e := os.Open(source)
	if e != nil {
		return e
	}
	defer in.Close()
	out, e := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	h := sha256.New()
	n, e := io.CopyBuffer(io.MultiWriter(out, h), io.LimitReader(in, size), make([]byte, 4<<20))
	ce := out.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	if n != size {
		return fmt.Errorf("short model: %d", n)
	}
	got := fmt.Sprintf("%x", h.Sum(nil))
	if got != expected {
		return fmt.Errorf("hash mismatch: %s", got)
	}
	if e = os.Chmod(dest, 0444); e != nil {
		return e
	}
	fmt.Printf("MODEL verified bytes=%d sha256=%s copy_verify_ms=%d\n", n, got, time.Since(start).Milliseconds())
	return nil
}
