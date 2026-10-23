#!/bin/bash
# vm-state.v2.sh - READ-ONLY state of the live primary (vm-state.sh 5ac71122 + one allowLiveStart line).
# - Root runs it on the VM: $VMSSH 'sudo bash -s' < vm-state.sh
# - It changes nothing and prints no secret.
# - It reads the database only through the container's GNU `timeout --foreground` (never an orphan to the postmaster).
# - Its sessions are tagged application_name=root-state.
set -u
R=/opt/enclave-indexd/releases PG=enclave-indexd-postgres U=enclave-indexd
echo "current=$(readlink "$R/current" 2>/dev/null || echo NONE)"
echo "currentSha=$(sha256sum "$R/current/indexd" 2>/dev/null | cut -c1-64)"
systemctl show "$U" -p ActiveState -p SubState -p MainPID -p NRestarts -p NeedDaemonReload -p ExecStart --no-pager | sed 's/^/unit./'
pid=$(systemctl show -p MainPID --value "$U")
[ "${pid:-0}" != 0 ] && echo "runningExeSha=$(sha256sum "/proc/$pid/exe" 2>/dev/null | cut -c1-64)"
echo "writerPids=$(pgrep -u "$U" -x indexd | tr '\n' ' ')"
# v2 (storage-write-release, rollback ordering): the unit's start guard (ConditionPathExists): "absent" means systemd will
# not start indexd, so no request can reach its application API while this snapshot's database counts are read
echo "allowLiveStart=$([ -e /etc/enclave-indexd/ALLOW_LIVE_START ] && echo present || echo absent)"
tv=$(timeout 30 docker exec "$PG" timeout --version 2>/dev/null | head -1)
echo "containerTimeout=$tv"
case "$tv" in *"GNU coreutils"*) ;; *) echo "db=SKIPPED: no GNU coreutils timeout in the container"; exit 0 ;; esac
q() {   # $1 db, $2 sql: bounded INSIDE the container (20 s, KILL reaped by timeout itself) and server-side (15 s)
  timeout 40 docker exec -e PGAPPNAME=root-state -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=15000 -c lock_timeout=2000' \
    "$PG" sh -c 'exec timeout --foreground -s KILL 20 psql -U "${POSTGRES_USER:-postgres}" -d "$1" -X -A -t -q -v ON_ERROR_STOP=1 -c "$2"' psql "$1" "$2"
}
v=$(q indexd 'SELECT db_version FROM global_settings;') || v=UNREADABLE
echo "dbVersion=$v"
echo "fsync=$(q indexd 'SHOW fsync;') synchronous_commit=$(q indexd 'SHOW synchronous_commit;')"
case "$v" in 27|28) echo "fencedAccounts=$(q indexd 'SELECT count(*) FROM accounts WHERE fence IS NOT NULL;')" ;; esac
[ "$v" = 28 ] && echo "casEnrolledAccounts=$(q indexd 'SELECT count(*) FROM accounts WHERE cas_mode;')"
echo "scratchDatabases=$(q postgres "SELECT coalesce(string_agg(datname, ','), '') FROM pg_database WHERE datname LIKE 'indexd\_verify%';")"
echo "controllerSessions=$(q postgres "SELECT coalesce(string_agg(pid || ':' || application_name || ':' || state, ' '), '') FROM pg_stat_activity WHERE application_name LIKE 'replicactl-%';")"
echo "toolSessions=$(q postgres "SELECT coalesce(string_agg(pid || ':' || application_name || ':' || coalesce(datname, ''), ' '), '') FROM pg_stat_activity WHERE application_name IN ('pg_dump', 'psql', 'pg_restore');")"
L=/run/enclave-indexd-snapshot.lock   # flock would create an absent file: only probe an existing one
if [ -e "$L" ]; then echo "lockHeld=$(flock -n "$L" true 2>/dev/null && echo no || echo yes)"; else echo "lockHeld=no (absent)"; fi
