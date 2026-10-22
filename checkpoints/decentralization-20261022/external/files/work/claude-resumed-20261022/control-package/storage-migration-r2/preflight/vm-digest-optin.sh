#!/bin/bash
# r2. ROOT ONLY, READ-ONLY, SEPARATE EXPLICIT OPT-IN; never part of the initial preflight.
# Runs the package digest (digest.sql 7f4b137f..., one line per table: name|rows|md5) against the LIVE database.
#   - It prints md5 aggregates only, never a row, key, seed or credential.
#   - It is NOT needed for B1:
#     - the controller computes the same digest itself on the quiesced database during upgrade/upgrade-c2;
#     - on a live database the digest moves with writes.
#   - Use it only to record a pre-backup baseline.
# Work bound:
#   - one full read of every digested table: about the whole database, refused above --max-db-bytes;
#   - statement_timeout 30 s per statement (13 statements), lock_timeout 1 s, read-only session;
#   - 300 s outer and inner timeout.
#   bash vm-digest-optin.sh --full-data-digest --max-db-bytes <N> <path to digest.sql>
# Needs vm-preflight.sh in the same directory (its bounded helpers are reused).
set -u -o pipefail
DIGEST_SHA=7f4b137f7049753df1cc414e89e0fa2da563b84c290cf533d8d2f11765104247
here=$(cd "$(dirname "$0")" && pwd)
PREFLIGHT_SOURCE_ONLY=1 . "$here/vm-preflight.sh"
T_DIGEST=300 T_DIGEST_INNER=290 BUDGET=420
usage() { emit digest.error "usage: --full-data-digest --max-db-bytes <positive integer> <digest.sql>"; exit 2; }
[ $# = 4 ] && [ "$1" = --full-data-digest ] && [ "$2" = --max-db-bytes ] && [[ $3 =~ ^[1-9][0-9]{0,14}$ ]] || usage
MAX=$3 SQLF=$4
emit digest.version r2
[ "$EUID" = 0 ] || { emit digest.error not-root; exit 2; }
emit digest.max_db_bytes "$MAX"
fact digest.sql_sha256 "$T_META" r_sha "$SQLF"
[ "$LAST_VALUE" = "$DIGEST_SHA" ] || { emit digest.status refused:digest-sql-not-pinned; exit 1; }
fact pg.inner_timeout "$T_META" r_inner_timeout && INNER_TIMEOUT=1
[ -n "$INNER_TIMEOUT" ] || { emit digest.status refused:no-inner-timeout; exit 1; }
SQL_STMT_MS=5000 sqlfact db.size_bytes 'SELECT pg_database_size(current_database())'
[[ $LAST_VALUE =~ ^[0-9]+$ ]] || { emit digest.status refused:db-size-unknown; exit 1; }
(( LAST_VALUE <= MAX )) || { emit digest.status "refused:db-size-above-max"; exit 1; }
r_digest() {
  T docker exec -i -e PGOPTIONS="$(pgopts)" -e PGCONNECT_TIMEOUT=5 -e PGAPPNAME=enclave-digest-r2 "$PG" \
    sh -c 'exec timeout -k 2 "$1" psql -U "$POSTGRES_USER" -d "$2" -XAt -v ON_ERROR_STOP=1 -f -' _ "$T_DIGEST_INNER" "$DB" < "$SQLF"
}
CUR_T=$T_DIGEST SQL_STMT_MS=30000
out=$(r_digest); rc=$?        # psql errors go to stderr, the status line says what failed
if (( rc == 124 || rc == 137 )); then emit digest.status timeout; exit 1; fi
(( rc == 0 )) || { emit digest.status "rc:$rc"; exit 1; }
n=0
while IFS= read -r line; do
  [[ $line =~ ^[a-z_]+\|[0-9]+\|([0-9a-f]{32})?$ ]] || { emit digest.status malformed:line; exit 1; }
  n=$((n + 1))
done <<< "$out"
(( n == $(grep -c '^SELECT ' "$SQLF") )) || { emit digest.status "malformed:$n-lines"; exit 1; }
sed 's/^/digest./; s/|/=/' <<< "$out"
emit digest.status ok
emit digest.elapsed_s "$SECONDS"
emit digest.complete yes
