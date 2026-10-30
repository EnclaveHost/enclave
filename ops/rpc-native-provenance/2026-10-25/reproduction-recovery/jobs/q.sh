#!/bin/bash
# q.sh MIB NAME CMD... : CMD via the shared queue (memory guard, 16 GiB floor) inside a private user+network namespace with only lo
# (offline). Retries only exit 98 (not started), 30 s apart; never bypasses the guard. -> logs/NAME.{out,guard,rc}; refuses to reuse NAME.
mib=$1; name=$2; shift 2
d=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/native-provenance-audit-stage/reproduce/logs
[ ! -e "$d/$name.rc" ] && [ ! -e "$d/$name.out" ] || { echo "logs/$name exists"; exit 2; }
for i in $(seq 1 240); do
  python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib "$mib" --log "$d/$name.guard" -- \
    unshare -r -n -- bash -c 'ip link set lo up && exec "$@"' q "$@" >"$d/$name.out" 2>&1
  rc=$?; [ $rc -ne 98 ] && break
  echo "[q.sh] try $i: 98 not started $(date -u +%FT%TZ)" >>"$d/$name.retries"; mv "$d/$name.out" "$d/$name.try$i.out"; sleep 30
done
echo $rc >"$d/$name.rc"; exit $rc
