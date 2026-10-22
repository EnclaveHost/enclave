package postgres

// FENCING PATCH tests (work/indexd-fencing-implementation-interface.txt): the writer fence, the receipt, the exact
// credential check on every account mutation, and the commit-ordered object sequence, against real PostgreSQL.

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
	"lukechampine.com/frand"
)

func testFence(gen, counter uint64, iid byte) accounts.Fence {
	var f accounts.Fence
	binary.BigEndian.PutUint64(f[:8], gen)
	binary.BigEndian.PutUint64(f[8:16], counter)
	for i := 16; i < 32; i++ {
		f[i] = iid
	}
	return f
}

// fenceEnv is an account with one host, one contract and one pinned slab whose slices make distinct objects.
type fenceEnv struct {
	store *Store
	acc   proto.Account
	hk    types.PublicKey
	slab  slabs.SlabPinParams
}

func newFenceEnv(t *testing.T, store *Store) *fenceEnv {
	t.Helper()
	e := &fenceEnv{store: store, acc: proto.Account(types.GeneratePrivateKey().PublicKey())}
	store.addTestAccount(t, types.PublicKey(e.acc))
	if store.hostCount(t) == 0 {
		e.hk = store.addTestHost(t)
		store.addTestContract(t, e.hk)
	} else {
		e.hk = store.firstHost(t)
	}
	e.slab = e.newSlabParams()
	if _, err := store.PinSlabs(e.acc, time.Time{}, e.slab); err != nil {
		t.Fatal(err)
	}
	return e
}

