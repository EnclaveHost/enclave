#!/usr/bin/env bash
# S4 1c: the 4d guestd binary under its own name, INERT (nothing references it until s4d-apply.sh). Built from the
# reviewed merge that carries BOTH the release services (d1a38994's guestd) and the host floor (d67b0020 + 1b5375c9),
# once 99/e3 approved the floor and 5d merged it. Built twice in a clean worktree; the two builds must agree.
# Usage: s4-guestd-install.sh <merge commit, 40 hex>
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
BINC=${1:?the reviewed guestd merge commit}; [[ "$BINC" =~ ^[0-9a-f]{40}$ ]] || { echo "a full 40-hex commit"; exit 2; }
B=$PROD/bin/guestd.${BINC:0:8}
[ -e "$B" ] && { say4 "REFUSING: $B exists"; exit 3; }
[ "$B" != "$NEWBIN" ] || { say4 "REFUSING: that is the live binary's name"; exit 3; }
for c in $IMG $FLOORC; do git -C $MAIN merge-base --is-ancestor $c $BINC || { say4 "REFUSING: $BINC does not carry $c"; exit 4; }; done
BEFORE=$(snap)
W=$(mktemp -d); flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree add -q --detach "$W/src" "$BINC"
( cd "$W/src/isolation/m4/guestd" && go build -trimpath -o "$W/g1" . && go build -a -trimpath -o "$W/g2" . )
[ "$(sha256sum < "$W/g1")" = "$(sha256sum < "$W/g2")" ] || { say4 "1c FAILED: the guestd builds differ"; exit 7; }
# the binary states the flags 4d passes (-h prints the flag set and exits; flag.Parse runs before anything else)
u=$("$W/g1" -h 2>&1 || true)
for f in -release -legacy-isolation -instance-prefix -guest-mem-mib -guest-cpus -guest-host-floor-mib -ticket-port; do
  echo "$u" | grep -qE "^  $f( |$)" || { say4 "1c FAILED: the binary has no $f flag"; exit 7; }
done
install -m 755 "$W/g1" "$B.tmp" && mv "$B.tmp" "$B"
say4 "1c: $B sha256 $(sha256sum "$B" | cut -c1-64) (built twice, from $BINC)"
flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$W/src"; rm -rf "$W"
AFTER=$(snap); [ "$BEFORE" = "$AFTER" ] || { say4 "INERTNESS FAILED: guestd or the m2-gd* units changed"; exit 9; }
say4 "S4 1c done and inert"
