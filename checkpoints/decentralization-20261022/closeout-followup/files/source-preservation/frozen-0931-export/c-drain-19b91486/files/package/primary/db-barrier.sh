#!/bin/bash
# db-barrier.sh - the rollback decision's DATABASE BARRIER on the live primary (storage-write-release, PostgreSQL drain).
#
# NOT READ-ONLY. It writes no row, but it takes a table lock that blocks writers:
# - It opens ONE transaction in the indexd database and takes LOCK TABLE accounts IN EXCLUSIVE MODE.
# - The lock waits for every transaction that holds a row lock on, or has changed, an accounts row (an enrolment
#   in flight, including one whose client process has already exited), for at most 30 s (lock_timeout).
# - While it holds the lock, every write to accounts waits (plain reads do not).
# - It then reads: the other client sessions of the database, the prepared transactions, and the enrolment counts.
# - Then it ROLLBACKs.
# - Every bound is a setting of its own session only (PGOPTIONS). It changes no server setting and ends no other session.
#
# Root runs it ONLY behind the rollback barrier (CUTOVER.md §4 R1-R3: C2 activation disabled, start guard absent, indexd
# stopped by the controller), as R4:
#   $VMSSH 'sudo bash -s' < db-barrier.sh > r4-barrier.txt
# It prints the unit/process/guard state BEFORE and AFTER the database step (pre.* / post.*), and the database step's
# lines (db.*); `barrier=complete` is printed only when every statement ran. No secret is printed.
# Serialization assumptions:
# - Every enrolment is written by a client session of the indexd database.
# - Prepared transactions (none expected) are counted, never committed or rolled back here.
# - One operator: nobody restores the start guard or starts indexd while this runs. pre/post must match.
set -u
U=enclave-indexd PG=enclave-indexd-postgres DB=indexd GUARD=/etc/enclave-indexd/ALLOW_LIVE_START
echo "barrierScript=db-barrier.v1"
proc() {   # $1 = pre|post: the unit, its processes and the start guard
  systemctl show "$U" -p ActiveState -p SubState -p MainPID -p Result -p ExecMainCode -p ExecMainStatus -p InvocationID -p NRestarts \
    --no-pager | sed "s/^/$1.unit./"
  echo "$1.writerPids=$(pgrep -u "$U" -x indexd | tr '\n' ' ')"
  echo "$1.allowLiveStart=$([ -e "$GUARD" ] && echo present || echo absent)"
}
proc pre
tv=$(timeout 30 docker exec "$PG" timeout --version 2>/dev/null | head -1)
case "$tv" in *"GNU coreutils"*) ;; *) echo "db.skipped=no GNU coreutils timeout in the container"; proc post; exit 0 ;; esac
# Bounds:
# - server side (this session only): lock wait 30 s; a statement 35 s; the transaction 60 s; idle in a transaction 10 s;
#   the client's connection checked every 1 s while a statement runs. A barrier killed during its lock wait ended at
#   lock_timeout, not at that check (fixture F3);
# - in the container: psql is KILLed at 75 s by its own timeout (no orphan);
# - here: 90 s.
out=$(timeout 90 docker exec -i -e PGAPPNAME=root-barrier \
  -e PGOPTIONS='-c lock_timeout=30000 -c statement_timeout=35000 -c transaction_timeout=60000 -c idle_in_transaction_session_timeout=10000 -c client_connection_check_interval=1000' \
  "$PG" sh -c 'exec timeout --foreground -s KILL 75 psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -f -' psql "$DB" 2>&1 <<'SQL'
BEGIN ISOLATION LEVEL READ COMMITTED;
SELECT set_config('db_barrier.t0', clock_timestamp()::text, true) IS NULL;
LOCK TABLE accounts IN EXCLUSIVE MODE;
SELECT 'lock=granted';
SELECT 'lockWaitMs=' || round(extract(epoch FROM clock_timestamp() - current_setting('db_barrier.t0')::timestamptz) * 1000);
SELECT 'otherBackends=' || count(*) || chr(10) || 'otherBackendsDetail=' ||
       coalesce(string_agg(pid || ':' || coalesce(nullif(application_name, ''), '-') || ':' || coalesce(usename::text, '-') || ':' ||
                           coalesce(state, '-') || ':' || coalesce(wait_event, '-'), ' ' ORDER BY pid), '')
  FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend';
SELECT 'preparedXacts=' || count(*) FROM pg_prepared_xacts WHERE database = current_database();
SELECT 'dbVersion=' || db_version FROM global_settings;
SELECT 'fencedAccounts=' || count(*) FROM accounts WHERE fence IS NOT NULL;
SELECT 'casEnrolledAccounts=' || count(*) FROM accounts WHERE cas_mode;
SELECT 'barrier=complete';
ROLLBACK;
SQL
)
rc=$?
printf '%s\n' "$out" | while IFS= read -r l; do
  case "$l" in
    f|t|"") ;;
    [a-zA-Z]*=*) echo "db.$l" ;;
    *) echo "db.message=$(printf '%s' "$l" | tr -d '\r' | cut -c1-200)" ;;
  esac
done
echo "db.exit=$rc"
proc post
