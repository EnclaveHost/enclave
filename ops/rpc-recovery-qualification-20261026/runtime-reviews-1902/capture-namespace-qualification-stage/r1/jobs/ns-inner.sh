#!/bin/bash
# capture-namespace-qualification-stage/r1 INNER (PREPARED by Claude 1895; NOT run by Claude). Started ONLY by jobs/ns-qual.sh as
#   unshare -Urnm bash jobs/ns-inner.sh OUTER_UID OUTER_GID WORK
# Pinned r12 ns.sh (byte-checked before it is sourced) + state-fixture-capture-stage/r3 inner.sh's path-set loop VERBATIM (tests/test_cnq.py
# requires the five lines to be byte-identical to r3's), then ns_harden exactly as r3; then cnq.py inside. Holds until RELEASE (<= 120 s).
set -uo pipefail
export PATH=/usr/bin:/bin
[ $# = 3 ] || { echo "## REFUSED: ns-inner.sh OUTER_UID OUTER_GID WORK"; exit 9; }
OUID=$1; OGID=$2; WORK=$3
[[ "$OUID" =~ ^[0-9]+$ && "$OGID" =~ ^[0-9]+$ ]] || { echo "## REFUSED: uid/gid"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P); P=$(cd "$S/../.." && pwd -P)
R12=$P/base-state-readonly-stage/r12; R3=$P/state-fixture-capture-stage/r3
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
[ "$(sha256sum < "$R12/SHA256SUMS" | cut -c1-64)" = 2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea ] \
  && [ "$(sha256sum < "$R12/jobs/ns.sh" | cut -c1-64)" = b8b4560c160b68ce8f855e2ce2a7f52128c5d16a43d392c62ba6030a6fa28751 ] \
  && [ "$(sha256sum < "$R3/jobs/inner.sh" | cut -c1-64)" = 51bc15a946275082303e9dc4a5e51e7746868d5cf6f9a6ac6f72e8ed5dc03414 ] \
  || { echo "## REFUSED: r12 ns.sh / r3 inner.sh not the pinned bytes"; exit 9; }
source "$R12/jobs/ns.sh"
# ---- r3 inner.sh, verbatim ----
RO="/home/steven /tmp"
for d in /var/tmp /dev/shm "/run/user/$OUID"; do
  [ -L "$d" ] && { echo "## REFUSED: $d is a symlink"; exit 9; }
  [ -e "$d" ] && RO="$RO $d"
done
# ---- the SAME loop body over an existing-dir SYMLINK made in WORK (only the list differs): it must refuse with rc 9 ----
mkdir -m 0700 "$WORK/sl-target" && ln -s "$WORK/sl-target" "$WORK/sl" || { echo "## REFUSED: symlink probe setup"; exit 9; }
( for d in "$WORK/sl"; do
  [ -L "$d" ] && { echo "## REFUSED: $d is a symlink"; exit 9; }
  [ -e "$d" ] && RO="$RO $d"
done; exit 0 ); SRC=$?
ns_harden $RO || { echo "## REFUSED: namespace hardening failed"; exit 9; }
# bash here-documents with /tmp read-only and TMPDIR unset (positive.sh feeds python a here-document of about 6 KiB)
HD=$(env -i PATH=/usr/bin:/bin bash -c 'cat <<EOT
'"$(head -c 8192 /dev/zero | tr '\0' x)"'
EOT' 2>/dev/null | wc -c)
[ "$HD" = 8193 ] && HDOK=ok || HDOK=failed
env -i PATH=/usr/bin:/bin LC_ALL=C CNQ_SYMLINK_RC=$SRC CNQ_HEREDOC=$HDOK python3 -I -B "$S/cnq.py" inside "$OUID" "$WORK" "$RO"; rc=$?
: > "$WORK/HARDENED"
for _ in $(seq 240); do [ -e "$WORK/RELEASE" ] && break; sleep 0.5; done
exit $rc
