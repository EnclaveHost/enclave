#!/usr/bin/env bash
# Abandon a (partial or superseded) S4 install while it is still INERT: remove ~/enclave-prod/iso-<id> (git worktree
# remove under the shared-checkout flock, never rm -rf, which would leave the worktree registered) and
# ~/enclave-prod/release-<id>. <id> is the 8-hex image commit (default: lib4.sh's current one); the live tree
# (iso-03be27d6), the live release (release-0181bce3) and the known-answer release (release-6757d139) are refused.
# Refuses if guestd's ExecStart or unit file references either path (4d has run: use s4d-rollback.sh first). The guestd
# binary (s4-guestd-install.sh) is a separate file: removed only with ABANDON_BIN=<its path>, and never the live one.
# Usage: s4-abandon.sh [<8-hex image commit>]
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
X=${1:-${IMG:0:8}}; [[ "$X" =~ ^[0-9a-f]{8}$ ]] || { echo "an 8-hex image commit"; exit 2; }
case "$X" in 03be27d6|0181bce3|6757d139) say4 "ABANDON REFUSED: $X is the live or the known-answer tree/release"; exit 2;; esac
T=$PROD/iso-$X; R=$PROD/release-$X
ex=$(systemctl --user show enclave-guestd.service -p ExecStart --value) && [ -n "$ex" ] || { say4 "ABANDON REFUSED: guestd's ExecStart is unreadable"; exit 2; }
# the LOADED ExecStart and the unit FILE (a 4d stopped between its edit and daemon-reload shows only in the file)
for x in "$T" "$R" "${ABANDON_BIN:-/nonexistent}"; do
  case "$ex" in *"$x"*) say4 "ABANDON REFUSED: guestd's ExecStart references $x"; exit 3;; esac
  grep -qF -- "$x" "$U" && { say4 "ABANDON REFUSED: the unit file references $x"; exit 3; }
done
if git -C $MAIN worktree list --porcelain | grep -qxF "worktree $T"; then
  flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$T"; say4 "abandon: worktree $T removed"
elif [ -e "$T" ]; then say4 "ABANDON: $T exists but is not a registered worktree; left for a human"; exit 4; fi
if [ -e "$R" ]; then chmod -R u+w "$R"; rm -rf "$R"; say4 "abandon: $R removed"; fi
if [ -n "${ABANDON_BIN:-}" ]; then
  # only the exact binary s4-guestd-install.sh recorded (never guestd.c42612c0, a guestd.prev-*, or any kept rollback binary)
  grep -qE "^[0-9:]{8}Z 1c: $(printf '%s' "$ABANDON_BIN" | sed 's/[.[\*^$]/\\&/g') sha256 [0-9a-f]{64} \(built twice, from [0-9a-f]{40}\)\$" $LOG4 \
    && [ "$ABANDON_BIN" != "$NEWBIN" ] || { say4 "ABANDON REFUSED: $ABANDON_BIN is not a binary s4-guestd-install.sh recorded"; exit 5; }
  rm -f "$ABANDON_BIN"; say4 "abandon: $ABANDON_BIN removed"
fi
say4 "abandon done: the live release, tree and binary were not touched"