func (s *Store) hostCount(t *testing.T) (n int) {
	t.Helper()
	if err := s.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM hosts`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return
}

func (s *Store) firstHost(t *testing.T) (hk types.PublicKey) {
	t.Helper()
	if err := s.pool.QueryRow(t.Context(), `SELECT public_key FROM hosts ORDER BY id LIMIT 1`).Scan((*sqlPublicKey)(&hk)); err != nil {
		t.Fatal(err)
	}
	return
}

func (e *fenceEnv) newSlabParams() slabs.SlabPinParams {
	return slabs.SlabPinParams{
		EncryptionKey: frand.Entropy256(),
		MinShards:     1,
		Sectors:       []slabs.PinnedSector{{Root: frand.Entropy256(), HostKey: e.hk}},
	}
}

// object returns the i-th distinct object of the env's slab (the object key is a hash of its slab slices).
func (e *fenceEnv) object(i int) slabs.SealedObject {
	return slabs.SealedObject{
		EncryptedDataKey:     frand.Bytes(72),
		EncryptedMetadataKey: frand.Bytes(72),
		EncryptedMetadata:    frand.Bytes(20),
		DataSignature:        types.Signature(frand.Bytes(64)),
		MetadataSignature:    types.Signature(frand.Bytes(64)),
		Slabs:                []slabs.SlabSlice{e.slab.Slice(uint32(i), 1)},
	}
}

func (e *fenceEnv) raise(t *testing.T, f accounts.Fence) accounts.Credential {
	t.Helper()
	r, _, err := e.store.RaiseFence(e.acc, f)
	if err != nil {
		t.Fatalf("raise %v: %v", f, err)
	}
	return accounts.Credential{Fence: f, Receipt: r}
}

func (e *fenceEnv) eventSeq(t *testing.T) (n int64) {
	t.Helper()
	if err := e.store.pool.QueryRow(t.Context(), `SELECT event_seq FROM accounts WHERE public_key = $1`, sqlPublicKey(e.acc)).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return
}

// listAll pages through the whole sequence listing with the given page size and returns the head of the FIRST page.
func (e *fenceEnv) listAll(t *testing.T, limit int) (uint64, []slabs.SeqObjectEvent) {
	t.Helper()
	var all []slabs.SeqObjectEvent
	var first uint64
	var after uint64
	for i := 0; ; i++ {
		head, page, err := e.store.ListObjectsSeq(e.acc, after, limit)
		if err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = head
		}
		if len(page) == 0 {
			return first, all
		}
		all = append(all, page...)
		after = page[len(page)-1].Seq
	}
}

// accountState is everything an app mutation can change for the account, so a refused mutation can be shown to
// have had no effect.
func (e *fenceEnv) accountState(t *testing.T) string {
	t.Helper()
	var objs, events, pins, keys, shared, seq int64
	var pinned int64
	err := e.store.pool.QueryRow(t.Context(), `SELECT
		(SELECT COUNT(*) FROM objects o JOIN accounts a ON a.id = o.account_id WHERE a.public_key = $1),
		(SELECT COUNT(*) FROM object_events oe JOIN accounts a ON a.id = oe.account_id WHERE a.public_key = $1 AND NOT oe.was_deleted),
		(SELECT COUNT(*) FROM account_slabs s JOIN accounts a ON a.id = s.account_id WHERE a.public_key = $1),
		(SELECT COUNT(*) FROM sharing_keys k JOIN accounts a ON a.id = k.account_id WHERE a.public_key = $1),
		(SELECT COUNT(*) FROM shared_objects so JOIN sharing_keys k ON k.id = so.sharing_key_id JOIN accounts a ON a.id = k.account_id WHERE a.public_key = $1),
		(SELECT event_seq FROM accounts WHERE public_key = $1),
		(SELECT pinned_data FROM accounts WHERE public_key = $1)`, sqlPublicKey(e.acc)).Scan(&objs, &events, &pins, &keys, &shared, &seq, &pinned)
	if err != nil {
		t.Fatal(err)
	}
	return fmt.Sprintf("objects=%d live-events=%d pins=%d keys=%d shared=%d seq=%d pinned=%d", objs, events, pins, keys, shared, seq, pinned)
}

func assertFenced(t *testing.T, err error, want *accounts.Fence) {
	t.Helper()
	var fe *accounts.FencedError
	if !errors.As(err, &fe) {
		t.Fatalf("expected a FencedError naming %v, got %v", want, err)
	}
	switch {
	case want == nil && fe.Current != nil:
		t.Fatalf("expected a refusal naming no fence, got %v", *fe.Current)
	case want != nil && (fe.Current == nil || *fe.Current != *want):
		t.Fatalf("expected a refusal naming %v, got %v", *want, fe.Current)
	}
}

func TestFenceRaiseRules(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	other := newFenceEnv(t, store)

	if st, err := store.AccountFence(e.acc); err != nil || st.Fence != nil || st.ReceiptSHA256 != nil || st.Seq != 0 {
		t.Fatalf("fresh account: %+v %v", st, err)
	}
	// non-canonical: top bit of gen, top bit of counter
	for _, f := range []accounts.Fence{testFence(1<<63, 0, 1), testFence(1, 1<<63, 1)} {
		if _, _, err := store.RaiseFence(e.acc, f); !errors.Is(err, accounts.ErrNonCanonicalFence) {
			t.Fatalf("expected ErrNonCanonicalFence, got %v", err)
		}
	}
	// unknown account
	if _, _, err := store.RaiseFence(proto.Account{9, 9}, testFence(1, 1, 1)); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}

	f1 := testFence(16<<48, 5, 0x10)
	c1 := e.raise(t, f1)
	st, err := store.AccountFence(e.acc)
	if err != nil || st.Fence == nil || *st.Fence != f1 || st.ReceiptSHA256 == nil || *st.ReceiptSHA256 != sha256.Sum256(c1.Receipt[:]) {
		t.Fatalf("after raise: %+v %v", st, err)
	}
	// equal raise is refused and issues no receipt (the lost-response / clone case)
	if r, _, err := store.RaiseFence(e.acc, f1); err == nil {
		t.Fatalf("equal raise accepted, receipt %x", r)
	} else {
		assertFenced(t, err, &f1)
	}
	// every lower token is refused: lower gen, lower counter, lower iid
	for _, f := range []accounts.Fence{testFence(15<<48, 99, 0xff), testFence(16<<48, 4, 0xff), testFence(16<<48, 5, 0x0f)} {
		_, _, err := store.RaiseFence(e.acc, f)
		assertFenced(t, err, &f1)
	}
	if st2, _ := store.AccountFence(e.acc); *st2.ReceiptSHA256 != *st.ReceiptSHA256 {
		t.Fatal("a refused raise changed the receipt")
	}
	// a higher iid alone is a higher ballot (bytewise order)
	f2 := testFence(16<<48, 5, 0x11)
	c2 := e.raise(t, f2)
	if c2.Receipt == c1.Receipt {
		t.Fatal("receipt reused")
	}
	// account isolation: the other account has no fence and is unaffected
	if st, err := store.AccountFence(other.acc); err != nil || st.Fence != nil {
		t.Fatalf("other account: %+v %v", st, err)
	}
	if err := store.PinObject(other.acc, ptr(other.object(1)).PinRequest()); err != nil {
		t.Fatalf("unfenced account pin failed: %v", err)
	}
	// e's credential means nothing on the other account
	err = store.PinObjectFenced(other.acc, &c2, ptr(other.object(2)).PinRequest())
	assertFenced(t, err, nil)
	// the other account can install the very same token independently
	other.raise(t, f2)
	// a deleted account cannot be raised
	if err := store.DeleteAccount(other.acc); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.RaiseFence(other.acc, testFence(17<<48, 0, 0)); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("expected ErrNotFound for a deleted account, got %v", err)
	}
}

func ptr[T any](v T) *T { return &v }

// TestFenceEqualRaiseClone: two processes holding the same ballot raise it concurrently. Exactly one obtains a
// receipt; the other is refused and cannot write. (An idempotent equal raise would give both a working credential.)
func TestFenceEqualRaiseClone(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	f := testFence(17<<48, 1, 0x42)

	for round := 0; round < 10; round++ {
		f = testFence(17<<48, uint64(round+1), 0x42)
		var wg sync.WaitGroup
		var creds [2]*accounts.Credential
		var errs [2]error
		for i := range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				r, _, err := store.RaiseFence(e.acc, f)
				if err == nil {
					creds[i] = &accounts.Credential{Fence: f, Receipt: r}
				}
				errs[i] = err
			}()
		}
		wg.Wait()
		if (creds[0] == nil) == (creds[1] == nil) {
			t.Fatalf("round %d: expected exactly one install, got errors %v / %v", round, errs[0], errs[1])
		}
		winner, loser := 0, 1
		if creds[0] == nil {
			winner, loser = 1, 0
		}
		assertFenced(t, errs[loser], &f)
		// the loser, holding the same token, cannot write without the receipt
		err := store.PinObjectFenced(e.acc, &accounts.Credential{Fence: f}, ptr(e.object(round)).PinRequest())
		assertFenced(t, err, &f)
		if err := store.PinObjectFenced(e.acc, creds[winner], ptr(e.object(round)).PinRequest()); err != nil {
			t.Fatalf("winner could not write: %v", err)
		}
	}
}

// TestFenceMutationChecks runs every fenced store mutation with an absent, stale, higher, wrong-receipt and exact
// credential: only the exact one has any effect.
func TestFenceMutationChecks(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)

	f1 := testFence(16<<48, 1, 1)
	c1 := e.raise(t, f1)
	f2 := testFence(16<<48, 2, 1)
	c2 := e.raise(t, f2)

	higher := accounts.Credential{Fence: testFence(16<<48, 3, 1), Receipt: c2.Receipt}
	wrongReceipt := accounts.Credential{Fence: f2, Receipt: c1.Receipt}
	zeroReceipt := accounts.Credential{Fence: f2}
	bad := []*accounts.Credential{nil, &c1, &higher, &wrongReceipt, &zeroReceipt}

	// fixtures for the mutations
	slab2 := e.newSlabParams()
	if _, err := store.PinSlabsFenced(e.acc, &c2, time.Time{}, slab2); err != nil {
		t.Fatal(err)
	}
	live := e.object(100)
	if err := store.PinObjectFenced(e.acc, &c2, live.PinRequest()); err != nil {
		t.Fatal(err)
	}
	sk, err := store.AddSharingKeyFenced(e.acc, &c2, sharing.KeyRequest{PublicKey: types.GeneratePrivateKey().PublicKey(), Nonce: sharing.Nonce(frand.Bytes(32)), Description: "k"})
	if err != nil {
		t.Fatal(err)
	}
	sharedReq := sharing.SharedObjectRequest{
		ObjectID:          live.ID(),
		EncryptedDataKey:  frand.Bytes(sharing.EncryptionKeySize),
		DataSignature:     types.Signature(frand.Bytes(64)),
		MetadataSignature: types.Signature(frand.Bytes(64)),
	}

	type mutation struct {
		name string
		do   func(sf *accounts.Credential) error
	}
	newKey := sharing.KeyRequest{PublicKey: types.GeneratePrivateKey().PublicKey(), Nonce: sharing.Nonce(frand.Bytes(32)), Description: "n"}
	slab3 := e.newSlabParams()
	pinned := e.object(101)
	mutations := []mutation{
		{"PinSlabs", func(sf *accounts.Credential) error {
			_, err := store.PinSlabsFenced(e.acc, sf, time.Time{}, slab3)
			return err
		}},
		{"PinObject", func(sf *accounts.Credential) error { return store.PinObjectFenced(e.acc, sf, pinned.PinRequest()) }},
		{"AddSharingKey", func(sf *accounts.Credential) error {
			_, err := store.AddSharingKeyFenced(e.acc, sf, newKey)
			return err
		}},
		{"AddSharedObject", func(sf *accounts.Credential) error {
			return store.AddSharedObjectFenced(e.acc, sf, sk.PublicKey, sharedReq)
		}},
		{"DeleteSharedObject", func(sf *accounts.Credential) error {
			return store.DeleteSharedObjectFenced(e.acc, sf, sk.PublicKey, live.ID())
		}},
		{"DeleteSharingKey", func(sf *accounts.Credential) error {
			return store.DeleteSharingKeyFenced(e.acc, sf, newKey.PublicKey)
		}},
		{"DeleteObject", func(sf *accounts.Credential) error { return store.DeleteObjectFenced(e.acc, sf, pinned.ID()) }},
		{"UnpinSlab", func(sf *accounts.Credential) error { return store.UnpinSlabFenced(e.acc, sf, slab3.Digest()) }},
		{"PruneSlabs", func(sf *accounts.Credential) error {
			return store.PruneSlabsFenced(e.acc, sf, time.Now().Add(time.Hour))
		}},
	}
	for _, m := range mutations {
		before := e.accountState(t)
		for i, sf := range bad {
			assertFenced(t, m.do(sf), &f2)
			if after := e.accountState(t); after != before {
				t.Fatalf("%s with bad credential %d changed state: %s -> %s", m.name, i, before, after)
			}
		}
		if err := m.do(&c2); err != nil {
			t.Fatalf("%s with the exact credential: %v", m.name, err)
		}
		if after := e.accountState(t); after == before && m.name != "PruneSlabs" {
			t.Fatalf("%s with the exact credential had no effect: %s", m.name, after)
		}
	}
	// prune removed slab2 (pinned, unreferenced); the env slab is still referenced by `live`
	var n int
	if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM account_slabs s JOIN slabs sl ON sl.id = s.slab_id WHERE sl.digest = $1`, sqlHash256(slab2.Digest())).Scan(&n); err != nil {
		t.Fatal(err)
	} else if n != 0 {
		t.Fatal("prune with the exact credential did not unpin the unreferenced slab")
	}

	// sf on an account without a fence: refused, naming no fence
	o := newFenceEnv(t, store)
	assertFenced(t, store.PinObjectFenced(o.acc, &c2, ptr(o.object(1)).PinRequest()), nil)
	assertFenced(t, store.DeleteObjectFenced(o.acc, &c2, types.Hash256{1}), nil)
}

