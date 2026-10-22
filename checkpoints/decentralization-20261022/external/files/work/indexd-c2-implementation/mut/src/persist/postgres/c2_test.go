package postgres

// G-C2 store tests (work/indexd-c2-implementation-interface.txt) against real PostgreSQL. The operation digest is
// computed by the HTTP layer from the authenticated request; here a digest stands for "the exact operation", so
// equal digests mean an identical operation and different digests mean any change of body, key, method or sq.

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/contracts"
	"go.sia.tech/indexd/hosts"
	"go.sia.tech/indexd/sharing"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
	"lukechampine.com/frand"
)

func c2op(i int) accounts.OpID {
	var o accounts.OpID
	copy(o[:], fmt.Sprintf("op-%013d", i))
	return o
}

func c2digest(what string) accounts.OpDigest { return accounts.OpDigest(sha256.Sum256([]byte(what))) }

// v4 returns the credential c carrying a v4 part (expected head sq, op id, digest of the exact operation).
func v4(c accounts.Credential, sq uint64, op accounts.OpID, digest string) *accounts.Credential {
	c.CAS = &accounts.CASRequest{HasSq: true, Sq: sq, Op: op, Digest: c2digest(digest)}
	return &c
}

func (e *fenceEnv) raiseMode(t *testing.T, f accounts.Fence, mode string) accounts.Credential {
	t.Helper()
	r, _, err := e.store.RaiseFence(e.acc, f, mode)
	if err != nil {
		t.Fatalf("raise %v mode %q: %v", f, mode, err)
	}
	return accounts.Credential{Fence: f, Receipt: r}
}

func assertCAS(t *testing.T, err error, kind string, seq *uint64) {
	t.Helper()
	var ce *accounts.CASConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("expected a CAS %q conflict, got %v", kind, err)
	} else if ce.Kind != kind {
		t.Fatalf("expected a CAS %q conflict, got %q (%v)", kind, ce.Kind, err)
	} else if seq != nil && (ce.Seq == nil || *ce.Seq != *seq) {
		t.Fatalf("expected the conflict to report head %d, got %v", *seq, ce.Seq)
	}
}

func u(n uint64) *uint64 { return &n }

func TestC2CASApplyAndRecord(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	st, _ := store.AccountFence(e.acc)
	if st.Mode == nil || *st.Mode != accounts.ModeCAS || st.LastOp != nil || len(st.Capabilities) != 3 || st.OpNonce != nil {
		t.Fatalf("after enrolment: %+v", st)
	}
	sf := v4(c, 0, c2op(1), "pin o1")
	if err := store.PinObjectFenced(e.acc, sf, ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	} else if sf.CAS.Result.Seq != 1 || sf.CAS.Result.Replayed {
		t.Fatalf("result %+v", sf.CAS.Result)
	}
	st, _ = store.AccountFence(e.acc)
	if st.Seq != 1 || st.LastOp == nil || *st.LastOp != c2op(1) || *st.LastOpDigest != c2digest("pin o1") {
		t.Fatalf("recorded state %+v", st)
	}
	del := v4(c, 1, c2op(2), "delete o1")
	if err := store.DeleteObjectFenced(e.acc, del, ptr(e.object(1)).ID()); err != nil {
		t.Fatal(err)
	} else if del.CAS.Result.Seq != 2 {
		t.Fatalf("delete result %+v", del.CAS.Result)
	}
}

func TestC2CASConflictHasNoSideEffects(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	for i := range 3 {
		if err := store.PinObjectFenced(e.acc, v4(c, uint64(i), c2op(i), fmt.Sprint("pin", i)), ptr(e.object(i)).PinRequest()); err != nil {
			t.Fatal(err)
		}
	}
	before := e.accountState(t)
	stBefore, _ := store.AccountFence(e.acc)
	for _, sq := range []uint64{0, 1, 2, 4, 1 << 40} {
		assertCAS(t, store.PinObjectFenced(e.acc, v4(c, sq, c2op(100+int(sq%97)), "pin new"), ptr(e.object(50)).PinRequest()), "seq", u(3))
		assertCAS(t, store.DeleteObjectFenced(e.acc, v4(c, sq, c2op(200+int(sq%97)), "del o0"), ptr(e.object(0)).ID()), "seq", u(3))
	}
	if after := e.accountState(t); after != before {
		t.Fatalf("a refused CAS mutation changed state: %s -> %s", before, after)
	}
	stAfter, _ := store.AccountFence(e.acc)
	if *stAfter.LastOp != *stBefore.LastOp || *stAfter.LastOpDigest != *stBefore.LastOpDigest || stAfter.Seq != 3 {
		t.Fatal("a refused CAS mutation changed the operation record")
	}
}

