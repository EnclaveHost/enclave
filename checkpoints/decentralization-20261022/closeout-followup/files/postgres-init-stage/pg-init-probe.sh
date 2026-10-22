#!/bin/bash
# pg-init-probe.sh - READ-ONLY state and identity of enclave-indexd-postgres, before/after the one-flag --init unit change.
# - Root runs it on the VM:  $VMSSH 'sudo bash -s' < pg-init-probe.sh          (now)
#                            $VMSSH 'sudo bash -s -- wait' < pg-init-probe.sh  (first waits <= 180 s for the server)
# - It changes nothing and prints no secret: environment variable NAMES only, never values.
# - SQL is read-only and bounded twice: in the container by GNU `timeout --foreground` (a killed psql is reaped by
#   timeout, never orphaned to PID 1) and on the server by statement_timeout/lock_timeout. Sessions: root-init-probe.
# - Every command that could read stdin gets its own input: the script itself arrives on stdin.
set -u
PG=enclave-indexd-postgres UF=/etc/systemd/system/enclave-indexd-postgres.service
q() {   # $1 db, $2 sql
  timeout 40 docker exec -e PGAPPNAME=root-init-probe \
    -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000' \
    "$PG" sh -c 'exec timeout --foreground -s KILL 20 psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"' psql "$1" "$2" </dev/null
}
if [ "${1:-}" = wait ]; then
  ok=no
  for _ in $(seq 1 90); do
    [ "$(q postgres 'SELECT 1;' 2>/dev/null)" = 1 ] && { ok=yes; break; }
    sleep 2
  done
  echo "wait.ready=$ok"
fi
echo "unit.sha256=$(sha256sum "$UF" | cut -c1-64)"
echo "unit.stat=$(stat -c '%a %U:%G' "$UF")"
echo "unit.execStartInit=$(grep -q '^ExecStart=/usr/bin/docker run --rm --init ' "$UF" && echo yes || echo no)"
systemctl show enclave-indexd-postgres -p ActiveState -p SubState -p NeedDaemonReload -p NRestarts --no-pager </dev/null | sed 's/^/pgUnit./'
systemctl show enclave-indexd -p ActiveState -p SubState --no-pager </dev/null | sed 's/^/indexdUnit./'
echo "indexd.writerPids=$(pgrep -u enclave-indexd -x indexd | tr '\n' ' ')"
echo "docker.initBinary=$(docker info --format '{{.InitBinary}}' </dev/null 2>/dev/null)"
echo "docker.initVersion=$(docker version --format '{{range .Server.Components}}{{if eq .Name "docker-init"}}{{.Version}}{{end}}{{end}}' </dev/null 2>/dev/null)"
echo "containers=$(docker ps -a --filter 'name=^/enclave-indexd-postgres$' --format '{{.ID}}:{{.State}}' </dev/null | tr '\n' ' ')"
if [ "$(docker inspect --format '{{.State.Running}}' "$PG" </dev/null 2>/dev/null)" != true ]; then
  echo "container.running=no"; echo "probe.complete=yes"; exit 0
fi
echo "container.running=yes"
docker inspect --format 'container.image={{.Config.Image}}
container.imageId={{.Image}}
container.init={{.HostConfig.Init}}
container.network={{.HostConfig.NetworkMode}}
container.readOnly={{.HostConfig.ReadonlyRootfs}}
container.memory={{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}
container.autoRemove={{.HostConfig.AutoRemove}}
container.mounts={{range .Mounts}}{{.Type}}:{{.Source}}->{{.Destination}}:rw={{.RW}} {{end}}
container.tmpfs={{range $k, $v := .HostConfig.Tmpfs}}{{$k}}={{$v}} {{end}}
container.entrypoint={{json .Config.Entrypoint}}
container.cmd={{json .Config.Cmd}}
container.startedAt={{.State.StartedAt}}' "$PG" </dev/null
echo "container.envNames=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$PG" </dev/null | cut -d= -f1 | sort | tr '\n' ' ')"
echo "pid1.comm=$(timeout 20 docker exec "$PG" cat /proc/1/comm </dev/null)"
pm=$(timeout 20 docker exec "$PG" sh -c 'head -n 1 "$PGDATA/postmaster.pid"' </dev/null)
echo "postmaster.pid=$pm"
echo "postmaster.comm=$(timeout 20 docker exec "$PG" cat "/proc/$pm/comm" </dev/null)"
echo "container.startupLine=$(timeout 30 docker logs "$PG" </dev/null 2>&1 | grep -m 1 -oE 'database system was (shut down|interrupted|not properly shut down)[^;]*' | cut -c1-80)"
echo "pg.serverVersion=$(q postgres 'SHOW server_version;')"
echo "pg.dataDirectory=$(q postgres 'SHOW data_directory;')"
echo "pg.systemIdentifier=$(q postgres 'SELECT system_identifier FROM pg_control_system();')"
echo "pg.postmasterStart=$(q postgres 'SELECT pg_postmaster_start_time();')"
echo "pg.fsync=$(q postgres 'SHOW fsync;') pg.synchronousCommit=$(q postgres 'SHOW synchronous_commit;')"
echo "pg.databases=$(q postgres "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database;")"
echo "pg.roles=$(q postgres "SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_';")"
echo "pg.otherClientSessions=$(q postgres "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();")"
echo "db.version=$(q indexd 'SELECT db_version FROM global_settings;')"
# the controller's acknowledged-metadata digest (migration/digest.sql 7f4b137f, embedded verbatim): name|rows|md5 per table
timeout 160 docker exec -i -e PGAPPNAME=root-init-probe \
  -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000 -c lock_timeout=2000' \
  "$PG" sh -c 'exec timeout --foreground -s KILL 150 psql -U "${POSTGRES_USER:-postgres}" -d indexd -X -A -t -q -v ON_ERROR_STOP=1 -f -' <<'DIGEST_SQL' | sed 's/^\([^|]*\)|/digest.\1=/'
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
DIGEST_SQL
echo "digest.rc=${PIPESTATUS[0]}"
echo "probe.complete=yes"