// TestFenceLegacyUnfenced: an account that never raises behaves as 0.6.0: no seq, the feed works, the seq listing
// is refused.
func TestFenceLegacyUnfenced(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	objs := []slabs.SealedObject{e.object(1), e.object(2), e.object(3)}
	for _, o := range objs {
		if err := store.PinObject(e.acc, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.DeleteObject(e.acc, objs[1].ID()); err != nil {
		t.Fatal(err)
	}
	var nonNull int
	if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events WHERE seq IS NOT NULL`).Scan(&nonNull); err != nil || nonNull != 0 {
		t.Fatalf("unfenced account assigned seqs: %d %v", nonNull, err)
	}
	if e.eventSeq(t) != 0 {
		t.Fatal("event_seq advanced")
	}
	events := store.listEvents(t, e.acc, slabs.Cursor{})
	if len(events) != 3 {
		t.Fatalf("feed: expected 3 events, got %d", len(events))
	}
	if _, _, err := store.ListObjectsSeq(e.acc, 0, 10); !errors.Is(err, accounts.ErrSeqNotEnabled) {
		t.Fatalf("expected ErrSeqNotEnabled, got %v", err)
	}
	// a fenced account's stock (unfenced) writer is refused: never weakened
	f := testFence(1, 1, 1)
	e.raise(t, f)
	assertFenced(t, store.PinObject(e.acc, ptr(e.object(9)).PinRequest()), &f)
	assertFenced(t, store.DeleteObject(e.acc, objs[0].ID()), &f)
	_, err := store.PinSlabs(e.acc, time.Time{}, e.newSlabParams())
	assertFenced(t, err, &f)
	_, err = store.AddSharingKey(e.acc, sharing.KeyRequest{PublicKey: types.GeneratePrivateKey().PublicKey(), Nonce: sharing.Nonce(frand.Bytes(32))})
	assertFenced(t, err, &f)
	assertFenced(t, store.PruneSlabs(e.acc, time.Now()), &f)
}

// TestFenceBackfill: the first raise numbers every existing event (published by publish time, unpublished after),
// including tombstones and blocked objects; later events continue the sequence.
func TestFenceBackfill(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	var objs []slabs.SealedObject
	for i := range 6 {
		o := e.object(i)
		objs = append(objs, o)
		if err := store.PinObject(e.acc, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
		if i == 2 {
			store.publishEvents(t) // 0,1,2 published; 3,4,5 not
		}
	}
	if err := store.DeleteObject(e.acc, objs[1].ID()); err != nil { // tombstone (unpublished again)
		t.Fatal(err)
	}
	if err := store.BlockObject(objs[4].ID(), "test"); err != nil {
		t.Fatal(err)
	}

	f := testFence(16<<48, 1, 7)
	_, head, err := store.RaiseFence(e.acc, f)
	if err != nil {
		t.Fatal(err)
	} else if head != 6 {
		t.Fatalf("expected backfill head 6, got %d", head)
	}
	gotHead, all := e.listAll(t, 2)
	if gotHead != 6 || len(all) != 6 {
		t.Fatalf("expected 6 events at head 6, got %d at %d", len(all), gotHead)
	}
	for i, ev := range all {
		if ev.Seq != uint64(i+1) {
			t.Fatalf("seq gap: %v", all)
		}
	}
	// published first (0, 2 in publish order: objects 0 and 2 kept their position), then unpublished by key
	byKey := map[types.Hash256]slabs.SeqObjectEvent{}
	for _, ev := range all {
		byKey[ev.Key] = ev
	}
	for _, i := range []int{0, 2} {
		if byKey[objs[i].ID()].Seq > 2 {
			t.Fatalf("published object %d numbered after unpublished events: %v", i, byKey[objs[i].ID()])
		}
	}
	if ev := byKey[objs[1].ID()]; !ev.Deleted || ev.Object != nil {
		t.Fatalf("tombstone: %+v", ev)
	}
	if ev := byKey[objs[4].ID()]; !ev.Blocked || ev.Object != nil || ev.Deleted {
		t.Fatalf("blocked: %+v", ev)
	}
	for _, i := range []int{0, 2, 3, 5} {
		ev := byKey[objs[i].ID()]
		if ev.Deleted || ev.Blocked || ev.Object == nil || ev.Object.ID() != objs[i].ID() {
			t.Fatalf("live object %d: %+v", i, ev)
		}
		want, err := store.Object(e.acc, objs[i].ID())
		if err != nil {
			t.Fatal(err)
		}
		if !slices.Equal(ev.Object.EncryptedMetadata, want.EncryptedMetadata) || len(ev.Object.Slabs) != len(want.Slabs) {
			t.Fatalf("listing object differs from Object()")
		}
	}
	// a raise to a higher fence does not renumber
	c2 := e.raise(t, testFence(16<<48, 2, 7))
	if _, again := e.listAll(t, 100); !slices.EqualFunc(again, all, func(a, b slabs.SeqObjectEvent) bool { return a.Key == b.Key && a.Seq == b.Seq }) {
		t.Fatal("second raise renumbered the sequence")
	}
	// later events continue
	if err := store.PinObjectFenced(e.acc, &c2, ptr(e.object(50)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	if head, page, err := store.ListObjectsSeq(e.acc, 6, 10); err != nil || head != 7 || len(page) != 1 || page[0].Seq != 7 {
		t.Fatalf("after backfill: head %d page %v err %v", head, page, err)
	}
}

// TestFenceBlockedUnblockRepair: blocking flags an object without changing seq or head, unblocking restores it, a
// slab repair (RecordSlabMigrated) changes neither, and a pin of a blocked key consumes no seq.
func TestFenceBlockedUnblockRepair(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))
	a, b := e.object(1), e.object(2)
	for _, o := range []slabs.SealedObject{a, b} {
		if err := store.PinObjectFenced(e.acc, &c, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
	}
	head0, before := e.listAll(t, 10)
	if head0 != 2 {
		t.Fatalf("head %d", head0)
	}

	if err := store.BlockObject(a.ID(), "test"); err != nil {
		t.Fatal(err)
	}
	head, all := e.listAll(t, 10)
	if head != head0 || len(all) != 2 || all[0].Key != a.ID() || !all[0].Blocked || all[0].Object != nil || all[0].Seq != before[0].Seq {
		t.Fatalf("blocked listing: head %d %+v", head, all)
	}
	// the current listing omits it by default and flags it on request
	cur, err := store.ListCurrentObjects(e.acc, types.Hash256{}, 10, false)
	if err != nil || len(cur) != 1 || cur[0].Key != b.ID() {
		t.Fatalf("current listing (default) %+v %v", cur, err)
	}
	cur, err = store.ListCurrentObjects(e.acc, types.Hash256{}, 10, true)
	if err != nil || len(cur) != 2 {
		t.Fatalf("current listing (blocked=true) %+v %v", cur, err)
	}
	for _, ev := range cur {
		if (ev.Key == a.ID()) != ev.Blocked || (ev.Object == nil) != ev.Blocked {
			t.Fatalf("current listing entry %+v", ev)
		}
	}
	// a pin of the blocked key is refused and consumes no seq
	if err := store.PinObjectFenced(e.acc, &c, ptr(a).PinRequest()); !errors.Is(err, slabs.ErrObjectBlocked) {
		t.Fatalf("expected ErrObjectBlocked, got %v", err)
	} else if e.eventSeq(t) != 2 {
		t.Fatal("a refused pin consumed a seq")
	}

	if err := store.UnblockObject(a.ID()); err != nil {
		t.Fatal(err)
	}
	head, all = e.listAll(t, 10)
	if head != head0 || all[0].Blocked || all[0].Object == nil || all[0].Seq != before[0].Seq {
		t.Fatalf("after unblock: head %d %+v", head, all)
	}

	// slab repair: the stock feed unpublishes both objects, the sequence does not change
	if err := store.RecordSlabMigrated(e.slab.Digest()); err != nil {
		t.Fatal(err)
	}
	var unpublished int
	store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events WHERE updated_at IS NULL`).Scan(&unpublished)
	if unpublished != 2 {
		t.Fatalf("expected the stock feed to unpublish 2 events, got %d", unpublished)
	}
	head, all = e.listAll(t, 10)
	if head != head0 || len(all) != 2 || all[0].Seq != before[0].Seq || all[1].Seq != before[1].Seq || all[0].Object == nil || all[1].Object == nil {
		t.Fatalf("after repair: head %d %+v", head, all)
	}
}

// TestFenceRollbackNoGaps: a mutation that fails after taking a seq rolls the counter back; acknowledged mutations
// get exactly consecutive seqs and every listed seq belongs to an acknowledged mutation.
func TestFenceRollbackNoGaps(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))

	unpinned := e.newSlabParams() // never pinned to the account
	failing := slabs.SealedObject{EncryptedDataKey: frand.Bytes(72), DataSignature: types.Signature(frand.Bytes(64)), MetadataSignature: types.Signature(frand.Bytes(64)),
		Slabs: []slabs.SlabSlice{unpinned.Slice(0, 1)}}
	var acked []types.Hash256
	for i := range 20 {
		switch i % 4 {
		case 0: // fails after nextSeq (slab check)
			if err := store.PinObjectFenced(e.acc, &c, failing.PinRequest()); !errors.Is(err, slabs.ErrObjectUnpinnedSlab) {
				t.Fatalf("expected ErrObjectUnpinnedSlab, got %v", err)
			}
		case 1: // delete of an absent key
			if err := store.DeleteObjectFenced(e.acc, &c, frand.Entropy256()); !errors.Is(err, slabs.ErrObjectNotFound) {
				t.Fatalf("expected ErrObjectNotFound, got %v", err)
			}
		default:
			o := e.object(i)
			if err := store.PinObjectFenced(e.acc, &c, o.PinRequest()); err != nil {
				t.Fatal(err)
			}
			acked = append(acked, o.ID())
		}
	}
	head, all := e.listAll(t, 3)
	if head != uint64(len(acked)) || len(all) != len(acked) {
		t.Fatalf("head %d, %d events, %d acknowledged", head, len(all), len(acked))
	}
	for i, ev := range all {
		if ev.Seq != uint64(i+1) || ev.Key != acked[i] {
			t.Fatalf("event %d: %+v, want key %v seq %d", i, ev, acked[i], i+1)
		}
	}
}