func TestC2IdenticalReplayAppliesOnce(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	o := e.object(1)
	if err := store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o1 v1"), o.PinRequest()); err != nil {
		t.Fatal(err)
	}
	before := e.accountState(t)
	for range 3 { // the lost-answer retry, possibly several times
		sf := v4(c, 0, c2op(1), "pin o1 v1")
		if err := store.PinObjectFenced(e.acc, sf, o.PinRequest()); err != nil {
			t.Fatalf("identical replay: %v", err)
		} else if !sf.CAS.Result.Replayed || sf.CAS.Result.Seq != 1 {
			t.Fatalf("identical replay result %+v", sf.CAS.Result)
		}
	}
	if after := e.accountState(t); after != before {
		t.Fatalf("a replay was applied again: %s -> %s", before, after)
	}
	// once the head has moved on, the old operation is no longer the last one: a replay of it is a seq conflict
	if err := store.PinObjectFenced(e.acc, v4(c, 1, c2op(2), "pin o2"), ptr(e.object(2)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	assertCAS(t, store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o1 v1"), o.PinRequest()), "seq", u(2))
	// a delete replay works the same way
	del := v4(c, 2, c2op(3), "delete o1")
	if err := store.DeleteObjectFenced(e.acc, del, o.ID()); err != nil {
		t.Fatal(err)
	}
	again := v4(c, 2, c2op(3), "delete o1")
	if err := store.DeleteObjectFenced(e.acc, again, o.ID()); err != nil || !again.CAS.Result.Replayed || again.CAS.Result.Seq != 3 {
		t.Fatalf("delete replay: %v %+v", err, again.CAS.Result)
	}
}

func TestC2AlteredReplayRefused(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	o := e.object(1)
	if err := store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o1 v1"), o.PinRequest()); err != nil {
		t.Fatal(err)
	}
	before := e.accountState(t)
	// the same op id and sq, but a different operation: other body (metadata), other key, a delete instead of a pin
	o2 := o
	o2.EncryptedMetadata = []byte("altered")
	assertCAS(t, store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o1 v2"), o2.PinRequest()), "op", u(1))
	assertCAS(t, store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o9"), ptr(e.object(9)).PinRequest()), "op", u(1))
	assertCAS(t, store.DeleteObjectFenced(e.acc, v4(c, 0, c2op(1), "delete o1"), o.ID()), "op", u(1))
	if after := e.accountState(t); after != before {
		t.Fatalf("an altered replay changed state: %s -> %s", before, after)
	}
	if obj, err := store.Object(e.acc, o.ID()); err != nil || string(obj.EncryptedMetadata) == "altered" {
		t.Fatalf("the original operation's object changed: %v", err)
	}
}

func TestC2ConcurrentSameHeadOneWinner(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	for round := range 5 {
		head := uint64(round * 2)
		// 12 writers race with the same expected head and DIFFERENT operations: exactly one applies
		var wg sync.WaitGroup
		var mu sync.Mutex
		wins, seqConflicts := 0, 0
		for w := range 12 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				err := store.PinObjectFenced(e.acc, v4(c, head, c2op(round*100+w), fmt.Sprint("r", round, "w", w)), ptr(e.object(round*100+w)).PinRequest())
				mu.Lock()
				defer mu.Unlock()
				var ce *accounts.CASConflictError
				switch {
				case err == nil:
					wins++
				case errors.As(err, &ce) && ce.Kind == "seq" && ce.Seq != nil && *ce.Seq == head+1:
					seqConflicts++
				default:
					t.Errorf("unexpected: %v", err)
				}
			}()
		}
		wg.Wait()
		if wins != 1 || seqConflicts != 11 {
			t.Fatalf("round %d: %d winners, %d seq conflicts", round, wins, seqConflicts)
		}
		// two IDENTICAL copies (a clone with copied RNG sending the identical operation): one applies, one replays
		var replays, applied int
		for range 2 {
			wg.Add(1)
			go func() {
				defer wg.Done()
				sf := v4(c, head+1, c2op(9000+round), fmt.Sprint("identical ", round))
				err := store.PinObjectFenced(e.acc, sf, ptr(e.object(5000+round)).PinRequest())
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err != nil:
					t.Errorf("identical copy: %v", err)
				case sf.CAS.Result.Replayed:
					replays++
				default:
					applied++
				}
			}()
		}
		wg.Wait()
		if applied != 1 || replays != 1 {
			t.Fatalf("round %d: identical copies applied %d, replayed %d", round, applied, replays)
		}
	}
	head, all := e.listAll(t, 1000)
	if head != 10 || len(all) != 10 {
		t.Fatalf("head %d, %d events: each head value was taken by exactly one operation", head, len(all))
	}
}

