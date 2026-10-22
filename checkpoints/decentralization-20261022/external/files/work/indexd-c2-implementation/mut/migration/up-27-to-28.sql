-- G-C2 migration 27 -> 28 (REVIEW/AUDIT COPY). The G-C2 binary applies exactly this SQL itself at startup, inside ONE
-- transaction together with "UPDATE global_settings SET db_version = 28" (persist/postgres/init.go upgradeDatabase).
-- Do not run this file by hand; it is extracted verbatim from src/persist/postgres/migrations.go (the last migration)
-- so the reviewed text and the binary's text can be compared. Rollback: down-28-to-27.sql.
-- G-C2 (work/indexd-c2-implementation-interface.txt): conditional head with an exact-operation record, and a sticky
-- enrolment. Accounts that never enrol keep cas_mode FALSE and last_op NULL, and behave exactly as before.
ALTER TABLE accounts ADD COLUMN last_op BYTEA CHECK (last_op IS NULL OR LENGTH(last_op) = 16);
ALTER TABLE accounts ADD COLUMN last_op_digest BYTEA CHECK (last_op_digest IS NULL OR LENGTH(last_op_digest) = 32);
ALTER TABLE accounts ADD CONSTRAINT accounts_last_op_pair CHECK ((last_op IS NULL) = (last_op_digest IS NULL));
ALTER TABLE accounts ADD COLUMN cas_mode BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE accounts ADD CONSTRAINT accounts_cas_needs_fence CHECK (fence IS NOT NULL OR NOT cas_mode);
