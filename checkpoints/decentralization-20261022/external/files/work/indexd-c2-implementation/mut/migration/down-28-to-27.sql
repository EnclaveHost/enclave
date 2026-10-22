-- G-C2 rollback 28 -> 27: removes ONLY the G-C2 columns/constraints and restores db_version 27 (the indexd-fence
-- release 61413110 refuses a newer db_version). Kept: everything else, including fences, receipts and seq.
-- SAFETY: enrolled (cas_mode) accounts would silently lose CAS protection (v3 writes accepted again). This script
-- therefore REFUSES while any account is enrolled, unless the operator acknowledges it in the same session:
--     SET indexd.allow_cas_downgrade = 'on';
-- and only after EVERY writer of every enrolled account is stopped.
-- Run: psql -v ON_ERROR_STOP=1 --single-transaction -f down-28-to-27.sql
DO $$
BEGIN
  IF (SELECT db_version FROM global_settings) <> 28 THEN
    RAISE EXCEPTION 'rollback expects db_version 28, found %', (SELECT db_version FROM global_settings);
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE cas_mode)
     AND coalesce(current_setting('indexd.allow_cas_downgrade', true), '') <> 'on' THEN
    RAISE EXCEPTION 'refusing: % account(s) are enrolled in cas mode; stop their writers and SET indexd.allow_cas_downgrade = ''on'' to acknowledge',
      (SELECT count(*) FROM accounts WHERE cas_mode);
  END IF;
END $$;
ALTER TABLE accounts DROP CONSTRAINT accounts_cas_needs_fence;
ALTER TABLE accounts DROP CONSTRAINT accounts_last_op_pair;
ALTER TABLE accounts DROP COLUMN cas_mode, DROP COLUMN last_op_digest, DROP COLUMN last_op;
UPDATE global_settings SET db_version = 27;
