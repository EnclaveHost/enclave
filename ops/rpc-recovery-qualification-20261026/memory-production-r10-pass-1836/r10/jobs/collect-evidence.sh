#!/bin/bash
# composite-mdbx-validation-stage/r10 evidence collection (PREPARED by Claude 1833; NOT run by Claude). Review 1831 B1.
#   env -i PATH=/usr/bin:/bin LC_ALL=C EVID_O=<run dir> EVID_S6=<r6 stage> bash collect-evidence.sh before|after J_DIR
# The SAME commands as the qualified r6 peer_snapshot (FUSE mounts from mountinfo; this user's qemu-nbd/nbdfuse/fuse2fs; r6 runs
# excluded) plus, after the run, our mounts / processes left - but as EXPLICIT pipelines whose PIPESTATUS is captured immediately:
#   grep / pgrep 0 (match) or 1 (no match: an expected empty result); awk / sort 0 only; anything else (2 = error, 141 SIGPIPE,
#   153 SIGXFSZ = the 1 MiB file cap hit, 126/127 = missing tool, a failed redirection) FAILS.
# Writes J/peers-MODE.txt (+ after: mounts-left.txt, processes-left.txt) and J/status-MODE.txt (key=codes lines + a final end=1);
# exit 0 only if every status is acceptable and every file is a regular file. The run dir is passed in the ENVIRONMENT (EVID_O) so this
# script's own command line never matches `pgrep -f RUN_DIR`. jobs/job-receipt.py re-validates the status files independently.
set -u
mode=${1:-}; J=${2:-}; O=${EVID_O:-}; S6=${EVID_S6:-}
{ [ "$mode" = before ] || [ "$mode" = after ]; } && [ -d "$J" ] && [ -n "$O" ] && [ -n "$S6" ] || { echo "usage: before|after J_DIR (EVID_O, EVID_S6)" >&2; exit 2; }
ulimit -f 1024 || exit 2                                            # every file written here: <= 1 MiB
U=$(id -u) || exit 2
pf="$J/peers-$mode.txt"
grep -E ' fuse(\.[a-z0-9]+)? |fuseblk' /proc/self/mountinfo | awk '{print $5, $9, $10}' | grep -v "$S6/runs" | sort > "$pf"
pm="${PIPESTATUS[*]}"
pgrep -u "$U" -x -a 'qemu-nbd|nbdfuse|fuse2fs' | grep -v -F "$S6/runs" | sort >> "$pf"
pp="${PIPESTATUS[*]}"
lines=("peers.mounts=${pm// /,}" "peers.procs=${pp// /,}")
files=("$pf")
if [ "$mode" = after ]; then
  grep -F "$O" /proc/self/mountinfo > "$J/mounts-left.txt"
  ml="${PIPESTATUS[*]}"
  pgrep -u "$U" -a -f "$O" | grep -v -F "pgrep" > "$J/processes-left.txt"
  pl="${PIPESTATUS[*]}"
  lines+=("mounts.left=${ml// /,}" "procs.left=${pl// /,}")
  files+=("$J/mounts-left.txt" "$J/processes-left.txt")
fi
printf '%s\n' "${lines[@]}" "end=1" > "$J/status-$mode.txt" || exit 3
ok() {                                                              # ok RULES CODES: g = grep/pgrep {0,1}; z = awk/sort {0}
  local -a r c; IFS=, read -r -a r <<< "$1"; IFS=, read -r -a c <<< "$2"
  [ "${#r[@]}" -eq "${#c[@]}" ] || return 1
  local i; for i in "${!r[@]}"; do
    case "${r[$i]}:${c[$i]}" in g:0|g:1|z:0) ;; *) return 1 ;; esac
  done
}
fail=0
ok g,z,g,z "${pm// /,}" || fail=1
ok g,g,z "${pp// /,}" || fail=1
if [ "$mode" = after ]; then ok g "${ml// /,}" || fail=1; ok g,g "${pl// /,}" || fail=1; fi
for f in "${files[@]}"; do [ -f "$f" ] && [ ! -L "$f" ] || fail=1; done
exit $fail
