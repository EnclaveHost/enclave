package main

// The catalog mapping store: how a catalog version (an IPFS CID) becomes the contract bundle a guest runs, once,
// verifiably, and immutably.
//
//	store/components/<sha256>        the component bytes, verified against the CID by the platform's own CAR
//	                                 verifier (wasm/ipfs_fetch.py) before they are ever written here
//	store/bundles/<appId>.bundle     catalog.DeriveBundle of those bytes under the record
//	store/mappings/<recordSha256>.json  the mapping: record, component sha, AppID. WRITTEN LAST: it is the commit
//	                                 point, so a crash between writes leaves content files but no mapping, and the
//	                                 next resolve derives again and finds them byte-identical
//
// Every file is write-once: an existing file must be byte-identical to what would be written, or the write is a
// conflict and refused - a mapping never changes after it exists. Every READ is verified again: the bundle must
// hash to its AppID, parse, carry the recorded component, and re-derive to exactly the stored bundle. A stored file
// that fails is QUARANTINED and the request refused, so tampering is surfaced rather than silently healed; the
// next request derives afresh from verified bytes.
//
// One fetch per record however many callers race for it (singleflight), and no negative caching: a failed
// prefetch leaves nothing behind and the next attempt starts clean - the supervisor owns the backoff.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"enclave.host/isolation/contract"
	"enclave.host/isolation/contract/catalog"
)

// MaxComponentBytes bounds a fetch; the CAR verifier enforces it while reconstructing.
const MaxComponentBytes = 64 << 20

type Fetcher interface {
	// Fetch returns the file bytes the CID names, verified against it, or an error. Never unverified bytes.
	Fetch(ctx context.Context, cid string, max int) ([]byte, error)
}

// storeErr carries the HTTP status the refusal deserves: 422 for anything wrong with the request or the bytes,
// 502 for a fetch that could not produce verified bytes, 409 for a stored file that disagrees with the rule.
type storeErr struct {
	code int
	msg  string
}

func (e *storeErr) Error() string { return e.msg }

func refuse(code int, f string, a ...any) error { return &storeErr{code, fmt.Sprintf(f, a...)} }

type flight struct {
	done   chan struct{}
	m      catalog.Mapping
	bundle []byte
	err    error
}

type store struct {
	dir       string
	F         Fetcher
	RuntimeID string // this host's RuntimeID, hex: a record pinned to another runtime is refused
	mu        sync.Mutex
	inflight  map[string]*flight
	fetches   atomic.Int64
}

func newStore(dir string, f Fetcher, runtimeID string) (*store, error) {
	for _, d := range []string{"components", "bundles", "mappings", "quarantine"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o700); err != nil {
			return nil, err
		}
	}
	return &store{dir: dir, F: f, RuntimeID: runtimeID, inflight: map[string]*flight{}}, nil
}

// resolve returns the mapping and bundle for a record, deriving (and fetching) it at most once however many
// callers ask at the same time.
func (s *store) resolve(ctx context.Context, rec catalog.Derivation) (catalog.Mapping, []byte, error) {
	if err := rec.Validate(); err != nil {
		return catalog.Mapping{}, nil, refuse(422, "derivation record refused: %v", err)
	}
	if rec.RuntimeID != s.RuntimeID {
		return catalog.Mapping{}, nil, refuse(422, "the mapping is pinned to runtime %s…, and this host runs %s…",
			rec.RuntimeID[:16], s.RuntimeID[:min(16, len(s.RuntimeID))])
	}
	d, err := rec.Digest()
	if err != nil {
		return catalog.Mapping{}, nil, refuse(422, "%v", err)
	}
	key := hex.EncodeToString(d[:])
	s.mu.Lock()
	if f, ok := s.inflight[key]; ok {
		s.mu.Unlock()
		select {
		case <-f.done:
			return f.m, f.bundle, f.err
		case <-ctx.Done():
			return catalog.Mapping{}, nil, ctx.Err()
		}
	}
	f := &flight{done: make(chan struct{})}
	s.inflight[key] = f
	s.mu.Unlock()
	f.m, f.bundle, f.err = s.resolveOnce(ctx, rec, key)
	close(f.done)
	s.mu.Lock()
	delete(s.inflight, key)
	s.mu.Unlock()
	return f.m, f.bundle, f.err
}

func (s *store) path(kind, name string) string { return filepath.Join(s.dir, kind, name) }

