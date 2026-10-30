#!/bin/bash
# journal-recovery-verifier-stage/r1 ACTUAL verification (PREPARED by Claude; NOT run by Claude). Root, offline, read-only on the copy:
#   bash jobs/q-exit-status.sh jrv-r1-verify 256 unshare -Urn bash journal-recovery-verifier-stage/r1/jobs/root-verify.sh [ABS_TARGETS_JSON]
# Default targets: targets/base-db-dir-1626.json (fs block 499122346 = current /data/db directory block; journal positions of the
# four namescan hits). Output: a NEW 0600 JSON under runs/ (<= 16 MiB). NOT a recovery acceptance; NEVER current-state proof.
set -uo pipefail
export PATH=/usr/bin:/bin
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
J=$P/logs/base-journal-copy-1626/journal-8.bin; JSHA=d95d81fcaf1fdecb305f5645bc5bf2d6093d0a7fc40affbfc769894798cbc073
T=${1:-$S/targets/base-db-dir-1626.json}
O=$S/runs/verify-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -p "$O" || exit 9
ip -4 route 2>/dev/null | grep -q . && { echo "network route present: run under unshare -Urn"; exit 9; }
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "stage != SHA256SUMS"; exit 9; }
case "$T" in /*) ;; *) echo "targets path must be absolute"; exit 9;; esac
[ "$(sha256sum < "$J" | cut -c1-64)" = "$JSHA" ] || { echo "journal copy != $JSHA"; exit 9; }
sha256sum "$T" > "$O/targets.sha256"
env -i PATH=$PATH timeout -k 10 3600 python3 -I -B "$S/jbd2_verify.py" --journal "$J" --targets "$T" --out "$O/result.json" > "$O/stdout.txt" 2> "$O/stderr.txt"; rc=$?
[ "$(sha256sum < "$J" | cut -c1-64)" = "$JSHA" ] || { echo "journal copy changed during the run"; rc=9; }
cat "$O/stdout.txt" "$O/stderr.txt"; [ -f "$O/result.json" ] && sha256sum "$O/result.json"
echo "## outputs $O"; echo "## jrv-r1-verify rc=$rc"; exit $rc
