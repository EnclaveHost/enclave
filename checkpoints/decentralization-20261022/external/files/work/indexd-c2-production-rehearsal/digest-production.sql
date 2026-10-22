-- PRODUCTION-SCOPED acknowledged-metadata digest (C2 production-copy rehearsal). DERIVED from the package's
-- migration/digest.sql (7f4b137f...) by ONE change per group: rows of the FIXTURE account (psql variable :fx = its
-- accounts.id; -1 = no fixture) are excluded: its account row, objects, object slices, events, account slabs, the slabs
-- (and their sectors) pinned only through it, sharing keys/shared objects, and blocks of keys it wrote. With fx = -1
-- every group equals the package digest (asserted by the rehearsal at baseline). Read-only; prints no row.
-- Run: psql -X -A -t -v ON_ERROR_STOP=1 -v fx=<id> -f digest-production.sql
SELECT 'db_version|' || db_version || '|' FROM global_settings;
SELECT 'accounts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(public_key, 'hex'), max_pinned_data, encode(app_id, 'hex'), name, description, logo_url,
         service_url, deleted_at IS NOT NULL) r FROM accounts WHERE id <> :fx) t;
SELECT 'objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(o.object_key, 'hex'), encode(o.encrypted_data_key, 'hex'),
         encode(o.encrypted_meta_key, 'hex'), encode(o.encrypted_metadata, 'hex'), encode(o.data_signature, 'hex'),
         encode(o.meta_signature, 'hex'), o.created_at, o.updated_at) r
  FROM objects o JOIN accounts a ON a.id = o.account_id WHERE o.account_id <> :fx) t;
SELECT 'object_slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(o.object_key, 'hex'), encode(os.slab_digest, 'hex'), os.slab_index, os.slab_offset,
         os.slab_length) r FROM object_slabs os JOIN objects o ON o.id = os.object_id WHERE o.account_id <> :fx) t;
SELECT 'object_events|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(e.object_key, 'hex'), e.was_deleted) r
  FROM object_events e JOIN accounts a ON a.id = e.account_id WHERE e.account_id <> :fx) t;
SELECT 'slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(digest, 'hex'), encode(encryption_key, 'hex'), min_shards, version) r FROM slabs WHERE id NOT IN (SELECT slab_id FROM account_slabs WHERE account_id = :fx)) t;
SELECT 'slab_sectors|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(s.digest, 'hex'), ss.slab_index, encode(x.sector_root, 'hex')) r
  FROM slab_sectors ss JOIN slabs s ON s.id = ss.slab_id JOIN sectors x ON x.id = ss.sector_id WHERE ss.slab_id NOT IN (SELECT slab_id FROM account_slabs WHERE account_id = :fx)) t;
SELECT 'account_slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(s.digest, 'hex')) r
  FROM account_slabs x JOIN accounts a ON a.id = x.account_id JOIN slabs s ON s.id = x.slab_id WHERE x.account_id <> :fx) t;
SELECT 'sharing_keys|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(k.public_key, 'hex'), encode(k.nonce, 'hex'),
         k.use_description, k.expires_at) r FROM sharing_keys k JOIN accounts a ON a.id = k.account_id WHERE k.account_id <> :fx) t;
SELECT 'shared_objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(k.public_key, 'hex'), encode(o.object_key, 'hex'), encode(so.encrypted_data_key, 'hex'),
         encode(so.encrypted_meta_key, 'hex'), encode(so.encrypted_metadata, 'hex'), encode(so.data_signature, 'hex'),
         encode(so.meta_signature, 'hex')) r
  FROM shared_objects so JOIN sharing_keys k ON k.id = so.sharing_key_id JOIN objects o ON o.id = so.object_id WHERE k.account_id <> :fx) t;
SELECT 'blocked_objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(object_key, 'hex'), reason) r FROM blocked_objects WHERE object_key NOT IN (SELECT object_key FROM object_events WHERE account_id = :fx)) t;
SELECT 'contracts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(c.contract_id, 'hex'), encode(h.public_key, 'hex')) r
  FROM contracts c JOIN hosts h ON h.id = c.host_id) t;
SELECT 'hosts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT encode(public_key, 'hex') r FROM hosts) t;
