#!/bin/bash
# recovery-overlay-stage/r9 POST-CANCEL cleanup (review 1712 F2; prepared by Claude 1715; NOT run by Claude). Only for the case where the
# queue's memory guard or stop() (TERM, then KILL 1-2 s later) cut a session's own cleanup short and left its FUSE mounts behind.
# It touches ONLY the two exact mountpoints of ONE named run dir of THIS stage (RUN/work/mnt, then RUN/work/view), never a peer's mount,
# never a process (our children were killed by the guard; PDEATHSIG ended the servers; qemu-nbd's death closed the original), never the
# original. Then it re-checks that nothing under RUN is mounted and prints the peer snapshot for comparison with the run's own.
#   bash recovery-overlay-stage/r9/jobs/root-post-cancel-cleanup.sh /ABS/recovery-overlay-stage/r9/runs/<diag-|tests-|expose->RUN
# Never start a new session over a leftover: run this first, and only on a run whose session is no longer alive.
set -uo pipefail
source /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/recovery-overlay-stage/r9/jobs/common.sh
RUN=${1:?RUN_DIR}
case "$RUN" in $S/runs/diag-*|$S/runs/expose-*|$S/runs/tests-*) ;; *) die "RUN must be a run dir of this stage";; esac
[ -d "$RUN" ] && [ ! -L "$RUN" ] && [ "$(stat -c %u "$RUN")" = "$(id -u)" ] || die "RUN is not this user's real directory"
pgrep -u "$(id -u)" -f -- "$RUN/" >/dev/null && die "a process still names $RUN: the session or a child is alive (let it finish or stop it first)"
for mp in "$RUN/work/mnt" "$RUN/work/view" "$RUN"/*/work/mnt "$RUN"/*/work/view; do
  [ -e "$mp" ] || continue
  if awk -v m="$mp" '$5 == m {f=1} END {exit !f}' /proc/self/mountinfo; then
    fusermount3 -u "$mp" 2>/dev/null || fusermount3 -u -z "$mp" || die "could not unmount our own $mp"
    echo "unmounted our own $mp"
  fi
done
grep -qF "$RUN/" /proc/self/mountinfo && die "a mount under $RUN survived"
echo "## no mount under $RUN remains"
echo "## peer snapshot now (compare with $RUN/peers-before.txt if present):"; peer_snapshot
