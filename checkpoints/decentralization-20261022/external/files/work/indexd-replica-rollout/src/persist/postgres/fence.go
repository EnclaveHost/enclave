package postgres

// FENCING PATCH (work/indexd-fencing-implementation-interface.txt): the per-account writer fence and the
// commit-ordered object event sequence.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/accounts"
	"go.sia.tech/indexd/slabs"
	"go.uber.org/zap"
)

// lockedAccount is an account row locked FOR UPDATE by the current transaction.
type lockedAccount struct {
	id         int64
	deleted    bool
	seqEnabled bool
}

// lockAccount is the FIRST statement of every account mutation: it locks the account row (held to commit) and checks
// the writer's credential `sf` against the installed fence.
//
//	installed NULL,    sf nil              -> allowed (0.6.0 behaviour)
//	installed NULL,    sf set              -> FencedError{nil}
//	installed (F, R),  sf == (F, R) exactly -> allowed
//	installed (F, R),  anything else       -> FencedError{F}
//
// Lock mode (REVISION R6): a fenced account's row is locked FOR UPDATE, so its mutations are serialized and get seqs
// in commit order. An unfenced account's row is locked FOR KEY SHARE: its mutations still run concurrently, as in
// 0.6.0 (KEY SHARE is compatible with other KEY SHARE holders and with the plain UPDATEs of accounts that mutations
// make), but a raise's FOR UPDATE waits for every one of them, so the first raise's backfill sees all of their events
// and no unfenced mutation can commit after it. If a raise commits between the unlocked peek and the lock, the
// transaction is restarted (serialization failure) and takes FOR UPDATE.
//
// PostgreSQL grants a new KEY SHARE on a row held only in KEY SHARE without queuing it behind a waiting FOR UPDATE,
// so continuous unfenced writes could starve a raise. A raise therefore first commits fence_pending (a plain UPDATE,
// compatible with KEY SHARE holders); from then on mutations lock FOR UPDATE and queue behind the raise, which only
// waits for the mutations already in flight.
func lockAccount(ctx context.Context, tx *txn, account proto.Account, sf *accounts.Credential) (lockedAccount, error) {
	var fenced bool
	err := tx.QueryRow(ctx, `SELECT fence IS NOT NULL OR fence_pending FROM accounts WHERE public_key = $1`, sqlPublicKey(account)).Scan(&fenced)
	if errors.Is(err, sql.ErrNoRows) {
		return lockedAccount{}, accounts.ErrNotFound
	} else if err != nil {
		return lockedAccount{}, fmt.Errorf("failed to get account: %w", err)
	}
	query := `SELECT id, deleted_at IS NOT NULL, fence, fence_receipt, seq_enabled FROM accounts WHERE public_key = $1 FOR KEY SHARE`
	if fenced {
		query = `SELECT id, deleted_at IS NOT NULL, fence, fence_receipt, seq_enabled FROM accounts WHERE public_key = $1 FOR UPDATE`
	}
	var la lockedAccount
	var fence, receipt []byte
	err = tx.QueryRow(ctx, query, sqlPublicKey(account)).Scan(&la.id, &la.deleted, &fence, &receipt, &la.seqEnabled)
	if errors.Is(err, sql.ErrNoRows) {
		return lockedAccount{}, accounts.ErrNotFound
	} else if err != nil {
		return lockedAccount{}, fmt.Errorf("failed to lock account: %w", err)
	} else if !fenced && (fence != nil || la.seqEnabled) {
		// a raise committed after the peek: restart, the retry locks FOR UPDATE
		return lockedAccount{}, &pgconn.PgError{Code: "40001", Message: "account fence installed concurrently"}
	}
	if err := checkFence(fence, receipt, sf); err != nil {
		return lockedAccount{}, err
	}
	return la, nil
}

// checkFence compares the installed fence and receipt (nil: none) with the request's credential (nil: absent):
// exact equality of both only.
func checkFence(installed, receipt []byte, sf *accounts.Credential) error {
	switch {
	case installed == nil && sf == nil:
		return nil
	case installed == nil:
		return &accounts.FencedError{}
	case len(installed) != len(accounts.Fence{}) || len(receipt) != len(accounts.Receipt{}):
		return fmt.Errorf("stored fence has %d+%d bytes", len(installed), len(receipt)) // impossible: CHECK constraints
	}
	var cur accounts.Fence
	copy(cur[:], installed)
	if sf != nil && sf.Fence == cur && subtle.ConstantTimeCompare(sf.Receipt[:], receipt) == 1 {
		return nil
	}
	return &accounts.FencedError{Current: &cur}
}

