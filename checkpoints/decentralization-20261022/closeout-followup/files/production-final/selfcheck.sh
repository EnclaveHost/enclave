#!/bin/bash
# selfcheck.sh - LOCAL only (no SSH): parsers on synthetic outputs, and the gates' refusals before any VM contact.
set -u
cd /home/steven/Documents/Codex/2026-10-18/wo
P=work/resume-after-checkpoint-20261022/production-final
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
# NO VM CONTACT: a stub ssh first in PATH (exit 99, logs its arguments). The 2026-10-22 19:26Z incident (README) came
# from running a step without it once integration r4 had passed.
mkdir "$T/bin"; printf '#!/bin/sh\necho "STUB-SSH $*" >> "%s/ssh.log"; exit 99\n' "$T" > "$T/bin/ssh"; chmod +x "$T/bin/ssh"
export PATH="$T/bin:$PATH"
[ "$(command -v ssh)" = "$T/bin/ssh" ] && [ "$(timeout 5 ssh probe; echo $?)" = 99 ] || { echo "ABORT: ssh stub not effective"; exit 2; }
fail=0; t() { if "$@" >"$T/o" 2>&1; then echo "ok   $*"; else echo "FAIL $*"; cat "$T/o"; fail=1; fi; }
n() { if "$@" >"$T/o" 2>&1; then echo "FAIL (expected refusal) $*"; cat "$T/o"; fail=1; else echo "ok   refused: $* :: $(grep -m1 -E 'STOP|FAIL|NOT' "$T/o")"; fi; }
printf 'current=NONE\nunit.ActiveState=active\ndbVersion=26\nfsync=on synchronous_commit=on\nscratchDatabases=\ncontainerTimeout=timeout (GNU coreutils) 9.7\nlockHeld=no (absent)\ncontrollerSessions=12:replicactl-ab:active 13:x\n' > "$T/s"
t python3 -B $P/check_kv.py "$T/s" current=NONE dbVersion=26 fsync=on 'synchronous_commit~on|local|remote_apply' scratchDatabases= 'containerTimeout~.*GNU coreutils.*' 'lockHeld~no.*' fencedAccounts?
n python3 -B $P/check_kv.py "$T/s" controllerSessions=
n python3 -B $P/check_kv.py "$T/s" fencedAccounts=0
printf '{"runId": "x"}\n{"ok": true, "dbVersion": 27, "backupVerified": true, "digestPreserved": true, "fenceRouteStatusUnauthenticated": 401}\n' > "$T/j"
t bash -c "source <(sed -n '/^jl()/,/^}/p' $P/lib.sh); jl $T/j \"r.get('ok') is True and r.get('dbVersion') == 27 and r.get('fenceRouteStatusUnauthenticated') == 401\""
n bash -c "source <(sed -n '/^jl()/,/^}/p' $P/lib.sh); jl $T/j \"r.get('dbVersion') == 28\""
n env MRID=bad bash $P/00-gate.sh
F=20991231T000000Z-0badc0de
n env MRID=$F bash $P/10-init-swap.sh
n env MRID=$F bash $P/11-init-rollback.sh
n env MRID=$F bash $P/20-layout.sh
n env MRID=$F bash $P/30-upgrade-v27.sh
n env MRID=$F bash $P/40-upgrade-v28.sh
n env MRID=$F bash $P/50-postcheck.sh 27
n env MRID=$F bash $P/50-postcheck.sh 29
echo "stub ssh calls (all refused):"; cat "$T/ssh.log" 2>/dev/null | cut -c1-160
rm -f "$P/runs/$F"/*; rmdir "$P/runs/$F"
exit $fail
