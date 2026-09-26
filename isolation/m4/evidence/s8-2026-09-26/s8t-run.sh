#!/usr/bin/env bash
# Starts s8t-apply.sh (S8: the guestd upgrade 4e78ba80 -> 0c087de8 plus the tree switch to iso-0c087de8, release 5db18199)
# DETACHED, as the transient user unit s8t-apply-<UTC stamp>.service, exactly as s7t-run.sh did (enclave-e3): nothing on
# this side can cut it between its restart and its checks. Its lines go to ~/enclave-bench/s8-20260926/install.log, its
# exit code to 8t-<unit>.rc there.
# Usage: s8t-run.sh   (no arguments: both binaries, the trees and the flags are lib8.sh's)
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s8-20260926/lib8.sh
U4=s8t-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 's?t-apply-*' 's4?-apply-*' 's4c*-apply-*' 'rr-*-apply-*' 'e4-*' | grep -q . && { say4 "REFUSING: a rollout run is already active"; exit 3; }
systemd-run --user --unit="$U4" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0" "$1" "$2"; echo $? > "$3"' "$S4/s8t-apply.sh" "" "" "$S4/8t-$U4.rc"
say4 "8T started DETACHED as $U4 (exit code -> $S4/8t-$U4.rc); follow: tail -f $LOG4"
