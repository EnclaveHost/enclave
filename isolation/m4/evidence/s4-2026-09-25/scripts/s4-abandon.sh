#!/usr/bin/env bash
# Abandon a (partial) S4 install while it is still INERT: remove ~/enclave-prod/iso-d1a38994 (git worktree remove under
# the shared-checkout flock, never rm -rf, which would leave the worktree registered) and ~/enclave-prod/release-d1a38994.
# Refuses if guestd's ExecStart references either path (4d has run: use s4d-rollback.sh first). The guestd binary
# (s4-guestd-install.sh) is a separate file: remove it only with ABANDON_BIN=<its path>, and never the live one.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
ex=$(systemctl --user show enclave-guestd.service -p ExecStart --value) && [ -n "$ex" ] || { say4 "ABANDON REFUSED: guestd's ExecStart is unreadable"; exit 2; }
for x in "$T" "$R" "${ABANDON_BIN:-/nonexistent}"; do
  case "$ex" in *"$x"*) say4 "ABANDON REFUSED: guestd's ExecStart references $x"; exit 3;; esac
done
if git -C $MAIN worktree list --porcelain | grep -qxF "worktree $T"; then
  flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$T"; say4 "abandon: worktree $T removed"
elif [ -e "$T" ]; then say4 "ABANDON: $T exists but is not a registered worktree; left for a human"; exit 4; fi
if [ -e "$R" ]; then chmod -R u+w "$R"; rm -rf "$R"; say4 "abandon: $R removed"; fi
if [ -n "${ABANDON_BIN:-}" ]; then
  [ "$ABANDON_BIN" != "$NEWBIN" ] && [[ "$ABANDON_BIN" == $PROD/bin/guestd.* ]] || { say4 "ABANDON REFUSED: $ABANDON_BIN"; exit 5; }
  rm -f "$ABANDON_BIN"; say4 "abandon: $ABANDON_BIN removed"
fi
say4 "abandon done: the live release, tree and binary were not touched"
