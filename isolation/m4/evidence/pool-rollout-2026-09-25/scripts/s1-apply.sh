#!/usr/bin/env bash
# S1: guestd pool build AND its flags, in ONE restart. v2 (enclave-99's review): exact-line guard, separate reload and
# restart, and post-restart checks that roll back on failure.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
OLD_LINE=$(cat $EV/s0-baseline/guestd-unit-execstart.line)
NEW_LINE="${OLD_LINE/ExecStart=\/home\/steven\/enclave-prod\/bin\/guestd /ExecStart=$NEWBIN } -guest-mem-mib 16384 -guest-cpus 8"
avail=$(awk '/^MemAvailable/{print int($2/1048576)}' /proc/meminfo); [ "$avail" -ge 40 ] || { say "NO-GO: MemAvailable ${avail} GiB < 40"; exit 10; }
awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,a,"="); f=(a[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say "NO-GO: memory PSI avg60 not 0 (or unreadable)"; exit 11; }
[ -e "$UBAK" ] && { say "REFUSING: $UBAK exists"; exit 12; }
[ "$(grep -c '^ExecStart=' "$U")" = 1 ] && grep -Fxq "$OLD_LINE" "$U" || { say "REFUSING: the unit's ExecStart is not exactly the S0 line"; exit 13; }
check_guestd nopool || { say "REFUSING: guestd is not in its S0 state"; exit 14; }
install -m 755 "$EV/build/guestd-1" "$NEWBIN.tmp" && mv "$NEWBIN.tmp" "$NEWBIN"; echo "$NEWBIN_SHA  $NEWBIN" | sha256sum -c --quiet
cp -p "$U" "$UBAK"; chmod 600 "$UBAK"
# from here on every failure rolls back (enclave-99: fail() before the first mutation it must undo)
fail() { say "S1 CHECK FAILED: $* -> rolling back"; $EV/s1-rollback.sh; exit 20; }
python3 - "$U" "$OLD_LINE" "$NEW_LINE" <<'PY' || fail "the unit edit"
import sys,os
p,old,new=sys.argv[1:]; lines=open(p).read().split("\n"); idx=[i for i,l in enumerate(lines) if l==old]
assert len(idx)==1, idx; lines[idx[0]]=new
open(p+".new","w").write("\n".join(lines)); os.replace(p+".new",p)
PY
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say "S1: daemon-reload + restart (unit now: new binary + -guest-mem-mib 16384 -guest-cpus 8)"
systemctl --user daemon-reload || fail "daemon-reload"
systemctl --user restart enclave-guestd.service || fail "restart"
systemctl --user show enclave-guestd.service -p ExecStart --value | grep -Fq "path=$NEWBIN ;" || fail "ExecStart is not the new binary"
systemctl --user show enclave-guestd.service -p ExecStart --value | grep -Fq -- "-guest-mem-mib 16384 -guest-cpus 8" || fail "ExecStart lacks the flags"
wait_for 240 check_guestd pool || fail "guestd did not come back with the pool and the 3 same canaries"
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] && systemctl --user is-active --quiet enclave-guestd.service || fail "not active, or restarted"
journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > $EV/s1-guestd-journal.txt 2>&1 || true
grep -q "adopted 3 guest(s)" $EV/s1-guestd-journal.txt && grep -q "guest pool: 3 guest(s) hold 5376 MiB / 300% CPU of 16384 MiB / 800% CPU" $EV/s1-guestd-journal.txt || fail "the journal lacks the adoption or pool line"
wait_for 120 public_ok || fail "the canaries do not serve"
say "S1 APPLIED and checked (restart at $T0)"
