#!/usr/bin/env bash
# S5 install of the FIXED release 52156652 (image 4cdd5169, enclave-53's build, bf GO) on warden-host, INERT: a detached
# worktree ~/enclave-prod/iso-4cdd5169 and the release dir ~/enclave-prod/release-4cdd5169 beside the live iso-aa6c985c;
# nothing references the new paths, nothing restarts (derived from s4-install.sh, lib5.sh instead of lib4.sh). 1a: the
# copy verifies as the release id; 1b: the tree is clean at 4cdd5169; 1d: guestd's own template build from the INSTALLED
# tree reproduces the release on this host (the musl prefix from 79c5ecf2's step 0 serves as-is: the same libc.a).
# Inertness: guestd's MainPID/ExecStart and the 3 m2-gd* units unchanged. To abandon a partial install while nothing
# references it: git worktree remove the tree (under /tmp/enclave-git-cleanup.lock), then remove the release dir.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s5-20260926/lib5.sh
BEFORE=$(snap) || { say4 "REFUSING: guestd's or the m2-gd* units' state is unreadable (user bus?) or not the 3 running canaries"; exit 2; }
for x in "$T" "$R"; do [ -e "$x" ] && { say4 "REFUSING: $x exists"; exit 3; }; done
[ "$(sha256sum $SRC/release.json | cut -c1-64)" = "$REL" ] || { say4 "REFUSING: the built artifact is not release $REL"; exit 4; }
# A PARTIAL failure after 1b leaves $T (and maybe $R) behind, and a rerun refuses on them. To abandon, while nothing
# references them: s4/s4-abandon.sh (worktree remove under the flock, never rm -rf; then $R).
trap 'rc=$?; [ $rc = 0 ] || say4 "FAILED (rc $rc). Nothing is live. To abandon the partial install: rm -rf the tree (git worktree remove) and the release dir by hand"' EXIT
# 1b: the new source tree, a clean detached worktree of the main checkout (shared-checkout rule: under the flock)
flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree add -q --detach "$T" "$IMG"
[ "$(git -C "$T" rev-parse HEAD)" = "$IMG" ] || { say4 "1b FAILED: HEAD"; exit 5; }
[ -z "$(git -C "$T" status --porcelain --ignored)" ] || { say4 "1b FAILED: the fresh tree is not clean"; exit 5; }
say4 "1b: $T at $IMG, clean (no ignored files either)"
# 1a: the release as a reference copy, verified against its id by the tree's own tool
cp -a "$SRC" "$R"
v=$(python3 "$T/isolation/m4/release-manifest.py" verify "$R" --expect "$REL" 2>&1) || { echo "$v" >> $LOG4; say4 "1a FAILED: the copy does not verify"; exit 6; }
echo "$v" >> $LOG4; grep -q "verified 15 files" <<<"$v" || { say4 "1a FAILED: the copy does not verify"; exit 6; }
say4 "1a: $R verified as $REL"
# 1d: the installed tree reproduces the release on this host, with the unit's environment
reproduces || exit 8
say4 "1d: the installed tree reproduces release $REL on this host"
tree_ok || { say4 "the tree changed during 1d beyond ignored build products"; exit 8; }
AFTER=$(snap) || { say4 "INERTNESS UNREADABLE after the install"; exit 9; }; [ "$BEFORE" = "$AFTER" ] || { say4 "INERTNESS FAILED: guestd or the m2-gd* units changed during the install"; exit 9; }
say4 "S5 INSTALL (the fixed tree + release) done and inert: guestd's MainPID/ExecStart and the m2-gd* units are unchanged"
