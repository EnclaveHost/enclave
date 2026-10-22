-- indexd-fence rollback 27 -> 26: removes ONLY the additive fencing objects and restores the stock v0.6.0 schema
-- version, so the stock v0.6.0 binary (which refuses a newer db_version) can start on the same data.
-- Kept: every account, signed account identity (public_key), object, slab, sector, contract, host, sharing key,
-- shared object, blocked object and object event row. Discarded: installed fences, receipts and seq numbers.
-- PRECONDITIONS (enforced by replicactl rollback, documented in ROLLOUT.md):
--   * the indexd process is stopped;
--   * EVERY fenced writer of every account is stopped first: after this, an unfenced (stock) writer is accepted again.
-- Run: psql -v ON_ERROR_STOP=1 --single-transaction -f down-27-to-26.sql
DO $$
BEGIN
  IF (SELECT db_version FROM global_settings) <> 27 THEN
    RAISE EXCEPTION 'rollback expects db_version 27, found %', (SELECT db_version FROM global_settings);
  END IF;
END $$;
DROP INDEX object_events_account_id_seq_idx;
ALTER TABLE object_events DROP COLUMN seq;
ALTER TABLE accounts DROP CONSTRAINT accounts_seq_enabled_needs_fence;
ALTER TABLE accounts DROP CONSTRAINT accounts_fence_receipt_pair;
ALTER TABLE accounts DROP COLUMN fence_pending, DROP COLUMN seq_enabled, DROP COLUMN event_seq,
  DROP COLUMN fence_receipt, DROP COLUMN fence;
UPDATE global_settings SET db_version = 26;