// nextSeq hands out the account's next sequence number (the account row is already locked by lockAccount). It
// returns nil when the sequence is not enabled, so callers store NULL as 0.6.0 does.
func nextSeq(ctx context.Context, tx *txn, la lockedAccount) (*int64, error) {
	if !la.seqEnabled {
		return nil, nil
	}
	var n int64
	if err := tx.QueryRow(ctx, `UPDATE accounts SET event_seq = event_seq + 1 WHERE id = $1 RETURNING event_seq`, la.id).Scan(&n); err != nil {
		return nil, fmt.Errorf("failed to advance event sequence: %w", err)
	}
	return &n, nil
}

// AccountFence returns the account's installed fence (nil: none), the SHA-256 of its receipt and the event
// sequence head.
func (s *Store) AccountFence(account proto.Account) (st accounts.FenceState, err error) {
	err = s.transaction(func(ctx context.Context, tx *txn) error {
		var raw, receipt []byte
		var seq int64
		err := tx.QueryRow(ctx, `SELECT fence, fence_receipt, event_seq FROM accounts WHERE public_key = $1 AND deleted_at IS NULL`, sqlPublicKey(account)).Scan(&raw, &receipt, &seq)
		if errors.Is(err, sql.ErrNoRows) {
			return accounts.ErrNotFound
		} else if err != nil {
			return fmt.Errorf("failed to get fence: %w", err)
		}
		st = accounts.FenceState{Seq: uint64(seq)}
		if raw != nil {
			var f accounts.Fence
			copy(f[:], raw)
			h := accounts.ReceiptDigest(sha256.Sum256(receipt))
			st.Fence, st.ReceiptSHA256 = &f, &h
		}
		return nil
	})
	return
}

// RaiseFence installs `fence` on the account if none is installed or it is strictly greater than the installed one,
// with a fresh random receipt. An equal or lower fence is refused with a FencedError naming the installed one: an
// equal raise may come from a second process holding the same ballot, so it must not obtain a receipt (a raise whose
// response was lost is retried with a higher counter). On the first install the account's existing object events
// are numbered (backfill) and the sequence is enabled. It returns the receipt and the event sequence head.
func (s *Store) RaiseFence(account proto.Account, fence accounts.Fence) (receipt accounts.Receipt, head uint64, err error) {
	if err := fence.Validate(); err != nil {
		return accounts.Receipt{}, 0, err
	}
	// announce the raise first, in its own transaction (see lockAccount): new mutations queue behind it
	err = s.transaction(func(ctx context.Context, tx *txn) error {
		_, err := tx.Exec(ctx, `UPDATE accounts SET fence_pending = TRUE WHERE public_key = $1 AND fence IS NULL AND NOT fence_pending`, sqlPublicKey(account))
		return err
	})
	if err != nil {
		return accounts.Receipt{}, 0, fmt.Errorf("failed to announce raise: %w", err)
	}
	err = s.transaction(func(ctx context.Context, tx *txn) error {
		var id int64
		var deleted, seqEnabled bool
		var raw []byte
		var seq int64
		err := tx.QueryRow(ctx, `SELECT id, deleted_at IS NOT NULL, fence, event_seq, seq_enabled FROM accounts WHERE public_key = $1 FOR UPDATE`,
			sqlPublicKey(account)).Scan(&id, &deleted, &raw, &seq, &seqEnabled)
		if errors.Is(err, sql.ErrNoRows) {
			return accounts.ErrNotFound
		} else if err != nil {
			return fmt.Errorf("failed to lock account: %w", err)
		} else if deleted {
			return accounts.ErrNotFound
		}
		if raw != nil {
			var cur accounts.Fence
			copy(cur[:], raw)
			if fence.Compare(cur) <= 0 {
				return &accounts.FencedError{Current: &cur}
			}
		}
		if !seqEnabled {
			// number every existing event of the account (no mutation can run concurrently: they all wait for the
			// account row this transaction holds)
			var n int64
			err := tx.QueryRow(ctx, `
				WITH numbered AS (
					SELECT object_key, row_number() OVER (ORDER BY updated_at ASC NULLS LAST, object_key ASC) AS n
					FROM object_events WHERE account_id = $1
				), done AS (
					UPDATE object_events oe SET seq = numbered.n
					FROM numbered WHERE oe.account_id = $1 AND oe.object_key = numbered.object_key
					RETURNING 1
				)
				SELECT COUNT(*) FROM done`, id).Scan(&n)
			if err != nil {
				return fmt.Errorf("failed to number object events: %w", err)
			}
			seq = n
		}
		// a fresh receipt on every attempt (a retried transaction never reuses one)
		if _, err := rand.Read(receipt[:]); err != nil {
			return fmt.Errorf("failed to generate receipt: %w", err)
		}
		if _, err := tx.Exec(ctx, `UPDATE accounts SET fence = $1, fence_receipt = $2, event_seq = $3, seq_enabled = TRUE, fence_pending = FALSE WHERE id = $4`, fence[:], receipt[:], seq, id); err != nil {
			return fmt.Errorf("failed to install fence: %w", err)
		}
		head = uint64(seq)
		return nil
	})
	if err != nil {
		return accounts.Receipt{}, 0, err
	}
	return
}

