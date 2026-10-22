package postgres

// PATCH U1 (ported from work/storage-real-indexd/indexd-u1.patch) with the FENCING PATCH changes: the listing runs in
// one REPEATABLE READ snapshot, and blocked objects can be listed flagged instead of silently left out.

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jackc/pgx/v5"
	proto "go.sia.tech/core/rhp/v4"
	"go.sia.tech/core/types"
	"go.sia.tech/indexd/slabs"
)

// ListCurrentObjects lists the account's current objects in object key order, starting after the given key: a
// listing of the objects table itself, independent of when object events are published.
//
// Every page is read from one snapshot. Pages read with consecutive `after` cursors return every object whose pin
// committed before the first page was read and that was not deleted before the page covering its key, exactly once.
// Blocked objects are left out (as in the object feed and the U1 patch) unless includeBlocked is set; then they are
// listed with Blocked set and without their metadata.
func (s *Store) ListCurrentObjects(account proto.Account, after types.Hash256, limit int, includeBlocked bool) (events []slabs.CurrentObjectEvent, err error) {
	err = s.snapshot(func(ctx context.Context, tx *txn) error {
		accountID, _, err := accountID(ctx, tx, account)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `
			SELECT o.id, o.object_key, o.encrypted_data_key, o.encrypted_meta_key, o.encrypted_metadata, o.data_signature, o.meta_signature, o.created_at, o.updated_at,
			       EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key)
			FROM objects o
			WHERE o.account_id = $1 AND o.object_key > $2
			  AND ($4 OR NOT EXISTS (SELECT 1 FROM blocked_objects b WHERE b.object_key = o.object_key))
			ORDER BY o.object_key ASC
			LIMIT $3`, accountID, sqlHash256(after), limit, includeBlocked)
		if err != nil {
			return fmt.Errorf("failed to query current objects: %w", err)
		}
		objectsByID := make(map[int64]*slabs.SealedObject)
		events = make([]slabs.CurrentObjectEvent, 0, limit)
		var objs []*slabs.SealedObject
		err = forEachRow(rows, func(row pgx.CollectableRow) error {
			var id int64
			var key types.Hash256
			var obj slabs.SealedObject
			var blocked bool
			var metaKey sql.Null[[]byte]
			if err := row.Scan(&id, (*sqlHash256)(&key), &obj.EncryptedDataKey, &metaKey, &obj.EncryptedMetadata,
				(*sqlSignature)(&obj.DataSignature), (*sqlSignature)(&obj.MetadataSignature), &obj.CreatedAt, &obj.UpdatedAt, &blocked); err != nil {
				return err
			}
			if metaKey.Valid {
				obj.EncryptedMetadataKey = metaKey.V
			}
			ev := slabs.CurrentObjectEvent{ObjectEvent: slabs.ObjectEvent{Key: key, UpdatedAt: obj.UpdatedAt}, Blocked: blocked}
			if !blocked {
				o := obj
				objectsByID[id] = &o
				ev.Object = &o
			}
			events = append(events, ev)
			objs = append(objs, ev.Object)
			return nil
		})
		if err != nil {
			return fmt.Errorf("failed to scan current objects: %w", err)
		} else if err := loadObjectSlabs(ctx, tx, objectsByID); err != nil {
			return err
		}
		for _, o := range objs {
			// impossible in one snapshot (a pin writes the object and its slab rows together)
			if o != nil && len(o.Slabs) == 0 {
				return fmt.Errorf("object without slabs in the same snapshot")
			}
		}
		return nil
	})
	return
}
