package encvol

// The sync the standard runtime gets from `rclone sync SRC DST --transfers 8 --checkers 8 --retries 2 --contimeout 15s
// [--max-transfer NM]`, done natively over the vendored crypt cipher (rclonecrypt) and the store (store.go). It keeps
// rclone's decisions where they change what lands on either side:
//   - an object is transferred when the destination lacks it, its size differs, or its modtime differs (crypt has no
//     hash in common with anything, so a modtime difference is always a transfer; for a plain volume rclone would
//     first compare MD5 and only fix the modtime - here it transfers, which leaves the same bytes and modtime);
//   - extraneous destination files are deleted after the transfers, and NOT when any transfer failed ("not deleting
//     files as there were IO errors"); empty local directories not in the source go too;
//   - under crypt, a name that does not decrypt is skipped and reported ("Skipping undecryptable file name"), which
//     the runtime turns into its wrong-key message; a block that does not authenticate fails that file;
//   - --max-transfer counts the bytes read for transfers and stops everything once they reach the cap
//     (rclone's hard cutoff), and a failed sync is tried once more unless the failure was fatal.

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"sync"
	"time"

	"enclave.host/isolation/m2/encvol/rclonecrypt"
)

const (
	transfers = 8
	retries   = 2
)

var errMaxTransfer = errors.New("max transfer limit reached as set by --max-transfer")

// remote is a volume's far side: the store and, unless the volume is plain, the cipher.
type remote struct {
	st     store
	cipher *rclonecrypt.Cipher // nil = plain
}

type syncResult struct {
	undecryptable int
}

// cappedReader is rclone's accounting check: before every read, the bytes already read must be under the cap.
type cappedReader struct {
	r    io.Reader
	used *int64
	mu   *sync.Mutex
	max  int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	c.mu.Lock()
	if c.max > 0 && *c.used >= c.max {
		c.mu.Unlock()
		return 0, errMaxTransfer
	}
	c.mu.Unlock()
	n, err := c.r.Read(p)
	c.mu.Lock()
	*c.used += int64(n)
	c.mu.Unlock()
	return n, err
}

type remoteEntry struct {
	key  string // the store key (encrypted name under crypt)
	obj  object
	size int64 // plaintext size; -1 = unknown
}

// listRemote lists the far side under plaintext names; under crypt, undecryptable names are counted and skipped.
func (rm *remote) listRemote(ctx context.Context) (map[string]remoteEntry, int, error) {
	objs, err := rm.st.List(ctx)
	if err != nil {
		return nil, 0, err
	}
	out := map[string]remoteEntry{}
	bad := 0
	for _, o := range objs {
		name, size := o.Key, o.Size
		if rm.cipher != nil {
			n, err := rm.cipher.DecryptFileName(o.Key)
			if err != nil {
				bad++
				continue
			}
			name = n
			if s, err := rm.cipher.DecryptedSize(o.Size); err == nil {
				size = s
			} else {
				size = -1
			}
		}
		out[name] = remoteEntry{key: o.Key, obj: o, size: size}
	}
	return out, bad, nil
}

// remoteModTime is the far side's modtime: X-Amz-Meta-Mtime when set (HEAD, as rclone's ModTime does), else the
// listing's LastModified.
func (rm *remote) remoteModTime(ctx context.Context, e remoteEntry) time.Time {
	if e.obj.HasModTime {
		return e.obj.ModTime
	}
	if t, ok, err := rm.st.Head(ctx, e.key); err == nil && ok {
		return t
	}
	return e.obj.ModTime
}

func sameTime(a, b time.Time) bool { return a.Equal(b) } // both sides keep nanoseconds: rclone's window is 1ns

func randTag() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

type firstErr struct {
	mu    sync.Mutex
	err   error
	n     int
	fatal bool
}

func (f *firstErr) add(rel string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.n++
	if errors.Is(err, errMaxTransfer) {
		f.fatal = true
	}
	if f.err == nil {
		f.err = fmt.Errorf("%s: %v", rel, err)
	}
}

func (f *firstErr) result() error {
	if f.err == nil {
		return nil
	}
	if f.fatal {
		return fmt.Errorf("Failed to sync: %v", errMaxTransfer)
	}
	if f.n > 1 {
		return fmt.Errorf("Failed to sync: %v (and %d more errors)", f.err, f.n-1)
	}
	return fmt.Errorf("Failed to sync: %v", f.err)
}

// pull is `rclone sync REMOTE LOCAL [--max-transfer]`.
func pull(ctx context.Context, rm *remote, t tree, maxBytes int64) (syncResult, error) {
	var res syncResult
	var err error
	for attempt := 0; attempt < retries; attempt++ {
		res, err = pullOnce(ctx, rm, t, maxBytes)
		if err == nil || ctx.Err() != nil || errors.Is(err, errMaxTransfer) || strings.Contains(err.Error(), errMaxTransfer.Error()) || res.undecryptable > 0 {
			break
		}
	}
	return res, err
}

