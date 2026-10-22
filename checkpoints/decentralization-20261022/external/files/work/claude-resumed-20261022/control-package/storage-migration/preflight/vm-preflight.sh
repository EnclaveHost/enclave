#!/bin/bash
# ROOT ONLY, READ-ONLY, run AS ROOT ON the 'enclave-storage' VM (root's own transport; never run by its author).
# Establishes the facts the in-place upgrade needs, against the rehearsed pins. Prints KEY=VALUE only:
#   - hashes, counts, versions, settings, unit METADATA, file modes/sizes;
#   - NEVER a config value, password, phrase, row or key;
#   - indexd.yml / postgres.env are only stat'ed, never read.
# It starts, stops, writes, restarts and repoints nothing: SELECT/SHOW/pg_dump --schema-only, sha256sum of binaries and
# public data, and one unauthenticated GET of the app API's /fence route (404 on v0.6.0, the rehearsal's check).
#   bash vm-preflight.sh < digest.sql      (digest.sql = indexd-c2-implementation/package/migration/digest.sql 7f4b137f...)
set -u
PG=enclave-indexd-postgres; DB=indexd
kv() { printf '%s=%s\n' "$1" "$2"; }
kv at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kv binary.path_sha256 "$(sha256sum /opt/enclave-indexd/indexd 2>/dev/null | cut -d' ' -f1 || echo absent)"
kv binary.is_symlink "$([ -L /opt/enclave-indexd/indexd ] && echo yes || echo no)"
kv releases_dir "$([ -d /opt/enclave-indexd/releases ] && echo present || echo absent)"
kv unit.execstart "$(systemctl show enclave-indexd -p ExecStart --value 2>/dev/null | grep -o 'path=[^ ;]*' | head -1)"
kv unit.active "$(systemctl show enclave-indexd -p ActiveState --value 2>/dev/null)"
kv unit.started "$(systemctl show enclave-indexd -p ExecMainStartTimestamp --value 2>/dev/null)"
kv unit.dropins "$(ls /etc/systemd/system/enclave-indexd.service.d 2>/dev/null | tr '\n' ',' )"
kv unit.fragment_sha256 "$(sha256sum /etc/systemd/system/enclave-indexd.service 2>/dev/null | cut -d' ' -f1)"
kv pg.unit.fragment_sha256 "$(sha256sum /etc/systemd/system/enclave-indexd-postgres.service 2>/dev/null | cut -d' ' -f1)"
kv allow_live_start "$([ -e /etc/enclave-indexd/ALLOW_LIVE_START ] && echo present || echo absent)"
kv config.stat "$(stat -c '%a %U:%G %s' /etc/enclave-indexd/indexd.yml 2>/dev/null || echo absent)"
kv geoip_sha256 "$(sha256sum /var/lib/enclave-indexd/state/GeoLite2-City.mmdb 2>/dev/null | cut -d' ' -f1 || echo absent)"
kv state.consensus_bytes "$(stat -c %s /var/lib/enclave-indexd/state/consensus.db 2>/dev/null || echo absent)"
kv state.du_bytes "$(du -sb /var/lib/enclave-indexd/state 2>/dev/null | cut -f1)"; kv pg.du_bytes "$(du -sb /var/lib/enclave-indexd/postgres 2>/dev/null | cut -f1)"
kv disk.var_lib_free_bytes "$(df -PB1 /var/lib/enclave-indexd | awk 'NR==2 {print $4}')"; kv disk.opt_free_bytes "$(df -PB1 /opt | awk 'NR==2 {print $4}')"
kv mem.available_mib "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"; kv swap.total_kib "$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
kv pg.container_image "$(docker inspect -f '{{.Image}}' $PG 2>/dev/null)"; kv pg.container_config_image "$(docker inspect -f '{{.Config.Image}}' $PG 2>/dev/null)"
kv pg.running "$(docker inspect -f '{{.State.Running}}' $PG 2>/dev/null)"
q() { docker exec $PG sh -c 'psql -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1 -c "$2"' psql "$DB" "$1" 2>/dev/null | tr '\n' ' ' | sed 's/ $//'; }
kv pg.server_version "$(q 'SHOW server_version')"; kv pg.fsync "$(q 'SHOW fsync')"; kv pg.synchronous_commit "$(q 'SHOW synchronous_commit')"
kv db.version "$(q 'SELECT db_version FROM global_settings')"
kv db.size_bytes "$(q "SELECT pg_database_size('indexd')")"
for t in objects slabs contracts accounts; do kv db.count.$t "$(q "SELECT count(*) FROM $t")"; done
kv db.tables "$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
kv db.invalid_constraints "$(q 'SELECT count(*) FROM pg_constraint WHERE NOT convalidated')"; kv db.invalid_indexes "$(q 'SELECT count(*) FROM pg_index WHERE NOT indisvalid')"
kv db.fence_columns "$(q "SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('fence','fence_receipt','event_seq','seq_enabled','fence_pending','last_op','last_op_digest','cas_mode')")"
# the rehearsal's schema hash: pg_dump --schema-only, dropping '--' comment lines and \restrict/\unrestrict lines, joined by \n
kv db.schema_sha256 "$(docker exec $PG sh -c 'pg_dump -U "$POSTGRES_USER" --schema-only --no-owner --no-acl "$1"' pg_dump "$DB" 2>/dev/null \
  | python3 -c 'import sys,hashlib; t="\n".join(l for l in sys.stdin.read().splitlines() if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l); print(hashlib.sha256(t.encode()).hexdigest())')"
# the package digest (stdin = digest.sql): one line per table name|rows|md5 aggregate (no values); live, so it moves with writes
if [ ! -t 0 ]; then
  docker exec -i $PG sh -c 'psql -U "$POSTGRES_USER" -d "$1" -XAt -v ON_ERROR_STOP=1 -f -' psql "$DB" 2>/dev/null | sed 's/^/digest./; s/|/=/'
fi
kv app.fence_status "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://127.0.0.1:9982/fence 2>/dev/null || echo unreachable)"