func TestC2EnrolledRefusesV3OnEveryRoute(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	if err := store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin o1"), ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	slab := e.newSlabParams()
	sk := sharing.KeyRequest{PublicKey: types.GeneratePrivateKey().PublicKey(), Nonce: sharing.Nonce(frand.Bytes(32))}
	v3 := c // the exact credential, v3 form (no CAS part)
	before := e.accountState(t)
	refusals := map[string]error{
		"PinObject":          store.PinObjectFenced(e.acc, &v3, ptr(e.object(2)).PinRequest()),
		"DeleteObject":       store.DeleteObjectFenced(e.acc, &v3, ptr(e.object(1)).ID()),
		"PinSlabs":           func() error { _, err := store.PinSlabsFenced(e.acc, &v3, time.Time{}, slab); return err }(),
		"UnpinSlab":          store.UnpinSlabFenced(e.acc, &v3, e.slab.Digest()),
		"PruneSlabs":         store.PruneSlabsFenced(e.acc, &v3, time.Now()),
		"AddSharingKey":      func() error { _, err := store.AddSharingKeyFenced(e.acc, &v3, sk); return err }(),
		"DeleteSharingKey":   store.DeleteSharingKeyFenced(e.acc, &v3, sk.PublicKey),
		"AddSharedObject":    store.AddSharedObjectFenced(e.acc, &v3, sk.PublicKey, sharing.SharedObjectRequest{ObjectID: ptr(e.object(1)).ID()}),
		"DeleteSharedObject": store.DeleteSharedObjectFenced(e.acc, &v3, sk.PublicKey, ptr(e.object(1)).ID()),
	}
	for name, err := range refusals {
		var ce *accounts.CASConflictError
		if !errors.As(err, &ce) || ce.Kind != "mode" || ce.Mode != accounts.ModeCAS {
			t.Fatalf("%s: expected a mode refusal, got %v", name, err)
		}
	}
	if after := e.accountState(t); after != before {
		t.Fatalf("a v3 mutation changed an enrolled account: %s -> %s", before, after)
	}
	// a stranger (wrong credential) still gets the FENCE refusal first, unchanged
	assertFenced(t, store.PinObjectFenced(e.acc, nil, ptr(e.object(3)).PinRequest()), &c.Fence)
	// non-advancing routes accept v4 without sq; with sq it is a precondition
	nonAdv := c
	nonAdv.CAS = &accounts.CASRequest{Op: c2op(7), Digest: c2digest("pin slab")}
	if _, err := store.PinSlabsFenced(e.acc, &nonAdv, time.Time{}, slab); err != nil {
		t.Fatalf("v4 pin slabs without sq: %v", err)
	}
	assertCAS(t, store.PruneSlabsFenced(e.acc, v4(c, 0, c2op(8), "prune"), time.Now()), "seq", u(1))
	if err := store.PruneSlabsFenced(e.acc, v4(c, 1, c2op(9), "prune"), time.Now()); err != nil {
		t.Fatalf("prune with the right head: %v", err)
	}
	// a head-advancing route in v4 form without sq is a request error
	noSq := c
	noSq.CAS = &accounts.CASRequest{Op: c2op(10), Digest: c2digest("x")}
	if err := store.PinObjectFenced(e.acc, &noSq, ptr(e.object(4)).PinRequest()); !errors.Is(err, accounts.ErrCASSeqRequired) {
		t.Fatalf("v4 pin without sq: %v", err)
	}
}

