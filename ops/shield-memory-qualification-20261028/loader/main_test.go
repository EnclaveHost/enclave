package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"syscall"
	"testing"
)

func TestAuthenticatedPrivateCopy(t *testing.T) {
	data := []byte("public model fixture")
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	for _, tc := range []struct {
		name  string
		bytes []byte
		hash  string
		ok    bool
	}{
		{"valid", data, digest, true},
		{"short", data[:3], digest, false},
		{"corrupt", []byte("corrupted model data"), digest, false},
		{"wrong-pin", data, "bad", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := t.TempDir()
			src := filepath.Join(d, "block")
			dst := filepath.Join(d, "private")
			if err := os.WriteFile(src, tc.bytes, 0600); err != nil {
				t.Fatal(err)
			}
			err := copyVerified(src, dst, int64(len(data)), tc.hash)
			if (err == nil) != tc.ok {
				t.Fatalf("unexpected result: %v", err)
			}
			if !tc.ok {
				return
			}
			if err := os.WriteFile(src, []byte("host mutation"), 0600); err != nil {
				t.Fatal(err)
			}
			got, _ := os.ReadFile(dst)
			st, _ := os.Stat(dst)
			if string(got) != string(data) || st.Mode().Perm() != 0444 {
				t.Fatal("private copy changed or remained writable")
			}
			if copyVerified(src, dst, int64(len(data)), tc.hash) == nil {
				t.Fatal("overwrote an existing model")
			}
		})
	}
}

type adviceCall struct{ off, n int64 }

// recordingAdvisor fails the test if advice names any fd other than the
// source, or a range not yet present in the private copy.
func recordingAdvisor(t *testing.T, src, dst string, fail func(i int) error) (sourceAdvisor, *[]adviceCall) {
	t.Helper()
	calls := &[]adviceCall{}
	return func(fd uintptr, off, n int64) error {
		var got, want syscall.Stat_t
		if err := syscall.Fstat(int(fd), &got); err != nil {
			t.Errorf("fstat advised fd: %v", err)
		}
		if err := syscall.Stat(src, &want); err != nil {
			t.Errorf("stat source: %v", err)
		}
		if got.Dev != want.Dev || got.Ino != want.Ino {
			t.Errorf("advice on fd %d, which is not the source", fd)
		}
		source, _ := os.ReadFile(src)
		private, _ := os.ReadFile(dst)
		if off < 0 || n <= 0 || int64(len(private)) < off+n || int64(len(source)) < off+n ||
			!bytes.Equal(private[off:off+n], source[off:off+n]) {
			t.Errorf("advice for [%d,%d) before it was copied", off, off+n)
		}
		*calls = append(*calls, adviceCall{off, n})
		if fail != nil {
			return fail(len(*calls) - 1)
		}
		return nil
	}, calls
}

func pattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i*7 + i>>12)
	}
	return b
}

func openPair(t *testing.T, src, dst string) (*os.File, *os.File) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { in.Close() })
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { out.Close() })
	return in, out
}

func TestDropCacheChunksInOrderWithinModel(t *testing.T) {
	d := t.TempDir()
	src, dst := filepath.Join(d, "block"), filepath.Join(d, "private")
	model := pattern(31)
	device := append(append([]byte{}, model...), "TRAILING DEVICE BYTES"...)
	if err := os.WriteFile(src, device, 0600); err != nil {
		t.Fatal(err)
	}
	in, out := openPair(t, src, dst)
	advise, calls := recordingAdvisor(t, src, dst, nil)
	h := sha256.New()
	n, st, err := copyDroppingSource(in, out, h, int64(len(model)), 8, advise)
	if err != nil || n != 31 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	want := []adviceCall{{0, 8}, {8, 8}, {16, 8}, {24, 7}}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("advice %v, want %v", *calls, want)
	}
	if st.bytes != 31 || st.failures != 0 || st.first != nil {
		t.Fatalf("stats %+v", st)
	}
	got, _ := os.ReadFile(dst)
	if !bytes.Equal(got, model) {
		t.Fatal("private copy differs from model")
	}
	if sum := sha256.Sum256(model); !bytes.Equal(h.Sum(nil), sum[:]) {
		t.Fatal("hash does not cover exactly the model bytes")
	}
}

