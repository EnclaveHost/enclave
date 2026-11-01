// Measured public-model loader. Copy before verification prevents host block
// mutations after verification from changing the model used inside SNP.
package main

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"
)

func main() {
	if err := load(); err != nil {
		fmt.Fprintln(os.Stderr, "MODEL ERROR", err)
		os.Exit(1)
	}
}

// The model is the one the measured /app.shield profile names; dominit has
// already rejected any other. Every byte loaded is pinned here by size and hash.
func load() error {
	profile, err := os.ReadFile("/app.shield")
	if err != nil {
		return err
	}
	if fields := strings.Fields(string(profile)); len(fields) > 0 && fields[0] == zImageModel {
		return loadZImage()
	}
	return load27B()
}

const zImageModel = "z-image-turbo-q4km-sd"

// EnclaveHost/z-image-turbo-q4km-sd@af89b828ee54af9121ad479170f89f978e4ad628, attached
// read-only in this order. The names are the sdcpp backend's generic component names.
var zImageFiles = []struct {
	device, name string
	size         int64
	sha256       string
}{
	{"/dev/vda", "diffusion.gguf", 4981532736, "745ec270db042409fde084d6b5cfccabf214a7fe5a494edf994a391125656afd"},
	{"/dev/vdb", "llm.gguf", 2497281120, "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"},
	{"/dev/vdc", "vae.safetensors", 335304388, "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"},
}

func loadZImage() error {
	const dir = "/models/" + zImageModel + "/"
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	for _, f := range zImageFiles {
		if err := copyVerified(f.device, dir+f.name, f.size, f.sha256); err != nil {
			return fmt.Errorf("%s: %w", f.name, err)
		}
	}
	return nil
}

func load27B() error {
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
