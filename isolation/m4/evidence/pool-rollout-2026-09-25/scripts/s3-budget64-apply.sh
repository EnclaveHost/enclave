#!/usr/bin/env bash
# Steven's request (via Codex): the guest pool 16384/8 -> 65536/16. ONLY guestd's two budget flags change: the binary,
# the node CVM and its image stay. One restart; guests are adopted; the supervisor's nodeSpec follows /health.pool.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
BAK=$EV/secret/enclave-guestd.service.bak-pre-64g
OLD_TAIL=" -guest-mem-mib 16384 -guest-cpus 8"; NEW_TAIL=" -guest-mem-mib 65536 -guest-cpus 16"
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
# go/no-go: even with the WHOLE new memory axis reserved (65536 - the 5376 the canaries hold), the host keeps >= 16 GiB
[ $(( avail - (65536 - 5376) )) -ge 16384 ] || { say "NO-GO: MemAvailable ${avail} MiB leaves < 16 GiB at the full 64 GiB ceiling"; exit 10; }
awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,a,"="); f=(a[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say "NO-GO: memory PSI avg60 not 0"; exit 11; }
[ -e "$BAK" ] && { say "REFUSING: $BAK exists"; exit 12; }
[ "$(grep -c '^ExecStart=' "$U")" = 1 ] && grep -q "^ExecStart=$NEWBIN .*${OLD_TAIL}\$" "$U" || { say "REFUSING: ExecStart is not the S1 line ending in${OLD_TAIL}"; exit 13; }
check_guestd pool || { say "REFUSING: guestd is not at 16384/800 with the 3 canaries"; exit 14; }
cp -p "$U" "$BAK"; chmod 600 "$BAK"
fail() { say "BUDGET64 CHECK FAILED: $* -> rolling back to 16384/8"; $EV/s3-budget64-rollback.sh; exit 20; }
python3 - "$U" "$OLD_TAIL" "$NEW_TAIL" <<'PY' || fail "the unit edit"
import sys,os
p,old,new=sys.argv[1:]; lines=open(p).read().split("\n"); idx=[i for i,l in enumerate(lines) if l.startswith("ExecStart=") and l.endswith(old)]
assert len(idx)==1, idx; lines[idx[0]]=lines[idx[0]][:-len(old)]+new
open(p+".new","w").write("\n".join(lines)); os.replace(p+".new",p)
PY
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say "BUDGET64: daemon-reload + restart (flags now${NEW_TAIL}; binary unchanged)"
systemctl --user daemon-reload || fail "daemon-reload"
systemctl --user restart enclave-guestd.service || fail "restart"
systemctl --user show enclave-guestd.service -p ExecStart --value | grep -Fq "path=$NEWBIN ;" || fail "ExecStart is not the same binary"
systemctl --user show enclave-guestd.service -p ExecStart --value | grep -Fq -- "${NEW_TAIL# }" || fail "ExecStart lacks the new flags"
wait_for 240 check_guestd pool64 || fail "guestd did not come back at 65536/1600 with the 3 same canaries"
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] && systemctl --user is-active --quiet enclave-guestd.service || fail "not active, or restarted"
journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > $EV/budget64-guestd-journal.txt 2>&1 || true
grep -q "adopted 3 guest(s)" $EV/budget64-guestd-journal.txt && grep -q "guest pool: 3 guest(s) hold 5376 MiB / 300% CPU of 65536 MiB / 1600% CPU" $EV/budget64-guestd-journal.txt || fail "the journal lacks the adoption or pool line"
wait_for 120 public_ok || fail "the canaries do not serve"
# the supervisor follows /health.pool on its next vmHealth: node = the pool, free = min(ledger 0.7, pool 13/16)
avail64() { curl -sS --max-time 20 https://api.enclave.host/t/metal-iso0/availability | python3 -c "import json,sys; a=json.load(sys.stdin); g=a.get('guestPool') or {}; sys.exit(0 if g.get('heard') and a.get('nodeRamGb')==64 and a.get('nodeVcpus')==16 and g.get('budget')=={'memMiB':65536,'cpuPct':1600} and g.get('free')=={'memMiB':60160,'cpuPct':1300} and abs(a.get('cpuShareFree',0)-0.7)<1e-9 else 1)"; }
wait_for 180 avail64 || fail "the supervisor's availability does not show 64 GiB / 16 with free 0.7"
say "BUDGET64 APPLIED and checked (restart at $T0)"