// Production shape: 4 MiB chunks, final partial page, larger device.
func TestDropCacheProductionChunking(t *testing.T) {
	d := t.TempDir()
	src, dst := filepath.Join(d, "block"), filepath.Join(d, "private")
	size := int64(2*dropCacheChunk + 2976)
	device := pattern(int(size) + 4096)
	model := device[:size]
	if err := os.WriteFile(src, device, 0600); err != nil {
		t.Fatal(err)
	}
	advise, calls := recordingAdvisor(t, src, dst, nil)
	if err := copyVerifiedAdvised(src, dst, size, fmt.Sprintf("%x", sha256.Sum256(model)), advise); err != nil {
		t.Fatal(err)
	}
	want := []adviceCall{{0, dropCacheChunk}, {dropCacheChunk, dropCacheChunk}, {2 * dropCacheChunk, 2976}}
	if !reflect.DeepEqual(*calls, want) {
		t.Fatalf("advice %v, want %v", *calls, want)
	}
	if err := os.WriteFile(src, []byte("host mutation"), 0600); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(dst)
	st, _ := os.Stat(dst)
	if !bytes.Equal(got, model) || st.Mode().Perm() != 0444 {
		t.Fatal("private copy changed or remained writable")
	}
}

func TestDropCacheRejectsWithoutPublishing(t *testing.T) {
	data := []byte("public model fixture")
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	for _, tc := range []struct {
		name  string
		bytes []byte
		hash  string
	}{
		{"short", data[:3], digest},
		{"corrupt", []byte("corrupted model data"), digest},
		{"wrong-pin", data, "bad"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := t.TempDir()
			src, dst := filepath.Join(d, "block"), filepath.Join(d, "private")
			if err := os.WriteFile(src, tc.bytes, 0600); err != nil {
				t.Fatal(err)
			}
			advise, calls := recordingAdvisor(t, src, dst, nil)
			if copyVerifiedAdvised(src, dst, int64(len(data)), tc.hash, advise) == nil {
				t.Fatal("accepted an unauthenticated model")
			}
			if st, err := os.Stat(dst); err == nil && st.Mode().Perm() != 0600 {
				t.Fatal("rejected copy was published read-only")
			}
			if tc.name == "short" && len(*calls) != 0 {
				t.Fatalf("advised a partial chunk: %v", *calls)
			}
		})
	}
}

func TestDropCacheTruncatedSource(t *testing.T) {
	d := t.TempDir()
	src, dst := filepath.Join(d, "block"), filepath.Join(d, "private")
	device := pattern(20)
	if err := os.WriteFile(src, device, 0600); err != nil {
		t.Fatal(err)
	}
	in, out := openPair(t, src, dst)
	advise, calls := recordingAdvisor(t, src, dst, nil)
	n, st, err := copyDroppingSource(in, out, sha256.New(), 29, 8, advise)
	if err != nil || n != 16 {
		t.Fatalf("n=%d err=%v, want short count 16", n, err)
	}
	if want := []adviceCall{{0, 8}, {8, 8}}; !reflect.DeepEqual(*calls, want) || st.bytes != 16 {
		t.Fatalf("advice %v stats %+v, want %v", *calls, st, want)
	}
	if got, _ := os.ReadFile(dst); !bytes.Equal(got, device[:16]) {
		t.Fatal("partial chunk reached the private copy")
	}
}