func TestC2UnenrolledAndLegacyUnchanged(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	// unfenced account: stock behaviour
	u0 := newFenceEnv(t, store)
	if err := store.PinObject(u0.acc, ptr(u0.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	if st, _ := store.AccountFence(u0.acc); st.Mode != nil || st.Fence != nil {
		t.Fatalf("unfenced account state %+v", st)
	}
	// fenced, NOT enrolled: v3 works, and v4 (optional) works too; mixing them is fine
	e := newFenceEnv(t, store)
	c := e.raise(t, testFence(1, 1, 1))
	if err := store.PinObjectFenced(e.acc, &c, ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatalf("v3 on a fenced, unenrolled account: %v", err)
	}
	if err := store.PinObjectFenced(e.acc, v4(c, 1, c2op(1), "v4 pin"), ptr(e.object(2)).PinRequest()); err != nil {
		t.Fatalf("v4 on an unenrolled account: %v", err)
	}
	if err := store.DeleteObjectFenced(e.acc, &c, ptr(e.object(1)).ID()); err != nil {
		t.Fatalf("v3 after v4: %v", err)
	}
	if st, _ := store.AccountFence(e.acc); st.Mode != nil || st.Seq != 3 {
		t.Fatalf("unenrolled state %+v", st)
	}
}

func TestC2RaiseModeStickyAndClearsLastOp(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	f1 := testFence(1, 1, 1)
	c1 := e.raiseMode(t, f1, accounts.ModeCAS)
	if err := store.PinObjectFenced(e.acc, v4(c1, 0, c2op(1), "pin o1"), ptr(e.object(1)).PinRequest()); err != nil {
		t.Fatal(err)
	}
	// a raise WITHOUT mode on an enrolled account is refused, and installs nothing
	_, _, err := store.RaiseFence(e.acc, testFence(1, 2, 1), "")
	assertCAS(t, err, "mode", nil)
	if st, _ := store.AccountFence(e.acc); *st.Fence != f1 || st.LastOp == nil {
		t.Fatal("a refused downgrade raise changed the fence or the operation record")
	}
	// a higher raise WITH mode: the new generation starts with NO operation record
	f2 := testFence(1, 2, 1)
	c2 := e.raiseMode(t, f2, accounts.ModeCAS)
	st, _ := store.AccountFence(e.acc)
	if st.LastOp != nil || st.LastOpDigest != nil || st.Seq != 1 || st.Mode == nil {
		t.Fatalf("after the raise: %+v", st)
	}
	// the previous generation's operation, replayed under the NEW credential with the same head/op/digest: refused
	assertCAS(t, store.PinObjectFenced(e.acc, v4(c2, 0, c2op(1), "pin o1"), ptr(e.object(1)).PinRequest()), "seq", u(1))
	// and under the OLD credential: the fence refuses it
	assertFenced(t, store.PinObjectFenced(e.acc, v4(c1, 0, c2op(1), "pin o1"), ptr(e.object(1)).PinRequest()), &f2)
	// enrolment survives a restart (a fresh Store on the same database)
	s2, err := NewStore(context.Background(), connectionInfoFromEnv(), contracts.DefaultMaintenanceSettings, hosts.DefaultUsabilitySettings, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	if st, _ := s2.AccountFence(e.acc); st.Mode == nil || *st.Mode != accounts.ModeCAS {
		t.Fatal("enrolment did not survive a restart")
	}
	_, _, err = s2.RaiseFence(e.acc, testFence(1, 3, 1), "")
	assertCAS(t, err, "mode", nil)
	if err := s2.PinObjectFenced(e.acc, &c2, ptr(e.object(2)).PinRequest()); err == nil {
		t.Fatal("v3 accepted after a restart")
	}
}

func TestC2BlockUnblockRepairAndRollback(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	c := e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	a, b := e.object(1), e.object(2)
	if err := store.PinObjectFenced(e.acc, v4(c, 0, c2op(1), "pin a"), a.PinRequest()); err != nil {
		t.Fatal(err)
	}
	st0, _ := store.AccountFence(e.acc)
	// admin block/unblock and slab repair do not move the head or the operation record
	if err := store.BlockObject(b.ID(), "admin"); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordSlabMigrated(e.slab.Digest()); err != nil {
		t.Fatal(err)
	}
	// a CAS pin of the blocked key with the right head: 451, nothing applied, head and record unchanged
	if err := store.PinObjectFenced(e.acc, v4(c, 1, c2op(2), "pin b"), b.PinRequest()); !errors.Is(err, slabs.ErrObjectBlocked) {
		t.Fatalf("expected ErrObjectBlocked, got %v", err)
	}
	// a CAS pin whose slab is not pinned: refused AFTER the CAS check; the transaction rolls back completely
	unpinned := e.newSlabParams()
	bad := slabs.SealedObject{EncryptedDataKey: frand.Bytes(72), DataSignature: types.Signature(frand.Bytes(64)), MetadataSignature: types.Signature(frand.Bytes(64)),
		Slabs: []slabs.SlabSlice{unpinned.Slice(0, 1)}}
	if err := store.PinObjectFenced(e.acc, v4(c, 1, c2op(3), "pin bad"), bad.PinRequest()); !errors.Is(err, slabs.ErrObjectUnpinnedSlab) {
		t.Fatalf("expected ErrObjectUnpinnedSlab, got %v", err)
	}
	if err := store.UnblockObject(b.ID()); err != nil {
		t.Fatal(err)
	}
	st1, _ := store.AccountFence(e.acc)
	if st1.Seq != st0.Seq || *st1.LastOp != *st0.LastOp || *st1.LastOpDigest != *st0.LastOpDigest {
		t.Fatalf("admin actions or refused mutations moved the head or the record: %+v -> %+v", st0, st1)
	}
	// after the unblock the same head is still expected: the writer continues without any resync
	if err := store.PinObjectFenced(e.acc, v4(c, 1, c2op(4), "pin b"), b.PinRequest()); err != nil {
		t.Fatalf("pin after unblock: %v", err)
	}
	if head, all := e.listAll(t, 10); head != 2 || len(all) != 2 || all[0].Blocked || all[1].Blocked {
		t.Fatalf("listing after unblock: head %d %+v", head, all)
	}
}

// TestC2DownMigration applies migration/down-28-to-27.sql: refused while an account is enrolled, unless the operator
// acknowledges in the session; then only the G-C2 columns go and db_version is 27.
func TestC2DownMigration(t *testing.T) {
	store := initPostgres(t, zap.NewNop())
	e := newFenceEnv(t, store)
	e.raiseMode(t, testFence(1, 1, 1), accounts.ModeCAS)
	down, err := os.ReadFile("../../../migration/down-28-to-27.sql")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := store.pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	run := func() error {
		tx, err := conn.Begin(ctx)
		if err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, string(down)); err != nil {
			tx.Rollback(ctx)
			return err
		}
		return tx.Commit(ctx)
	}
	if err := run(); err == nil {
		t.Fatal("the down migration ran while an account is enrolled, without acknowledgement")
	}
	var v int
	store.pool.QueryRow(ctx, `SELECT db_version FROM global_settings`).Scan(&v)
	if v != 28 {
		t.Fatalf("a refused down migration changed db_version to %d", v)
	}
	if _, err := conn.Exec(ctx, `SET indexd.allow_cas_downgrade = 'on'`); err != nil {
		t.Fatal(err)
	}
	if err := run(); err != nil {
		t.Fatalf("acknowledged down migration: %v", err)
	}
	var cols int
	store.pool.QueryRow(ctx, `SELECT db_version FROM global_settings`).Scan(&v)
	store.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('last_op','last_op_digest','cas_mode')`).Scan(&cols)
	var fenceCols int
	store.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('fence','fence_receipt','event_seq','seq_enabled','fence_pending')`).Scan(&fenceCols)
	if v != 27 || cols != 0 || fenceCols != 5 {
		t.Fatalf("after down: db_version %d, %d C2 columns, %d fence columns", v, cols, fenceCols)
	}
}