// TestFenceListingBounds: limit and after are validated; an unknown account is not found.
func TestFenceListingBounds(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	e.raise(t, testFence(1, 1, 1))
	for _, l := range []int{0, -1, MaxSeqListLimit + 1} {
		if _, _, err := store.ListObjectsSeq(e.acc, 0, l); !errors.Is(err, slabs.ErrInvalidSeqListing) {
			t.Fatalf("limit %d: %v", l, err)
		}
	}
	if _, _, err := store.ListObjectsSeq(e.acc, 1<<63, 10); !errors.Is(err, slabs.ErrInvalidSeqListing) {
		t.Fatalf("after 2^63: %v", err)
	}
	if _, _, err := store.ListObjectsSeq(e.acc, 1<<63-1, MaxSeqListLimit); err != nil {
		t.Fatalf("max after: %v", err)
	}
	if _, _, err := store.ListObjectsSeq(proto.Account{7}, 0, 10); !errors.Is(err, accounts.ErrNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
}

// TestFenceConcurrentRaiseVsWrites: a writer pins and deletes continuously while a contender raises a higher fence.
// Every acknowledged mutation has seq <= the contender's head; every mutation after the raise is refused naming
// the contender's fence; the listing at the contender's head contains exactly the acknowledged state.
func TestFenceConcurrentRaiseVsWrites(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	for round := range 5 {
		e := newFenceEnv(t, store)
		old := e.raise(t, testFence(16<<48, 1, 0xaa))
		// some objects to delete
		for i := range 20 {
			if err := store.PinObjectFenced(e.acc, &old, ptr(e.object(1000+i)).PinRequest()); err != nil {
				t.Fatal(err)
			}
		}

		var mu sync.Mutex
		ackPinned := map[types.Hash256]bool{}  // acknowledged pins
		ackDeleted := map[types.Hash256]bool{} // acknowledged deletions
		var refused atomic.Int64
		var wg sync.WaitGroup
		stop := make(chan struct{})
		newF := testFence(16<<48, 2, 0xbb)
		for w := range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; ; i++ {
					select {
					case <-stop:
						return
					default:
					}
					var err error
					var key types.Hash256
					del := w%2 == 1 && i < 10
					if del {
						key = ptr(e.object(1000 + (w/2)*10 + i)).ID()
						err = store.DeleteObjectFenced(e.acc, &old, key)
					} else {
						o := e.object(w<<24 + i)
						key = o.ID()
						err = store.PinObjectFenced(e.acc, &old, o.PinRequest())
					}
					if err != nil {
						var fe *accounts.FencedError
						if !errors.As(err, &fe) || fe.Current == nil || *fe.Current != newF {
							t.Errorf("unexpected error: %v", err)
						}
						refused.Add(1)
						return
					}
					mu.Lock()
					if del {
						ackDeleted[key] = true
					} else {
						ackPinned[key] = true
					}
					mu.Unlock()
				}
			}()
		}
		time.Sleep(time.Duration(20+round*15) * time.Millisecond)
		_, head, err := store.RaiseFence(e.acc, newF)
		if err != nil {
			t.Fatal(err)
		}
		wg.Wait()
		close(stop)
		if refused.Load() != 4 {
			t.Fatalf("round %d: expected all 4 writers refused after the raise, got %d", round, refused.Load())
		}
		final, all := e.listAll(t, 7)
		if final != head {
			t.Fatalf("round %d: a mutation committed after the raise (head %d -> %d)", round, head, final)
		}
		state := map[types.Hash256]bool{} // key -> live
		for _, ev := range all {
			if ev.Seq > head {
				t.Fatalf("event beyond the raise head: %+v", ev)
			}
			state[ev.Key] = !ev.Deleted
		}
		for k := range ackPinned {
			if !state[k] {
				t.Fatalf("round %d: acknowledged pin %v missing", round, k)
			}
		}
		for k := range ackDeleted {
			if live, ok := state[k]; !ok || live {
				t.Fatalf("round %d: acknowledged delete %v not a tombstone", round, k)
			}
		}
		if len(ackPinned)+20 != len(state) {
			t.Fatalf("round %d: listing has %d keys, acknowledged %d pins + 20", round, len(state), len(ackPinned))
		}
		t.Logf("round %d: %d pins + %d deletes acknowledged before the raise at head %d", round, len(ackPinned), len(ackDeleted), head)
	}
}

