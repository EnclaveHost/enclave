package rtu

// HARNESS ADDITION (not from indexd): a disk-backed rhp4.Sectors store for the fixture hosts. It is the
// coreutils testutil.EphemeralSectorStore with each sector's bytes in a file under the work disk instead of RAM,
// so a dozen hosts holding 4 MiB sectors stay inside the harness's memory budget. Proofs are built exactly as the
// ephemeral store builds them, from the stored bytes.

import (
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	proto4 "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	rhp4 "go.sia.tech/coreutils/rhp/v4"
)

// DiskSectorStore keeps each sector in <dir>/<root>.sector.
type DiskSectorStore struct {
	dir string

	mu          sync.Mutex
	expirations map[types.Hash256]uint64
}

var _ rhp4.Sectors = (*DiskSectorStore)(nil)

// NewDiskSectorStore creates the store's directory (which must not exist yet).
func NewDiskSectorStore(dir string) (*DiskSectorStore, error) {
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		return nil, err
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return nil, err
	}
	return &DiskSectorStore{dir: dir, expirations: make(map[types.Hash256]uint64)}, nil
}

func (ds *DiskSectorStore) path(root types.Hash256) string {
	return filepath.Join(ds.dir, hex.EncodeToString(root[:])+".sector")
}

// HasSector reports whether the sector is stored.
func (ds *DiskSectorStore) HasSector(root types.Hash256) (bool, error) {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	_, ok := ds.expirations[root]
	return ok, nil
}

// StoreSector writes the sector to its file (create, write, rename).
func (ds *DiskSectorStore) StoreSector(root types.Hash256, sector *[proto4.SectorSize]byte, _ []types.Hash256, expiration uint64) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if _, ok := ds.expirations[root]; ok {
		ds.expirations[root] = max(ds.expirations[root], expiration)
		return nil
	}
	tmp := ds.path(root) + ".part"
	if err := os.WriteFile(tmp, sector[:], 0o600); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, ds.path(root)); err != nil {
		os.Remove(tmp)
		return err
	}
	ds.expirations[root] = expiration
	return nil
}

// ReadSector reads a segment of a sector and its proof.
func (ds *DiskSectorStore) ReadSector(root types.Hash256, offset, length uint64) ([]byte, []types.Hash256, error) {
	switch {
	case offset >= proto4.SectorSize:
		return nil, nil, fmt.Errorf("offset exceeds sector size")
	case length > proto4.SectorSize:
		return nil, nil, fmt.Errorf("length exceeds sector size")
	case length > proto4.SectorSize-offset:
		return nil, nil, fmt.Errorf("read exceeds sector size")
	case offset%proto4.LeafSize != 0 || length%proto4.LeafSize != 0:
		return nil, nil, fmt.Errorf("offset and length must be multiples of leaf size")
	}
	ds.mu.Lock()
	_, ok := ds.expirations[root]
	ds.mu.Unlock()
	if !ok {
		return nil, nil, proto4.ErrSectorNotFound
	}
	raw, err := os.ReadFile(ds.path(root))
	if err != nil {
		return nil, nil, err
	} else if len(raw) != proto4.SectorSize {
		return nil, nil, fmt.Errorf("sector file has %d bytes", len(raw))
	}
	sector := (*[proto4.SectorSize]byte)(raw)
	start, end := offset/proto4.LeafSize, (offset+length+proto4.LeafSize-1)/proto4.LeafSize
	segmentStart, segmentEnd := proto4.SectorSubtreeRange(start, end)
	subtreeCache := proto4.CachedSectorSubtrees(sector)
	proof := proto4.BuildSectorProof(sector[segmentStart*proto4.LeafSize:segmentEnd*proto4.LeafSize], start, end, subtreeCache)
	return sector[offset:][:length], proof, nil
}

// DeleteSector removes a sector (DropSector, to simulate a lost sector).
func (ds *DiskSectorStore) DeleteSector(root types.Hash256) error {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	if _, ok := ds.expirations[root]; !ok {
		return proto4.ErrSectorNotFound
	}
	delete(ds.expirations, root)
	return os.Remove(ds.path(root))
}

// Bytes is the total of the sector files (for resource accounting).
func (ds *DiskSectorStore) Bytes() int64 {
	ds.mu.Lock()
	defer ds.mu.Unlock()
	return int64(len(ds.expirations)) * proto4.SectorSize
}