// MaxSeqListLimit bounds one page of the sequence listing.
const MaxSeqListLimit = 1000

// ListObjectsSeq returns the account's object events with seq > after in seq order, at most limit, and the event
// sequence head, all from ONE repeatable-read snapshot. Deleted keys are included; blocked objects are flagged and
// their metadata withheld.
func (s *Store) ListObjectsSeq(account proto.Account, after uint64, limit int) (head uint64, events []slabs.SeqObjectEvent, err error) {
	if limit < 1 || limit > MaxSeqListLimit {
		return 0, nil, fmt.Errorf("%w: limit must be 1-%d", slabs.ErrInvalidSeqListing, MaxSeqListLimit)
	} else if after > 1<<63-1 {
		return 0, nil, fmt.Errorf("%w: after out of range", slabs.ErrInvalidSeqListing)
	}
	err = s.snapshot(func(ctx context.Context, tx *txn) error {
		var id, seq int64
		var enabled bool
		err := tx.QueryRow(ctx, `SELECT id, event_seq, seq_enabled FROM accounts WHERE public_key = $1 AND deleted_at IS NULL`, sqlPublicKey(account)).Scan(&id, &seq, &enabled)
		if errors.Is(err, sql.ErrNoRows) {
			return accounts.ErrNotFound
		} else if err != nil {
			return fmt.Errorf("failed to get account: %w", err)
		} else if !enabled {
			return accounts.ErrSeqNotEnabled
		}
		head = uint64(seq)
		rows, err := tx.Query(ctx, `
			SELECT oe.object_key, oe.was_deleted, oe.seq,
			       EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = oe.object_key)
			FROM object_events oe
			WHERE oe.account_id = $1 AND oe.seq > $2
			ORDER BY oe.seq ASC
			LIMIT $3`, id, int64(after), limit)
		if err != nil {
			return fmt.Errorf("failed to query object sequence: %w", err)
		}
		events = events[:0]
		err = forEachRow(rows, func(row pgx.CollectableRow) error {
			var e slabs.SeqObjectEvent
			var n int64
			if err := row.Scan((*sqlHash256)(&e.Key), &e.Deleted, &n, &e.Blocked); err != nil {
				return err
			}
			e.Seq = uint64(n)
			events = append(events, e)
			return nil
		})
		if err != nil {
			return fmt.Errorf("failed to scan object sequence: %w", err)
		}
		// the live, unblocked objects with their slabs, from the same snapshot
		var keys []sqlHash256
		at := make(map[types.Hash256]int)
		for i, e := range events {
			if !e.Deleted && !e.Blocked {
				keys = append(keys, sqlHash256(e.Key))
				at[e.Key] = i
			}
		}
		if len(keys) == 0 {
			return nil
		}
		rows, err = tx.Query(ctx, sqlObjectsByKey, id, keys)
		if err != nil {
			return fmt.Errorf("failed to query objects: %w", err)
		}
		byID := make(map[int64]*slabs.SealedObject, len(keys))
		err = forEachRow(rows, func(row pgx.CollectableRow) error {
			oid, key, obj, err := scanObject(row)
			if err != nil {
				return err
			}
			i, ok := at[key]
			if !ok {
				return fmt.Errorf("object %v not in the page (developer error)", key)
			}
			o := obj
			events[i].Object = &o
			byID[oid] = &o
			return nil
		})
		if err != nil {
			return fmt.Errorf("failed to scan objects: %w", err)
		} else if err := loadObjectSlabs(ctx, tx, byID); err != nil {
			return err
		}
		for _, i := range at {
			if events[i].Object == nil {
				// impossible in one snapshot (a pin writes the object and its event together)
				return fmt.Errorf("live event %v without an object in the same snapshot", events[i].Key)
			}
		}
		return nil
	})
	return
}

// snapshot runs fn in a REPEATABLE READ, READ ONLY transaction: every statement sees the same snapshot.
func (s *Store) snapshot(fn func(context.Context, *txn) error) error {
	ctx := context.Background()
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return fmt.Errorf("failed to begin snapshot transaction: %w", err)
	}
	start := time.Now()
	defer func() {
		if err := tx.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
			s.log.Error("failed to roll back snapshot transaction", zap.Error(err))
		}
		if time.Since(start) > longTxnDuration {
			s.log.Debug("long snapshot transaction", zap.Duration("elapsed", time.Since(start)))
		}
	}()
	if err := fn(ctx, &txn{tx, s.log}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