// TestFenceConcurrentBackfill: stock (unfenced) writers pin while the first raise backfills. Every acknowledged pin
// gets a seq <= the raise head (none is left with seq NULL), the seqs are exactly 1..head, and every later unfenced
// pin is refused.
func TestFenceConcurrentBackfill(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	for round := range 5 {
		e := newFenceEnv(t, store)
		for i := range 30 {
			if err := store.PinObject(e.acc, ptr(e.object(1<<30+i)).PinRequest()); err != nil {
				t.Fatal(err)
			}
		}
		f := testFence(1, uint64(round+1), 1)
		var mu sync.Mutex
		acked := map[types.Hash256]bool{}
		var wg sync.WaitGroup
		for w := range 4 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; ; i++ {
					o := e.object(w<<24 + i) // disjoint from the other writers and the initial objects
					if err := store.PinObject(e.acc, o.PinRequest()); err != nil {
						assertFencedNoFatal(t, err, &f)
						return
					}
					mu.Lock()
					acked[o.ID()] = true
					mu.Unlock()
				}
			}()
		}
		time.Sleep(time.Duration(10+round*10) * time.Millisecond)
		start := time.Now()
		_, head, err := store.RaiseFence(e.acc, f)
		if err != nil {
			t.Fatal(err)
		} else if took := time.Since(start); took > 2*time.Second {
			t.Fatalf("round %d: the raise was starved by unfenced writers for %v", round, took)
		} else {
			t.Logf("round %d: raise took %v under 4 unfenced writers", round, took)
		}
		wg.Wait()
		var nulls int
		store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events oe JOIN accounts a ON a.id = oe.account_id WHERE a.public_key = $1 AND oe.seq IS NULL`, sqlPublicKey(e.acc)).Scan(&nulls)
		if nulls != 0 {
			t.Fatalf("round %d: %d events left without seq", round, nulls)
		}
		final, all := e.listAll(t, 1000)
		if final != head || uint64(len(all)) != head || int(head) != 30+len(acked) {
			t.Fatalf("round %d: head %d final %d events %d acked %d+30", round, head, final, len(all), len(acked))
		}
		for i, ev := range all {
			if ev.Seq != uint64(i+1) {
				t.Fatalf("round %d: seq gap at %d", round, i)
			}
			delete(acked, ev.Key)
		}
		if len(acked) != 0 {
			t.Fatalf("round %d: %d acknowledged pins missing from the listing", round, len(acked))
		}
	}
}

func assertFencedNoFatal(t *testing.T, err error, want *accounts.Fence) {
	var fe *accounts.FencedError
	if !errors.As(err, &fe) || fe.Current == nil || *fe.Current != *want {
		t.Errorf("expected a FencedError naming %v, got %v", *want, err)
	}
}

// TestFenceSeqCommitOrder: concurrent committers get seqs in commit order. A reader that saw head H never later
// sees a new event with seq <= H (so "page from my last seq" never misses a commit), and within each writer the
// seqs increase.
func TestFenceSeqCommitOrder(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))

	const writers, per = 6, 25
	var wg sync.WaitGroup
	seqOf := make([][]types.Hash256, writers)
	done := make(chan struct{})
	readerErr := make(chan error, 1)
	go func() {
		// the reader: every snapshot's events with seq <= a previously seen head must already have been seen
		seen := map[uint64]types.Hash256{}
		var lastHead uint64
		for {
			select {
			case <-done:
				readerErr <- nil
				return
			default:
			}
			head, page, err := store.ListObjectsSeq(e.acc, 0, MaxSeqListLimit)
			if err != nil {
				readerErr <- err
				return
			}
			if head < lastHead {
				readerErr <- fmt.Errorf("head went backwards %d -> %d", lastHead, head)
				return
			}
			for _, ev := range page {
				if ev.Seq > head {
					readerErr <- fmt.Errorf("event %d beyond head %d in one snapshot", ev.Seq, head)
					return
				}
				if k, ok := seen[ev.Seq]; ok && k != ev.Key {
					readerErr <- fmt.Errorf("seq %d reassigned", ev.Seq)
					return
				} else if !ok && ev.Seq <= lastHead {
					readerErr <- fmt.Errorf("seq %d appeared after head %d was observed", ev.Seq, lastHead)
					return
				}
				seen[ev.Seq] = ev.Key
			}
			if uint64(len(page)) != head {
				readerErr <- fmt.Errorf("snapshot has %d events at head %d (gap)", len(page), head)
				return
			}
			lastHead = head
		}
	}()
	for w := range writers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := range per {
				o := e.object(w*1000 + i)
				if err := store.PinObjectFenced(e.acc, &c, o.PinRequest()); err != nil {
					t.Error(err)
					return
				}
				seqOf[w] = append(seqOf[w], o.ID())
			}
		}()
	}
	wg.Wait()
	close(done)
	if err := <-readerErr; err != nil {
		t.Fatal(err)
	}
	head, all := e.listAll(t, 1000)
	if head != writers*per || len(all) != writers*per {
		t.Fatalf("head %d, %d events", head, len(all))
	}
	pos := map[types.Hash256]uint64{}
	for _, ev := range all {
		pos[ev.Key] = ev.Seq
	}
	for w := range writers {
		for i := 1; i < len(seqOf[w]); i++ {
			if pos[seqOf[w][i]] <= pos[seqOf[w][i-1]] {
				t.Fatalf("writer %d: sequential pins out of seq order", w)
			}
		}
	}
}

// TestFencePagedSnapshot: under a stable fence, paging with any page size reproduces the account; a writer's own
// later mutations (an overwrite and a delete of keys on already-read pages) appear beyond the first page's head,
// so replaying events in seq order reconstructs exactly the objects table.
func TestFencePagedSnapshot(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))
	var objs []slabs.SealedObject
	for i := range 25 {
		o := e.object(i)
		objs = append(objs, o)
		if err := store.PinObjectFenced(e.acc, &c, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
	}
	for _, limit := range []int{1, 7, 25, 1000} {
		head, all := e.listAll(t, limit)
		if head != 25 || len(all) != 25 {
			t.Fatalf("limit %d: head %d, %d events", limit, head, len(all))
		}
	}

	// page 1, then mutations behind the cursor, then continue
	head1, page1, err := store.ListObjectsSeq(e.acc, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	over := objs[2]
	over.EncryptedMetadata = []byte("v2")
	if err := store.PinObjectFenced(e.acc, &c, over.PinRequest()); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteObjectFenced(e.acc, &c, objs[3].ID()); err != nil {
		t.Fatal(err)
	}
	state := map[types.Hash256]*slabs.SealedObject{}
	apply := func(evs []slabs.SeqObjectEvent) {
		for _, ev := range evs {
			if ev.Deleted {
				delete(state, ev.Key)
			} else {
				state[ev.Key] = ev.Object
			}
		}
	}
	apply(page1)
	after := page1[len(page1)-1].Seq
	var lastHead uint64
	for {
		h, page, err := store.ListObjectsSeq(e.acc, after, 10)
		if err != nil {
			t.Fatal(err)
		}
		lastHead = h
		if len(page) == 0 {
			break
		}
		apply(page)
		after = page[len(page)-1].Seq
	}
	if head1 != 25 || lastHead != 27 {
		t.Fatalf("heads %d -> %d", head1, lastHead)
	}
	cur, err := store.ListCurrentObjects(e.acc, types.Hash256{}, 100, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(cur) != len(state) {
		t.Fatalf("replayed %d objects, table has %d", len(state), len(cur))
	}
	for _, o := range cur {
		got, ok := state[o.Key]
		if !ok || !slices.Equal(got.EncryptedMetadata, o.Object.EncryptedMetadata) {
			t.Fatalf("object %v differs after replay", o.Key)
		}
	}
	if string(state[objs[2].ID()].EncryptedMetadata) != "v2" {
		t.Fatal("overwrite not replayed")
	}
}

// TestFencePruneBatchesRaise: POST /slabs/prune runs in batches; a raise between batches stops the remaining ones.
func TestFencePruneBatchesRaise(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))
	// 450 unreferenced slabs = 5 batches
	var params []slabs.SlabPinParams
	for range 450 {
		params = append(params, e.newSlabParams())
	}
	for i := 0; i < len(params); i += 50 {
		if _, err := store.PinSlabsFenced(e.acc, &c, time.Time{}, params[i:i+50]...); err != nil {
			t.Fatal(err)
		}
	}
	countPins := func() (n int) {
		store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM account_slabs s JOIN accounts a ON a.id = s.account_id WHERE a.public_key = $1`, sqlPublicKey(e.acc)).Scan(&n)
		return
	}
	newF := testFence(1, 2, 1)
	errc := make(chan error, 1)
	// slow every unpin statement down (test database only) so the raise lands while batches remain
	if _, err := store.pool.Exec(t.Context(), `
		CREATE FUNCTION fence_test_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NULL; END $$;
		CREATE TRIGGER fence_test_slow AFTER DELETE ON account_slabs FOR EACH STATEMENT EXECUTE FUNCTION fence_test_slow();`); err != nil {
		t.Fatal(err)
	}
	// start the prune, raise as soon as the first batch has committed
	go func() { errc <- store.PruneSlabsFenced(e.acc, &c, time.Now().Add(time.Hour)) }()
	start := countPins()
	deadline := time.Now().Add(10 * time.Second)
	for countPins() == start && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if _, _, err := store.RaiseFence(e.acc, newF); err != nil {
		t.Fatal(err)
	}
	atRaise := countPins()
	err := <-errc
	final := countPins()
	assertFenced(t, err, &newF)
	if final != atRaise || final == start || final == 0 {
		t.Fatalf("pins changed after the raise: %d at raise, %d final", atRaise, final)
	}
	t.Logf("prune stopped by the raise: pins %d -> %d at raise, %d final", start, atRaise, final)
}

// TestFenceMixedConcurrencyNoDeadlockFailure: two fenced accounts sharing slabs run every mutation kind
// concurrently with background paths (repair, block/unblock, deleted-slab pruning). Deadlocks are retried by the
// store; no operation may fail with anything but its documented errors.
func TestFenceMixedConcurrencyNoDeadlockFailure(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e1 := newFenceEnv(t, store)
	e2 := newFenceEnv(t, store)
	e2.slab = e1.slab // share the slab (pin it on account 2 too)
	c1 := e1.raise(t, testFence(1, 1, 1))
	c2 := e2.raise(t, testFence(1, 1, 2))
	if _, err := store.PinSlabsFenced(e2.acc, &c2, time.Time{}, e1.slab); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	deadline := time.Now().Add(3 * time.Second)
	var ops atomic.Int64
	expected := func(err error) bool {
		return err == nil || errors.Is(err, slabs.ErrObjectNotFound) || errors.Is(err, slabs.ErrObjectBlocked) ||
			errors.Is(err, slabs.ErrSlabNotFound) || errors.Is(err, slabs.ErrSlabInUse) || errors.Is(err, sharing.ErrSharingKeyNotFound) ||
			errors.Is(err, slabs.ErrObjectUnpinnedSlab)
	}
	run := func(name string, fn func(i int) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; time.Now().Before(deadline); i++ {
				if err := fn(i); !expected(err) {
					t.Errorf("%s: %v", name, err)
					return
				}
				ops.Add(1)
			}
		}()
	}
	for _, x := range []struct {
		e *fenceEnv
		c *accounts.Credential
	}{{e1, &c1}, {e2, &c2}} {
		e, c := x.e, x.c
		run("pin", func(i int) error { return store.PinObjectFenced(e.acc, c, ptr(e.object(i%40)).PinRequest()) })
		run("delete", func(i int) error { return store.DeleteObjectFenced(e.acc, c, ptr(e.object((i*7)%40)).ID()) })
		run("slabs", func(i int) error {
			p := e.newSlabParams()
			if _, err := store.PinSlabsFenced(e.acc, c, time.Time{}, p); err != nil {
				return err
			}
			if i%2 == 0 {
				return store.UnpinSlabFenced(e.acc, c, p.Digest())
			}
			return store.PruneSlabsFenced(e.acc, c, time.Now().Add(time.Hour))
		})
		run("sharing", func(i int) error {
			req := sharing.KeyRequest{PublicKey: types.GeneratePrivateKey().PublicKey(), Nonce: sharing.Nonce(frand.Bytes(32))}
			if _, err := store.AddSharingKeyFenced(e.acc, c, req); err != nil {
				return err
			}
			o := e.object(i % 40)
			_ = store.AddSharedObjectFenced(e.acc, c, req.PublicKey, sharing.SharedObjectRequest{ObjectID: o.ID(), EncryptedDataKey: frand.Bytes(sharing.EncryptionKeySize),
				DataSignature: types.Signature(frand.Bytes(64)), MetadataSignature: types.Signature(frand.Bytes(64))})
			return store.DeleteSharingKeyFenced(e.acc, c, req.PublicKey)
		})
	}
	run("repair", func(int) error { return store.RecordSlabMigrated(e1.slab.Digest()) })
	run("block", func(i int) error {
		k := ptr(e1.object(i % 40)).ID()
		if err := store.BlockObject(k, "t"); err != nil {
			return err
		}
		return store.UnblockObject(k)
	})
	run("prune-deleted", func(int) error {
		_, err := store.PruneDeletedSlabs(100)
		return err
	})
	wg.Wait()
	t.Logf("%d operations", ops.Load())
	for _, e := range []*fenceEnv{e1, e2} {
		head, all := e.listAll(t, 1000)
		for _, ev := range all {
			if ev.Seq > head {
				t.Fatal("event beyond head")
			}
		}
		var nulls int
		store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events oe JOIN accounts a ON a.id = oe.account_id WHERE a.public_key = $1 AND oe.seq IS NULL`, sqlPublicKey(e.acc)).Scan(&nulls)
		if nulls != 0 {
			t.Fatalf("%d events without seq", nulls)
		}
	}
}

// TestFenceLostRaiseResponse: the raise committed but its answer (the receipt) was lost. Retrying the same token is
// refused and yields no receipt; nothing can be written under the lost install; the writer recovers by raising
// counter+1, and the sequence head is continuous across the lost install.
func TestFenceLostRaiseResponse(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c0 := e.raise(t, testFence(17<<48, 1, 9))
	if err := store.PinObjectFenced(e.acc, &c0, ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	}

	lost := testFence(17<<48, 2, 9)
	if _, head, err := store.RaiseFence(e.acc, lost); err != nil || head != 1 {
		t.Fatalf("raise: head %d err %v", head, err)
	} // the answer is dropped here: the writer never learns the receipt
	_, _, err := store.RaiseFence(e.acc, lost)
	assertFenced(t, err, &lost)
	for _, guess := range []accounts.Credential{{Fence: lost}, {Fence: lost, Receipt: c0.Receipt}} {
		assertFenced(t, store.PinObjectFenced(e.acc, &guess, ptr(e.object(2)).PinRequest()), &lost)
	}
	assertFenced(t, store.PinObjectFenced(e.acc, &c0, ptr(e.object(2)).PinRequest()), &lost)

	next := testFence(17<<48, 3, 9)
	r, head, err := store.RaiseFence(e.acc, next)
	if err != nil || head != 1 {
		t.Fatalf("recovery raise: head %d err %v", head, err)
	}
	c := accounts.Credential{Fence: next, Receipt: r}
	if err := store.PinObjectFenced(e.acc, &c, ptr(e.object(2)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	if head, all := e.listAll(t, 10); head != 2 || len(all) != 2 || all[1].Seq != 2 {
		t.Fatalf("head %d events %+v", head, all)
	}
}

// TestFenceRaiseWaitsForInflightUnfencedPin: an unfenced pin that has written its event but not committed (it is
// blocked on a slab lock) must not be missed by the first raise's backfill. The raise waits for it (the pin holds the
// account row in KEY SHARE), and once both commit the pin's event has a seq <= the raise head. Deterministic
// counterpart of TestFenceConcurrentBackfill (mutant M13).
func TestFenceRaiseWaitsForInflightUnfencedPin(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	if err := store.PinObject(e.acc, ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	}

	lockTx, err := store.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockTx.Rollback(t.Context()) }()
	if _, err := lockTx.Exec(t.Context(), `SELECT digest FROM slabs WHERE digest = $1 FOR UPDATE`, sqlHash256(e.slab.Digest())); err != nil {
		t.Fatal(err)
	}
	slow := e.object(2)
	pinErr := make(chan error, 1)
	go func() { pinErr <- store.PinObject(e.acc, slow.PinRequest()) }()
	waitBlocked := func(n int) {
		t.Helper()
		for range 100 {
			var waiting int
			if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
				WHERE NOT l.granted AND a.datname = current_database()`).Scan(&waiting); err != nil {
				t.Fatal(err)
			} else if waiting >= n {
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("expected %d blocked lock requests", n)
	}
	waitBlocked(1) // the pin wrote its event and waits on the slab

	type raised struct {
		head uint64
		err  error
	}
	raiseDone := make(chan raised, 1)
	f := testFence(1, 1, 1)
	go func() {
		_, head, err := store.RaiseFence(e.acc, f)
		raiseDone <- raised{head, err}
	}()
	select {
	case r := <-raiseDone:
		t.Fatalf("the raise completed (head %d, err %v) while an unfenced pin was in flight", r.head, r.err)
	case <-time.After(time.Second):
	}
	if err := lockTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	} else if err := <-pinErr; err != nil {
		t.Fatal(err)
	}
	r := <-raiseDone
	if r.err != nil {
		t.Fatal(r.err)
	} else if r.head != 2 {
		t.Fatalf("raise head %d, want 2 (both pins)", r.head)
	}
	var nulls int
	if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events WHERE seq IS NULL`).Scan(&nulls); err != nil || nulls != 0 {
		t.Fatalf("%d events without seq (%v)", nulls, err)
	}
	if head, all := e.listAll(t, 10); head != 2 || len(all) != 2 {
		t.Fatalf("listing head %d, %d events", head, len(all))
	}
}

// TestFenceRaiseWaitsForInflightUnfencedDelete: as TestFenceRaiseWaitsForInflightUnfencedPin, for a delete. A pin
// already holds the account row in KEY SHARE through its foreign-key checks; a delete inserts nothing, so only
// lockAccount's KEY SHARE makes the raise wait for it. Without it the backfill numbers the event first and the late
// delete then rewrites it with seq NULL: an acknowledged delete invisible to the sequence listing (mutant M13).
func TestFenceRaiseWaitsForInflightUnfencedDelete(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	a, b := e.object(1), e.object(2)
	for _, o := range []slabs.SealedObject{a, b} {
		if err := store.PinObject(e.acc, o.PinRequest()); err != nil {
			t.Fatal(err)
		}
	}

	// hold the object row the delete locks right after lockAccount
	lockTx, err := store.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lockTx.Rollback(t.Context()) }()
	if _, err := lockTx.Exec(t.Context(), `SELECT id FROM objects WHERE object_key = $1 FOR UPDATE`, sqlHash256(b.ID())); err != nil {
		t.Fatal(err)
	}
	delErr := make(chan error, 1)
	go func() { delErr <- store.DeleteObject(e.acc, b.ID()) }()
	for i := 0; ; i++ {
		var waiting int
		if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
			WHERE NOT l.granted AND a.datname = current_database()`).Scan(&waiting); err != nil {
			t.Fatal(err)
		} else if waiting > 0 {
			break
		} else if i == 100 {
			t.Fatal("expected the delete to block on the object row")
		}
		time.Sleep(50 * time.Millisecond)
	}

	type raised struct {
		head uint64
		err  error
	}
	raiseDone := make(chan raised, 1)
	go func() {
		_, head, err := store.RaiseFence(e.acc, testFence(1, 1, 1))
		raiseDone <- raised{head, err}
	}()
	select {
	case r := <-raiseDone:
		t.Fatalf("the raise completed (head %d, err %v) while an unfenced delete was in flight", r.head, r.err)
	case <-time.After(time.Second):
	}
	if err := lockTx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	} else if err := <-delErr; err != nil {
		t.Fatal(err)
	}
	r := <-raiseDone
	if r.err != nil {
		t.Fatal(r.err)
	}
	var nulls int
	if err := store.pool.QueryRow(t.Context(), `SELECT COUNT(*) FROM object_events WHERE seq IS NULL`).Scan(&nulls); err != nil || nulls != 0 {
		t.Fatalf("%d events without seq (%v)", nulls, err)
	}
	head, all := e.listAll(t, 10)
	if head != 2 || len(all) != 2 {
		t.Fatalf("listing head %d, %d events", head, len(all))
	}
	for _, ev := range all {
		if ev.Key == b.ID() && !ev.Deleted {
			t.Fatal("the acknowledged delete is not in the listing")
		}
	}
}
