package slabs

// FENCING PATCH (work/indexd-fencing-implementation-interface.txt): the commit-ordered object sequence listing.

import (
	"context"
	"errors"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
)

// ErrInvalidSeqListing is returned for a sequence listing request outside its bounds.
var ErrInvalidSeqListing = errors.New("invalid sequence listing request")

type (
	// A SeqObjectEvent is one key's latest event in the account's commit-ordered sequence. Deleted keys are kept.
	// Blocked objects are flagged and their metadata is withheld (Object nil).
	SeqObjectEvent struct {
		Key     types.Hash256 `json:"key"`
		Seq     uint64        `json:"seq"`
		Deleted bool          `json:"deleted"`
		Blocked bool          `json:"blocked"`
		Object  *SealedObject `json:"object,omitempty"`
	}

	// A CurrentObjectEvent is one entry of the current-objects listing (PATCH U1). Blocked is only ever set when
	// blocked objects were requested; such an entry has no object.
	CurrentObjectEvent struct {
		ObjectEvent
		Blocked bool `json:"blocked,omitempty"`
	}

	// A SeqListing is one page of the sequence listing and the account's event sequence head, from one snapshot.
	SeqListing struct {
		Head   uint64           `json:"head"`
		Events []SeqObjectEvent `json:"events"`
	}
)

// AccountFence returns the account's installed writer fence (nil: none), its receipt digest and its event sequence
// head.
func (m *SlabManager) AccountFence(ctx context.Context, account proto.Account) (accounts.FenceState, error) {
	return m.store.AccountFence(account)
}

// RaiseFence installs a writer fence that is strictly greater than the installed one (equal or lower: FencedError)
// and returns its fresh receipt and the event sequence head.
func (m *SlabManager) RaiseFence(ctx context.Context, account proto.Account, fence accounts.Fence) (accounts.Receipt, uint64, error) {
	return m.store.RaiseFence(account, fence)
}

// ListObjectsSeq returns one page of the account's commit-ordered object sequence after `after`, with the head.
func (m *SlabManager) ListObjectsSeq(ctx context.Context, account proto.Account, after uint64, limit int) (SeqListing, error) {
	head, events, err := m.store.ListObjectsSeq(account, after, limit)
	if err != nil {
		return SeqListing{}, err
	}
	if events == nil {
		events = []SeqObjectEvent{}
	}
	return SeqListing{Head: head, Events: events}, nil
}

// ListCurrentObjects lists the account's current objects in key order after the given key (PATCH U1); blocked
// objects are listed flagged only if includeBlocked is set.
func (m *SlabManager) ListCurrentObjects(ctx context.Context, account proto.Account, after types.Hash256, limit int, includeBlocked bool) ([]CurrentObjectEvent, error) {
	return m.store.ListCurrentObjects(account, after, limit, includeBlocked)
}