func (s *store) resolveOnce(ctx context.Context, rec catalog.Derivation, key string) (catalog.Mapping, []byte, error) {
	mp := s.path("mappings", key+".json")
	if _, err := os.Stat(mp); err == nil {
		return s.load(rec, key)
	}
	s.fetches.Add(1)
	comp, err := s.F.Fetch(ctx, rec.CID, MaxComponentBytes)
	if err != nil {
		return catalog.Mapping{}, nil, refuse(502, "prefetch of %s failed, and nothing was stored: %v", rec.CID, err)
	}
	m, bundle, err := catalog.Map(rec, comp)
	if err != nil {
		return catalog.Mapping{}, nil, refuse(422, "%s is not derivable: %v", rec.CID, err)
	}
	mj, err := contract.Canonical(m)
	if err != nil {
		return catalog.Mapping{}, nil, refuse(500, "%v", err)
	}
	// content first, the mapping last: the mapping is what makes the others reachable
	for _, w := range []struct {
		p string
		b []byte
	}{
		{s.path("components", m.ComponentSha256), comp},
		{s.path("bundles", m.AppID+".bundle"), bundle},
		{mp, mj},
	} {
		if err := s.writeOnce(w.p, w.b); err != nil {
			return catalog.Mapping{}, nil, err
		}
	}
	return m, bundle, nil
}

// load reads a stored mapping and verifies all of it again, against the rule and not merely against itself.
func (s *store) load(rec catalog.Derivation, key string) (catalog.Mapping, []byte, error) {
	mp := s.path("mappings", key+".json")
	var m catalog.Mapping
	raw, err := os.ReadFile(mp)
	if err == nil {
		err = json.Unmarshal(raw, &m)
	}
	if err != nil || m.RecordSha256 != key || m.Record != rec {
		return s.quarantine(fmt.Sprintf("mapping %s does not describe its own record", key[:16]), mp)
	}
	bp := s.path("bundles", m.AppID+".bundle")
	bundle, err := os.ReadFile(bp)
	if err != nil {
		return s.quarantine(fmt.Sprintf("the bundle for AppID %s… is missing", m.AppID[:16]), mp)
	}
	if id := contract.AppID(bundle); hex.EncodeToString(id[:]) != m.AppID {
		return s.quarantine(fmt.Sprintf("the stored bundle no longer hashes to AppID %s…", m.AppID[:16]), mp, bp)
	}
	_, comp, err := contract.Parse(bundle)
	if err != nil {
		return s.quarantine("the stored bundle no longer parses: "+err.Error(), mp, bp)
	}
	again, rebuilt, err := catalog.Map(rec, comp)
	if err != nil || again != m || !bytes.Equal(rebuilt, bundle) {
		return s.quarantine("the stored mapping does not re-derive under the rule", mp, bp)
	}
	return m, bundle, nil
}

// quarantine moves the offending files aside and refuses. They are kept, not deleted: they are evidence.
func (s *store) quarantine(why string, paths ...string) (catalog.Mapping, []byte, error) {
	stamp := time.Now().UTC().Format("20060102T150405.000000000")
	for _, p := range paths {
		_ = os.Rename(p, s.path("quarantine", stamp+"-"+filepath.Base(p)))
	}
	return catalog.Mapping{}, nil, refuse(409, "%s; quarantined, and this request refused - the next one derives afresh", why)
}

// writeOnce creates path with exactly b, or finds it already holding exactly b. An existing file with other
// contents is never replaced: it is QUARANTINED as evidence and this request refused, exactly as a failed read is,
// so the next request writes afresh from verified bytes instead of failing on the same bad file forever. A racing
// writer is handled by the link, which cannot replace an existing name.
func (s *store) writeOnce(path string, b []byte) error {
	if cur, err := os.ReadFile(path); err == nil {
		if bytes.Equal(cur, b) {
			return nil
		}
		_, _, qerr := s.quarantine(fmt.Sprintf("immutable %s exists with different contents", filepath.Base(path)), path)
		return qerr
	}
	n := make([]byte, 8)
	_, _ = rand.Read(n)
	tmp := path + ".tmp-" + hex.EncodeToString(n)
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o400)
	if err != nil {
		return err
	}
	_, err = f.Write(b)
	if err == nil {
		err = f.Sync()
	}
	f.Close()
	defer os.Remove(tmp)
	if err != nil {
		return err
	}
	if err := os.Link(tmp, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return s.writeOnce(path, b) // someone else won the race: it must have written the same bytes
		}
		return err
	}
	return nil
}

// componentSha is a helper for callers that hold component bytes.
func componentSha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }
