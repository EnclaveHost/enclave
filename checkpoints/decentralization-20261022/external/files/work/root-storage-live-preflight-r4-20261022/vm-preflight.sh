#!/bin/bash
# r3 = r2 22e9816d (repairs root review R1 of r1 45948990) plus two changes:
#   - psql/pg_dump connect as ${POSTGRES_USER:-postgres}. This is root's reviewed correction from its live run; production's
#     postgres.env does not set POSTGRES_USER.
#   - metadata-only facts for the production indexd.yml access model: 0640 root:enclave-indexd, read by the unit's own
#     group (stat of the file and its directory, the unit's User/Group/SupplementaryGroups, the group's gid/members, and the
#     usernames whose primary group it is). Never a file's content or a password field.
# ROOT ONLY, READ-ONLY. Run AS ROOT ON the 'enclave-storage' VM through
# root's own transport (`bash vm-preflight.sh` or `bash -s < vm-preflight.sh`); its author never runs it.
#
# Output: KEY=VALUE lines only, between preflight.version=r3 and preflight.complete=yes. For every fact KEY it also
# prints KEY.status:
#   ok | timeout | rc:N | empty | malformed:* | skipped:*
# and optionally KEY.err (first stderr line, sanitized, at most 160 chars).
#   - A failed read prints an EMPTY value and a non-ok status. It never prints a substitute value.
#   - Never printed: a config value, password, phrase, seed, row or key. indexd.yml is only stat'ed.
#   - Nothing is started, stopped, written, restarted or repointed. The script writes no file (no temp files).
#   - SQL runs as one-statement psql sessions with PGOPTIONS:
#       default_transaction_read_only=on, statement_timeout=5s, lock_timeout=1s,
#       idle_in_transaction_session_timeout=5s.
#     The session itself reports these back (pg.session.*), and the evaluator requires them.
#   - No full-data scan:
#     - counts are capped (`LIMIT COUNT_CAP+1`), reading at most 100001 tuples per table, 4 tables;
#     - the rest are catalog reads and pg_database_size (file sizes);
#     - one pg_dump --schema-only, which reads catalogs and takes ACCESS SHARE locks with --lock-wait-timeout 5 s.
#     - The full-data digest is NOT run here. It is the separate explicit opt-in vm-digest-optin.sh.
#
# Bounds:
#   - Every external command runs under `timeout -k 5 <t>`, and the process group is killed.
#   - psql/pg_dump also run under `timeout` INSIDE the container: killing the docker client alone does not stop an
#     exec'd process.
#   - pg_dump resets statement_timeout to 0 on its own connection, so it runs only when that inner timeout exists.
#   - A command is not started if it could end past BUDGET seconds. Its status is then skipped:walltime-budget.
#   - After the first SQL timeout, the remaining SQL is skipped (skipped:sql-degraded), so a slow database is not
#     queried further.
#   - Worst-case walltime: BUDGET = 300 s. Normal case: a few seconds.
set -u -o pipefail
export LC_ALL=C TZ=UTC
PG=enclave-indexd-postgres DB=indexd UNIT=enclave-indexd SVC_GROUP=enclave-indexd
BIN=/opt/enclave-indexd/indexd STATE=/var/lib/enclave-indexd/state CONF=/etc/enclave-indexd/indexd.yml
KILL=5 T_META=10 T_HASH=60 T_DU=60 T_SQL=15 T_SQL_INNER=10 T_DUMP=60 T_DUMP_INNER=50 BUDGET=300
SQL_STMT_MS=5000 SQL_LOCK_MS=1000 DUMP_LOCK_MS=5000 COUNT_CAP=100000
CUR_T=$T_META LAST_STATUS= LAST_VALUE= SQL_DEGRADED= INNER_TIMEOUT=

emit() { printf '%s=%s\n' "$1" "$2"; }
T() { timeout -k "$KILL" "$CUR_T" "$@"; }
pgopts() { printf -- '-c default_transaction_read_only=on -c statement_timeout=%s -c lock_timeout=%s -c idle_in_transaction_session_timeout=%s' "$SQL_STMT_MS" "$SQL_LOCK_MS" "$SQL_STMT_MS"; }
HASHER='
import sys, hashlib
d = sys.stdin.buffer.read()
if not d: sys.exit("empty pg_dump output: nothing hashed")
lines = d.decode("utf-8").splitlines()
if "-- PostgreSQL database dump complete" not in [l.strip() for l in lines[-6:]]: sys.exit("pg_dump output lacks its completion trailer: nothing hashed")
body = "\n".join(l for l in lines if not l.startswith("--") and "\\restrict" not in l and "\\unrestrict" not in l)
if not body.strip(): sys.exit("pg_dump output has no schema statements: nothing hashed")
print(hashlib.sha256(body.encode()).hexdigest())'

# fact [-e allow empty] [-m multi-line, joined by ','] KEY SECONDS READER ARGS...
fact() {
  local allow_empty= multi=
  while :; do case $1 in -e) allow_empty=1; shift;; -m) multi=1; shift;; *) break;; esac; done
  local key=$1 t=$2; shift 2
  if (( SECONDS + t + KILL > BUDGET )); then emit "$key" ""; emit "$key.status" skipped:walltime-budget; LAST_STATUS=skipped LAST_VALUE=; return 1; fi
  CUR_T=$t
  local raw rc line err= val= n=0 st
  raw=$("$@" </dev/null 2> >(sed 's/^/\x01/')); rc=$?
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [[ $line == $'\x01'* ]]; then [ -n "$err" ] || err=${line#?}
    else n=$((n + 1)); val=${val:+$val,}$line; fi
  done <<< "$raw"
  if (( rc == 124 || rc == 137 )); then st=timeout
  elif (( rc != 0 )); then st=rc:$rc
  elif (( n == 0 )) && [ -z "$allow_empty" ]; then st=empty
  elif (( n > 1 )) && [ -z "$multi" ]; then st=malformed:multiline
  elif (( ${#val} > 300 )); then st=malformed:too-long
  elif [[ $val == *[^\ -~]* ]]; then st=malformed:nonprintable
  else st=ok; fi
  [ "$st" = ok ] || val=
  emit "$key" "$val"; emit "$key.status" "$st"
  if [ -n "$err" ]; then err=${err//[^ -~]/?}; emit "$key.err" "${err:0:160}"; fi
  LAST_STATUS=$st LAST_VALUE=$val; [ "$st" = ok ]
}
skip() { emit "$1" ""; emit "$1.status" "skipped:$2"; LAST_STATUS=skipped LAST_VALUE=; return 1; }

# readers (each external command under T; a definite "file does not exist" is a value, every other failure a status)
r_test() { if T test "$1" "$2"; then echo "$3"; else local rc=$?; [ "$rc" = 1 ] && echo "$4" || return "$rc"; fi; }
r_sha() { if T test -e "$1"; then T sha256sum -- "$1" | cut -d' ' -f1; else local rc=$?; [ "$rc" = 1 ] && echo absent || return "$rc"; fi; }
r_stat() { if T test -e "$2"; then T stat -c "$1" -- "$2"; else local rc=$?; [ "$rc" = 1 ] && echo absent || return "$rc"; fi; }
r_lsdir() { if T test -d "$1"; then T ls -1A -- "$1"; else local rc=$?; [ "$rc" = 1 ] || return "$rc"; fi; }
r_unit() { T systemctl show "$1" -p "$2" --value; }
r_execstart() { T systemctl show "$UNIT" -p ExecStart --value | grep -m1 -o 'path=[^ ;]*'; }
r_du() { T nice -n 19 ionice -c 2 -n 7 du -sb -- "$1" | cut -f1; }
r_df() { T df -PB1 -- "$2" | awk -v c="$1" 'NR == 2 { print $c; f = 1 } END { exit !f }'; }
r_mem() { T awk -v k="$1:" -v d="$2" '$1 == k { print int($2 / d); f = 1 } END { exit !f }' /proc/meminfo; }
r_inspect() { T docker inspect -f "$1" "$PG"; }
r_inner_timeout() { T docker exec "$PG" sh -c 'command -v timeout'; }
q() {
  local pre='exec '; [ -n "$INNER_TIMEOUT" ] && pre="exec timeout -k 2 $T_SQL_INNER "
  T docker exec -e PGOPTIONS="$(pgopts)" -e PGCONNECT_TIMEOUT=5 -e PGAPPNAME=enclave-preflight-r2 "$PG" \
    sh -c "$pre"'psql -U "${POSTGRES_USER:-postgres}" -d "$1" -XAt -v ON_ERROR_STOP=1 -c "$2"' _ "$DB" "$1"
}
# the rehearsal's schema hash: pg_dump --schema-only, minus '--' comment lines and \restrict/\unrestrict lines,
# joined by \n. It is computed only from a complete dump (exit 0 + completion trailer); anything else is a failed read.
r_schema() {
  T docker exec -e PGOPTIONS="$(pgopts)" -e PGCONNECT_TIMEOUT=5 -e PGAPPNAME=enclave-preflight-r2 "$PG" \
    sh -c 'exec timeout -k 2 "$1" pg_dump -U "${POSTGRES_USER:-postgres}" --schema-only --no-owner --no-acl --lock-wait-timeout="$2" -d "$3"' \
    _ "$T_DUMP_INNER" "$DUMP_LOCK_MS" "$DB" | T python3 -c "$HASHER"
}
# group metadata: gid and supplementary member names; the password field is never printed
r_group() { T getent group "$1" | awk -F: '{ print "gid=" $3 " members=" $4; f = 1 } END { exit !f }'; }
r_group_primary() {
  local g; g=$(T getent group "$1" | cut -d: -f3) || return; [[ $g =~ ^[0-9]+$ ]] || return 3
  T getent passwd | awk -F: -v g="$g" '$4 == g { print $1 }' | sort
}
r_http() { T curl -sS -o /dev/null -w '%{http_code}' --noproxy '*' --connect-timeout 3 --max-time 5 "$1"; }
sqlfact() {
  local key=$1; shift
  [ -z "$SQL_DEGRADED" ] || { skip "$key" sql-degraded; return 1; }
  fact "$key" "$T_SQL" q "$@"; local rc=$?
  [ "$LAST_STATUS" != timeout ] || SQL_DEGRADED=1
  return "$rc"
}

main() {
  emit preflight.version r3
  emit preflight.started "$(printf '%(%Y-%m-%dT%H:%M:%SZ)T' -1)"
  if [ "$EUID" != 0 ]; then emit preflight.error not-root; return 2; fi
  emit preflight.budget_s "$BUDGET"; emit preflight.sql_statement_timeout_ms "$SQL_STMT_MS"; emit preflight.sql_lock_timeout_ms "$SQL_LOCK_MS"
  emit db.count_cap "$COUNT_CAP"
  fact binary.path_sha256 "$T_HASH" r_sha "$BIN"
  fact binary.is_symlink "$T_META" r_test -L "$BIN" yes no
  fact releases_dir "$T_META" r_test -d /opt/enclave-indexd/releases present absent
  fact unit.execstart "$T_META" r_execstart
  fact unit.active "$T_META" r_unit "$UNIT" ActiveState
  fact -e unit.started "$T_META" r_unit "$UNIT" ExecMainStartTimestamp
  fact unit.dropins_dir "$T_META" r_test -d /etc/systemd/system/enclave-indexd.service.d present absent
  fact -e -m unit.dropins "$T_META" r_lsdir /etc/systemd/system/enclave-indexd.service.d
  fact unit.fragment_sha256 "$T_HASH" r_sha /etc/systemd/system/enclave-indexd.service
  fact pg.unit.fragment_sha256 "$T_HASH" r_sha /etc/systemd/system/enclave-indexd-postgres.service
  fact allow_live_start "$T_META" r_test -e /etc/enclave-indexd/ALLOW_LIVE_START present absent
  fact config.stat "$T_META" r_stat '%a %U:%G %s' "$CONF"
  fact config.ids "$T_META" r_stat '%u:%g' "$CONF"
  fact config.type "$T_META" r_stat '%F' "$CONF"
  fact config.nlink "$T_META" r_stat '%h' "$CONF"
  fact config.dir_stat "$T_META" r_stat '%a %u' "${CONF%/*}"
  fact unit.user "$T_META" r_unit "$UNIT" User
  fact unit.group "$T_META" r_unit "$UNIT" Group
  fact -e unit.supplementary_groups "$T_META" r_unit "$UNIT" SupplementaryGroups
  fact group.service "$T_META" r_group "$SVC_GROUP"
  fact -e -m group.primary_users "$T_META" r_group_primary "$SVC_GROUP"
  fact geoip_sha256 "$T_HASH" r_sha "$STATE/GeoLite2-City.mmdb"
  fact state.consensus_bytes "$T_META" r_stat %s "$STATE/consensus.db"
  fact state.du_bytes "$T_DU" r_du "$STATE"
  fact disk.var_lib_free_bytes "$T_META" r_df 4 /var/lib/enclave-indexd
  fact disk.var_lib_total_bytes "$T_META" r_df 2 /var/lib/enclave-indexd
  fact disk.opt_free_bytes "$T_META" r_df 4 /opt
  fact mem.available_mib "$T_META" r_mem MemAvailable 1024
  fact mem.total_mib "$T_META" r_mem MemTotal 1024
  fact swap.total_kib "$T_META" r_mem SwapTotal 1
  fact pg.container_image "$T_META" r_inspect '{{.Image}}'
  fact pg.container_config_image "$T_META" r_inspect '{{.Config.Image}}'
  fact pg.running "$T_META" r_inspect '{{.State.Running}}'
  fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
  sqlfact pg.session.default_transaction_read_only 'SHOW default_transaction_read_only'
  sqlfact pg.session.statement_timeout 'SHOW statement_timeout'
  sqlfact pg.session.lock_timeout 'SHOW lock_timeout'
  sqlfact pg.server_version 'SHOW server_version'
  sqlfact pg.fsync 'SHOW fsync'
  sqlfact pg.synchronous_commit 'SHOW synchronous_commit'
  sqlfact db.version 'SELECT db_version FROM global_settings'
  sqlfact db.size_bytes 'SELECT pg_database_size(current_database())'
  local t
  for t in objects slabs contracts accounts; do sqlfact "db.count.$t" "SELECT count(*) FROM (SELECT 1 FROM $t LIMIT $((COUNT_CAP + 1))) s"; done
  sqlfact db.tables "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
  sqlfact db.invalid_constraints 'SELECT count(*) FROM pg_constraint WHERE NOT convalidated'
  sqlfact db.invalid_indexes 'SELECT count(*) FROM pg_index WHERE NOT indisvalid'
  sqlfact db.fence_columns "SELECT count(*) FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('fence','fence_receipt','event_seq','seq_enabled','fence_pending','last_op','last_op_digest','cas_mode')"
  if [ -n "$SQL_DEGRADED" ]; then skip db.schema_sha256 sql-degraded
  elif [ -z "$INNER_TIMEOUT" ]; then skip db.schema_sha256 no-inner-timeout   # pg_dump would be unbounded server-side
  else fact db.schema_sha256 "$T_DUMP" r_schema; fi
  fact app.fence_status "$T_META" r_http http://127.0.0.1:9982/fence
  emit preflight.elapsed_s "$SECONDS"
  emit preflight.complete yes
}
# PREFLIGHT_SOURCE_ONLY=1 only loads the functions (tests, vm-digest-optin.sh); it can disable, never alter, a run
[ "${PREFLIGHT_SOURCE_ONLY:-}" = 1 ] || main