func pullOnce(ctx context.Context, rm *remote, t tree, maxBytes int64) (syncResult, error) {
	src, bad, err := rm.listRemote(ctx)
	if err != nil {
		return syncResult{}, fmt.Errorf("Failed to sync: %v", err)
	}
	res := syncResult{undecryptable: bad}
	files, dirs, err := t.walk()
	if err != nil {
		return res, fmt.Errorf("Failed to sync: %v", err)
	}
	have := map[string]localFile{}
	for _, f := range files {
		have[f.Rel] = f
	}
	names := make([]string, 0, len(src))
	for n := range src {
		names = append(names, n)
	}
	sort.Strings(names)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var used int64
	var umu sync.Mutex
	var errs firstErr
	sem := make(chan struct{}, transfers)
	var wg sync.WaitGroup
	for _, n := range names {
		e := src[n]
		if l, ok := have[n]; ok && e.size >= 0 && l.Size == e.size && sameTime(l.ModTime, rm.remoteModTime(ctx, e)) {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(n string, e remoteEntry) {
			defer func() { <-sem; wg.Done() }()
			if err := pullFile(ctx, rm, t, n, e, &cappedReader{used: &used, mu: &umu, max: maxBytes}); err != nil {
				errs.add(n, err)
				if errors.Is(err, errMaxTransfer) {
					cancel()
				}
			}
		}(n, e)
	}
	wg.Wait()
	if err := errs.result(); err != nil {
		return res, err
	}
	// delete what the source does not have (after the transfers, only when they all succeeded)
	keep := map[string]bool{}
	for n := range src {
		for d := path.Dir(n); d != "." && d != "/"; d = path.Dir(d) {
			keep[d] = true
		}
	}
	for _, f := range files {
		if _, ok := src[f.Rel]; !ok {
			if err := t.remove(f.Rel); err != nil {
				errs.add(f.Rel, err)
			}
		}
	}
	var drop []string
	for d := range dirs {
		if !keep[d] {
			drop = append(drop, d)
		}
	}
	sort.Slice(drop, func(i, j int) bool { return len(drop[i]) > len(drop[j]) }) // deepest first
	for _, d := range drop {
		t.rmdirIfEmpty(d)
	}
	return res, errs.result()
}

func pullFile(ctx context.Context, rm *remote, t tree, rel string, e remoteEntry, cr *cappedReader) error {
	body, mt, ok, err := rm.st.Get(ctx, e.key)
	if err != nil {
		return err
	}
	defer body.Close()
	if !ok {
		mt = e.obj.ModTime
	}
	var r io.ReadCloser = body
	if rm.cipher != nil {
		dr, err := rm.cipher.DecryptData(body)
		if err != nil {
			return err
		}
		defer dr.Close()
		r = dr
	}
	cr.r = r
	n, err := t.writeFile(rel, cr, mt, randTag())
	if err != nil {
		return err
	}
	if e.size >= 0 && n != e.size {
		t.remove(rel)
		return fmt.Errorf("corrupted on transfer: sizes differ %d vs %d", e.size, n)
	}
	return nil
}

// push is `rclone sync LOCAL REMOTE` (no cap: the volume's own cap bounds what there is).
func push(ctx context.Context, rm *remote, t tree) (syncResult, error) {
	var res syncResult
	var err error
	for attempt := 0; attempt < retries; attempt++ {
		res, err = pushOnce(ctx, rm, t)
		if err == nil || ctx.Err() != nil {
			break
		}
	}
	return res, err
}

func pushOnce(ctx context.Context, rm *remote, t tree) (syncResult, error) {
	files, _, err := t.walk()
	if err != nil {
		return syncResult{}, fmt.Errorf("Failed to sync: %v", err)
	}
	dst, bad, err := rm.listRemote(ctx)
	if err != nil {
		return syncResult{}, fmt.Errorf("Failed to sync: %v", err)
	}
	res := syncResult{undecryptable: bad}
	src := map[string]bool{}
	var errs firstErr
	sem := make(chan struct{}, transfers)
	var wg sync.WaitGroup
	for _, f := range files {
		src[f.Rel] = true
		if e, ok := dst[f.Rel]; ok && e.size >= 0 && e.size == f.Size && sameTime(f.ModTime, rm.remoteModTime(ctx, e)) {
			continue
		}
		sem <- struct{}{}
		wg.Add(1)
		go func(f localFile, old remoteEntry, had bool) {
			defer func() { <-sem; wg.Done() }()
			if err := pushFile(ctx, rm, t, f, old, had); err != nil {
				errs.add(f.Rel, err)
			}
		}(f, dst[f.Rel], dst[f.Rel].key != "")
	}
	wg.Wait()
	if err := errs.result(); err != nil {
		return res, err
	}
	for n, e := range dst {
		if !src[n] {
			if err := rm.st.Delete(ctx, e.key); err != nil {
				errs.add(n, err)
			}
		}
	}
	return res, errs.result()
}

func pushFile(ctx context.Context, rm *remote, t tree, f localFile, old remoteEntry, had bool) error {
	key := f.Rel
	size := f.Size
	var n [rclonecrypt.NonceSize]byte
	if rm.cipher != nil {
		key = rm.cipher.EncryptFileName(f.Rel)
		size = rm.cipher.EncryptedSize(f.Size)
		if _, err := rand.Read(n[:]); err != nil {
			return err
		}
	}
	var open []io.Closer
	defer func() {
		for _, c := range open {
			c.Close()
		}
	}()
	body := func() (io.Reader, error) {
		fh, sz, err := t.openRead(f.Rel)
		if err != nil {
			return nil, err
		}
		open = append(open, fh)
		if sz != f.Size {
			return nil, fmt.Errorf("can't copy - source file is being updated (size changed from %d to %d)", f.Size, sz)
		}
		var r io.Reader = io.LimitReader(fh, f.Size)
		if rm.cipher != nil {
			return rm.cipher.EncryptDataNonce(r, n)
		}
		return r, nil
	}
	if err := rm.st.Put(ctx, key, body, size, f.ModTime); err != nil {
		return err
	}
	// a re-encrypted name can differ from the old object's (obfuscate/standard are deterministic, so only a key that
	// listed under another spelling, e.g. a version suffix, is left behind): drop it, as rclone's replace would
	if had && old.key != key {
		return rm.st.Delete(ctx, old.key)
	}
	return nil
}
