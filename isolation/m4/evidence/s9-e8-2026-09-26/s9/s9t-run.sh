#!/usr/bin/env bash
# Starts s9t-apply.sh (S9: the guestd upgrade 0c087de8 -> 4cd26e58 plus the tree switch to iso-4cd26e58, release aee2059f)
# DETACHED, as the transient user unit s9t-apply-<UTC stamp>.service, exactly as s8t-run.sh did (enclave-e3): nothing on
# this side can cut it between its restart and its checks. Its lines go to ~/enclave-bench/s9-20260926/install.log, its
# exit code to 9t-<unit>.rc there.
# Usage: s9t-run.sh   (no arguments: both binaries, the trees and the flags are lib9.sh's)
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s9-20260926/lib9.sh
U4=s9t-apply-$(date -u +%Y%m%dT%H%M%SZ)
systemctl --user list-units --plain --no-legend --all 's?t-apply-*' 's4?-apply-*' 's4c*-apply-*' 'rr-*-apply-*' 'e4-*' | grep -q . && { say4 "REFUSING: a rollout run is already active"; exit 3; }
systemd-run --user --unit="$U4" --collect -q -p Environment=PATH=/usr/local/bin:/usr/bin:/usr/sbin:/bin \
  --working-directory="$HOME" bash -c '"$0" "$1" "$2"; echo $? > "$3"' "$S4/s9t-apply.sh" "" "" "$S4/9t-$U4.rc"
say4 "9T started DETACHED as $U4 (exit code -> $S4/9t-$U4.rc); follow: tail -f $LOG4"
