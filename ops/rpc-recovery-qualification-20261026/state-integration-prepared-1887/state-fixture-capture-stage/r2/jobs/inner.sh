#!/bin/bash
# state-fixture-capture-stage/r2 INNER (PREPARED by Claude 1879; NOT run by Claude). Started ONLY by jobs/run.sh as
#   unshare -Urnm bash jobs/inner.sh KIND BUILD_OUT_DIR OUTER_UID OUTER_GID
# The reviewed build-namespace hardening, reused unchanged: the PINNED r12 jobs/ns.sh (byte-checked here before it is sourced) ->
# ns_harden /home/steven /tmp (private propagation, recursive read-only binds; /vm stays writable). capture.py then VERIFIES the result
# (bsro_gate.ns_checks: propagation_private + read_only + ro_tree_ok) before anything runs. No other mount is made here.
set -uo pipefail
export PATH=/usr/bin:/bin
[ $# = 4 ] || { echo "## REFUSED: inner.sh KIND BUILD_OUT_DIR OUTER_UID OUTER_GID"; exit 9; }
K=$1; BD=$2; OUID=$3; OGID=$4
[[ "$OUID" =~ ^[0-9]+$ && "$OGID" =~ ^[0-9]+$ ]] || { echo "## REFUSED: uid/gid"; exit 9; }
S=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
R12=$(cd "$S/../../base-state-readonly-stage/r12" && pwd -P) || exit 9
R12SUMS=2911943d8952c1b71aa54f1b2be1639b140d0521ca539b71424d63d20d9033ea
R12NS=b8b4560c160b68ce8f855e2ce2a7f52128c5d16a43d392c62ba6030a6fa28751
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
[ "$(sha256sum < "$R12/SHA256SUMS" | cut -c1-64)" = "$R12SUMS" ] && (cd "$R12" && sha256sum -c --quiet SHA256SUMS) \
  && [ "$(sha256sum < "$R12/jobs/ns.sh" | cut -c1-64)" = "$R12NS" ] || { echo "## REFUSED: r12 / ns.sh not the pinned bytes"; exit 9; }
source "$R12/jobs/ns.sh"
ns_harden /home/steven /tmp || { echo "## REFUSED: namespace hardening failed"; exit 9; }
exec env -i PATH=/usr/bin:/bin LC_ALL=C python3 -I -B "$S/capture.py" run "$K" "$BD" --uid "$OUID" --gid "$OGID"