func TestDropCacheAdviceFailureIsCountedNotFatal(t *testing.T) {
	d := t.TempDir()
	src, dst := filepath.Join(d, "block"), filepath.Join(d, "private")
	model := pattern(29)
	if err := os.WriteFile(src, model, 0600); err != nil {
		t.Fatal(err)
	}
	in, out := openPair(t, src, dst)
	advise, calls := recordingAdvisor(t, src, dst, func(i int) error {
		if i == 1 {
			return syscall.EIO
		}
		return nil
	})
	n, st, err := copyDroppingSource(in, out, sha256.New(), 29, 8, advise)
	if err != nil || n != 29 || len(*calls) != 4 {
		t.Fatalf("n=%d err=%v calls=%v", n, err, *calls)
	}
	if st.failures != 1 || st.bytes != 21 || st.first != syscall.EIO {
		t.Fatalf("stats %+v", st)
	}

	dst2 := filepath.Join(d, "private2")
	always, _ := recordingAdvisor(t, src, dst2, func(int) error { return syscall.EINVAL })
	if err := copyVerifiedAdvised(src, dst2, 29, fmt.Sprintf("%x", sha256.Sum256(model)), always); err != nil {
		t.Fatalf("advice failure refused a verified model: %v", err)
	}
}

func TestDropCacheErrorPathsNeverAdvise(t *testing.T) {
	data := pattern(29)
	digest := fmt.Sprintf("%x", sha256.Sum256(data))
	never := func(uintptr, int64, int64) error {
		t.Error("advice on an error path")
		return nil
	}
	d := t.TempDir()
	src := filepath.Join(d, "block")
	if err := os.WriteFile(src, data, 0600); err != nil {
		t.Fatal(err)
	}
	existing := filepath.Join(d, "existing")
	if err := os.WriteFile(existing, nil, 0600); err != nil {
		t.Fatal(err)
	}
	if copyVerifiedAdvised(src, existing, 29, digest, never) == nil {
		t.Fatal("overwrote an existing model")
	}
	if copyVerifiedAdvised(filepath.Join(d, "missing"), filepath.Join(d, "p1"), 29, digest, never) == nil {
		t.Fatal("accepted a missing source")
	}
	if copyVerifiedAdvised(d, filepath.Join(d, "p2"), 29, digest, never) == nil {
		t.Fatal("accepted an unreadable source")
	}
	// The private write fails, so the chunk must not be advised.
	in, err := os.Open(src)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	ro, err := os.Open(existing)
	if err != nil {
		t.Fatal(err)
	}
	defer ro.Close()
	if _, _, err := copyDroppingSource(in, ro, sha256.New(), 29, 8, never); err == nil {
		t.Fatal("ignored a private write failure")
	}
}

func TestDropCacheMarkerDefaultsOff(t *testing.T) {
	d := t.TempDir()
	marker := filepath.Join(d, "shield-model-drop-cache.enabled")
	if on, err := markerEnabled(marker); on || err != nil {
		t.Fatalf("absent marker: on=%v err=%v", on, err)
	}
	if err := os.WriteFile(marker, []byte("1\n"), 0444); err != nil {
		t.Fatal(err)
	}
	if on, err := markerEnabled(marker); !on || err != nil {
		t.Fatalf("present marker: on=%v err=%v", on, err)
	}
	if _, err := markerEnabled(filepath.Join(marker, "x")); err == nil {
		t.Fatal("ambiguous marker state did not fail closed")
	}
}

// Real syscall on test-owned descriptors only; never a device.
func TestFadviseDontneedSyscall(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "advice")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.Write(pattern(3 * 4096)); err != nil {
		t.Fatal(err)
	}
	if err := fadviseDontneed(f.Fd(), 0, 3*4096); err != nil {
		t.Fatalf("regular file: %v", err)
	}
	if err := fadviseDontneed(^uintptr(0), 0, 4096); err != syscall.EBADF {
		t.Fatalf("bad fd: %v", err)
	}
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	if err := fadviseDontneed(r.Fd(), 0, 4096); err != syscall.ESPIPE {
		t.Fatalf("pipe: %v", err)
	}
}
