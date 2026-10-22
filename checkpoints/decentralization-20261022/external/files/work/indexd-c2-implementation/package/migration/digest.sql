-- Acknowledged-metadata digest of an indexd database (stock v0.6.0 schema columns only, so the same query works at
-- db_version 26 and 27). One line per table: name|rows|md5. Columns that background loops legitimately rewrite
-- (event publication time, sector/slab health, host scans, account last_used, pinned totals, stats) are excluded;
-- every user-visible, signed or identity-bearing column is included. Read-only; prints no credential.
-- Run: psql -X -A -t -v ON_ERROR_STOP=1 -f digest.sql
SELECT 'db_version|' || db_version || '|' FROM global_settings;
SELECT 'accounts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(public_key, 'hex'), max_pinned_data, encode(app_id, 'hex'), name, description, logo_url,
         service_url, deleted_at IS NOT NULL) r FROM accounts) t;
SELECT 'objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(o.object_key, 'hex'), encode(o.encrypted_data_key, 'hex'),
         encode(o.encrypted_meta_key, 'hex'), encode(o.encrypted_metadata, 'hex'), encode(o.data_signature, 'hex'),
         encode(o.meta_signature, 'hex'), o.created_at, o.updated_at) r
  FROM objects o JOIN accounts a ON a.id = o.account_id) t;
SELECT 'object_slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(o.object_key, 'hex'), encode(os.slab_digest, 'hex'), os.slab_index, os.slab_offset,
         os.slab_length) r FROM object_slabs os JOIN objects o ON o.id = os.object_id) t;
SELECT 'object_events|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(e.object_key, 'hex'), e.was_deleted) r
  FROM object_events e JOIN accounts a ON a.id = e.account_id) t;
SELECT 'slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(digest, 'hex'), encode(encryption_key, 'hex'), min_shards, version) r FROM slabs) t;
SELECT 'slab_sectors|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(s.digest, 'hex'), ss.slab_index, encode(x.sector_root, 'hex')) r
  FROM slab_sectors ss JOIN slabs s ON s.id = ss.slab_id JOIN sectors x ON x.id = ss.sector_id) t;
SELECT 'account_slabs|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(s.digest, 'hex')) r
  FROM account_slabs x JOIN accounts a ON a.id = x.account_id JOIN slabs s ON s.id = x.slab_id) t;
SELECT 'sharing_keys|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(a.public_key, 'hex'), encode(k.public_key, 'hex'), encode(k.nonce, 'hex'),
         k.use_description, k.expires_at) r FROM sharing_keys k JOIN accounts a ON a.id = k.account_id) t;
SELECT 'shared_objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(k.public_key, 'hex'), encode(o.object_key, 'hex'), encode(so.encrypted_data_key, 'hex'),
         encode(so.encrypted_meta_key, 'hex'), encode(so.encrypted_metadata, 'hex'), encode(so.data_signature, 'hex'),
         encode(so.meta_signature, 'hex')) r
  FROM shared_objects so JOIN sharing_keys k ON k.id = so.sharing_key_id JOIN objects o ON o.id = so.object_id) t;
SELECT 'blocked_objects|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(object_key, 'hex'), reason) r FROM blocked_objects) t;
SELECT 'contracts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT concat_ws(',', encode(c.contract_id, 'hex'), encode(h.public_key, 'hex')) r
  FROM contracts c JOIN hosts h ON h.id = c.host_id) t;
SELECT 'hosts|' || count(*) || '|' || coalesce(md5(string_agg(r, E'\n' ORDER BY r)), '') FROM (
  SELECT encode(public_key, 'hex') r FROM hosts) t;
