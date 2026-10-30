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
	// The marker is part of the measured runtime, never app configuration.
	// It only changes source page-cache residency; the copy and pin are unchanged.
	dropCache, err := markerEnabled("/rt/shield-model-drop-cache.enabled")
	if err != nil {
		return err
	}
	var advise sourceAdvisor
	if dropCache {
		advise = fadviseDontneed
	}
	if err := copyVerifiedAdvised("/dev/vda", dest, 17559178144, "3f227079003add2511437e5b1e94812e363385225bf6a9b47b0054a72bc8b01e", advise); err != nil {
		return err
	}
	// Preserve the published model's filename for existing app configurations.
	// Both names refer to the same verified private copy; no second weights allocation.
	return os.Symlink("model.gguf", dir+"Qwen3.8-27B-UD-Q4_K_XL.gguf")
}

func markerEnabled(path string) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return true, nil
	} else if os.IsNotExist(err) {
		return false, nil
	} else {
		return false, err
	}
}

// Source chunk after which clean /dev/vda page cache is dropped. Same as the
// legacy copy buffer, so the private copy's write pattern is unchanged.
const dropCacheChunk = 4 << 20

// sourceAdvisor drops clean source page cache in [off, off+n) of fd. It is
// only called for source bytes already written to the private copy and
// hashed, and never for the private destination.
type sourceAdvisor func(fd uintptr, off, n int64) error

type adviceStats struct {
	bytes    int64 // bytes for which advice was accepted; not bytes reclaimed
	failures int
	first    error
}

func copyVerified(source, dest string, size int64, expected string) error {
	return copyVerifiedAdvised(source, dest, size, expected, nil)
}

// copyVerifiedAdvised with a nil advise is the legacy copy, unchanged.
func copyVerifiedAdvised(source, dest string, size int64, expected string, advise sourceAdvisor) error {
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
	var n int64
	var st adviceStats
	if advise == nil {
		n, e = io.CopyBuffer(io.MultiWriter(out, h), io.LimitReader(in, size), make([]byte, 4<<20))
	} else {
		n, st, e = copyDroppingSource(in, out, h, size, dropCacheChunk, advise)
	}
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
	if advise == nil {
		fmt.Printf("MODEL verified bytes=%d sha256=%s copy_verify_ms=%d\n", n, got, time.Since(start).Milliseconds())
		return nil
	}
	fmt.Printf("MODEL verified bytes=%d sha256=%s copy_verify_ms=%d source_dontneed_advised_bytes=%d source_dontneed_failures=%d\n",
		n, got, time.Since(start).Milliseconds(), st.bytes, st.failures)
	if st.first != nil {
		fmt.Fprintln(os.Stderr, "MODEL source advice failed (non-fatal):", st.first)
	}
	return nil
}

// copyDroppingSource copies exactly the first size bytes of in to out and h,
// one chunk at a time: pread source into a private buffer, write the private
// copy, hash, then advise the source range. Bytes are never interpreted, and
// nothing past size is read or advised. A short source returns the bytes
// copied with a nil error so the caller reports a short model, as before.
//
// Advice failure is counted, not fatal: integrity rests only on the private
// copy and the whole-file digest, which advice cannot change. DONTNEED never
// discards dirty pages; the kernel starts their writeback and skips them.
func copyDroppingSource(in, out *os.File, h io.Writer, size int64, chunk int, advise sourceAdvisor) (int64, adviceStats, error) {
	var st adviceStats
	fd := in.Fd()
	buf := make([]byte, chunk)
	var off int64
	for off < size {
		want := int64(chunk)
		if size-off < want {
			want = size - off
		}
		// ReadAt retries short reads and EINTR, and errors whenever it
		// returns fewer bytes. A partial chunk is neither copied nor advised.
		r, e := in.ReadAt(buf[:want], off)
		if e == io.EOF {
			return off, st, nil
		}
		if e != nil {
			return off, st, e
		}
		if _, e = out.Write(buf[:r]); e != nil {
			return off, st, e
		}
		h.Write(buf[:r])
		if e = advise(fd, off, int64(r)); e != nil {
			st.failures++
			if st.first == nil {
				st.first = e
			}
		} else {
			st.bytes += int64(r)
		}
		off += int64(r)
	}
	return off, st, nil
}
