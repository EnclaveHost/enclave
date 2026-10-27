#!/bin/bash
# capture-namespace-qualification-stage/r1: ACTUAL namespace test of state-fixture-capture-stage/r3's read-only path set (PREPARED by Claude 1895;
# NOT run by Claude). Normal queue, MAIN lane 512 (no recovery-driver hold; a private namespace is invisible to the driver):
#   bash jobs/q-exit-status.sh cnq-r1 512 bash capture-namespace-qualification-stage/r1/jobs/ns-qual.sh
# 1. OUTSIDE: cnq.py precheck = pins, all 5 roots present (no skip-as-pass), NO stage mount / recovery FUSE view that ns_harden would
#    clone (refused BEFORE any clone), a NEW 0700 work dir on /vm (253:1). 2. `unshare -Urnm bash jobs/ns-inner.sh` hardens exactly as r3
#    inner.sh (pinned r12 ns_harden) and checks inside; it holds the namespace until RELEASE (<= 120 s). 3. While it is alive, the PARENT
#    checks every root is still writable for itself and its mount table is unchanged. 4. ONE receipt; pass only if every check of every root
#    held. Writes: tiny probe/marker files in the /vm work dir (kept) + KB logs here. No fixture, build, part, backup or original.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
[ $# = 0 ] || { echo "usage: ns-qual.sh (no arguments)"; exit 9; }
U=$(id -u); G=$(id -g); [ "$U" != 0 ] || { echo "## REFUSED: run as the owner, never root"; exit 9; }
TS=$(date -u +%Y%m%dT%H%M%SZ)
O=$S/runs/ns-qual-$TS-$$; mkdir -p -m 0700 "$S/runs" && mkdir -m 0700 "$O" || exit 9
WORK=/vm/enclave-volumes/tr004-base-recovery-20261026/capture-ns-qual-$TS-$$
mkdir -m 0700 "$WORK" || { echo "## REFUSED: cannot create the NEW work dir $WORK"; exit 9; }
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/cnq.py" precheck "$U" "$WORK" > "$O/precheck.out" 2>&1; prc=$?
cat "$O/precheck.out"
[ $prc = 0 ] || { echo "## cnq-r1 rc=$prc (refused BEFORE any namespace clone)"; exit $prc; }
trap ':' TERM INT HUP                                       # the inner namespace ends on its own (<= 120 s); the evidence is still taken
unshare -Urnm bash "$S/jobs/ns-inner.sh" "$U" "$G" "$WORK" > "$O/inner.out" 2>&1 & IP=$!
for _ in $(seq 240); do [ -e "$WORK/HARDENED" ] || ! kill -0 $IP 2>/dev/null && break; sleep 0.5; done
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/cnq.py" parent "$U" "$WORK" "$IP" > "$O/parent.out" 2>&1; parc=$?
: > "$WORK/RELEASE"
wait $IP; irc=$?
cat "$O/inner.out" "$O/parent.out"
env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/cnq.py" receipt "$U" "$WORK" "$O"; rc=$?
[ $irc = 0 ] && [ $parc = 0 ] || { echo "## inner rc $irc / parent rc $parc"; [ $rc = 0 ] && rc=4; }
grep -qF "$WORK" /proc/self/mountinfo && { echo "## a mount of $WORK is visible in the parent"; rc=4; }
echo "## work $WORK (kept)"; echo "## outputs $O"; echo "## cnq-r1 rc=$rc (namespace qualification only)"; exit $rc
