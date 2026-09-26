#!/usr/bin/env bash
# S9 1c: the NEW guestd binary (4cd26e58: releaseNamingRefusal - a -release guestd refuses to start unless every tree is
# named; b4's v44 manifest item 3) under its own name, INERT (nothing references it until s9t-apply.sh). Derived from
# s8-guestd-install.sh. Built twice in a clean worktree at 4cd26e58, the second with an EMPTY Go cache; the two must
# agree and equal the sha a reviewer reproduced independently (2nd argument). It must carry the host floor (FLOORC)
# and state every flag the S9 unit passes.
# Usage: s9-guestd-install.sh <4cd26e58 full commit> <the independently reproduced sha256>
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s9-20260926/lib9.sh
BINC=${1:?the reviewed guestd merge commit}; XSHA=${2:?the independently reproduced sha256}
[[ "$BINC" =~ ^[0-9a-f]{40}$ && "$XSHA" =~ ^[0-9a-f]{64}$ ]] || { echo "a full 40-hex commit and a 64-hex sha"; exit 2; }
B=$PROD/bin/guestd.${BINC:0:8}
[ -e "$B" ] && { say4 "REFUSING: $B exists"; exit 3; }
[ "$B" != "$OBIN" ] || { say4 "REFUSING: that is the live binary's name"; exit 3; }
[ "$BINC" = "$NBINC" ] || { say4 "REFUSING: S9's binary is built from $NBINC"; exit 3; }
for c in $IMG $FLOORC; do git -C $MAIN merge-base --is-ancestor $c $BINC || { say4 "REFUSING: $BINC does not carry $c"; exit 4; }; done
BEFORE=$(snap) || { say4 "REFUSING: guestd/unit state unreadable or not the 3 running canaries"; exit 2; }
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo)
[ "$avail" -ge 40960 ] || { say4 "REFUSING: MemAvailable ${avail} MiB is under the 40 GiB guard for a build beside the guests"; exit 6; }
awk 'BEGIN{f=1} /^some /{for(i=1;i<=NF;i++) if($i ~ /^avg60=/){split($i,a,"="); f=(a[2]+0==0)?0:1}} END{exit f}' /proc/pressure/memory || { say4 "REFUSING: memory PSI avg60 not 0"; exit 6; }
W=$(mktemp -d)
cleanup() { local wl; wl=$(git -C $MAIN worktree list --porcelain 2>/dev/null || true); grep -qxF "worktree $W/src" <<<"$wl" && flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree remove --force "$W/src"; rm -rf "$W"; }
trap cleanup EXIT
flock /tmp/enclave-git-cleanup.lock git -C $MAIN worktree add -q --detach "$W/src" "$BINC"
gb() { ( cd "$W/src/isolation/m4/guestd" && systemd-run --user --scope --quiet -p MemoryMax=8G nice -n 10 env -u GOFLAGS GOENV=off "$@" go build -trimpath -o "$OUTB" . ); }
OUTB="$W/g1" gb || { say4 "1c FAILED: build 1"; exit 7; }
mkdir -p "$W/cache2"; OUTB="$W/g2" gb GOCACHE="$W/cache2" || { say4 "1c FAILED: build 2 (empty cache)"; exit 7; }
[ "$(sha256sum < "$W/g1")" = "$(sha256sum < "$W/g2")" ] || { say4 "1c FAILED: the guestd builds differ"; exit 7; }
[ "$(sha256sum < "$W/g1" | cut -c1-64)" = "$XSHA" ] || { say4 "1c FAILED: the build is not the independently reproduced $XSHA"; exit 7; }
# the binary states the flags 4d passes (-h prints the flag set and exits; flag.Parse runs before anything else)
u=$("$W/g1" -h 2>&1 || true)
for f in -release -legacy-isolation -instance-prefix -guest-mem-mib -guest-cpus -guest-host-floor-mib -ticket-port -isolation-release -legacy-isolation-release; do
  echo "$u" | grep -qE "^  $f( |$)" || { say4 "1c FAILED: the binary has no $f flag"; exit 7; }
done
install -m 755 "$W/g1" "$B.tmp"
mv "$B.tmp" "$B"
say4 "1c: $B sha256 $(sha256sum "$B" | cut -c1-64) (built twice, from $BINC)"
AFTER=$(snap) || { say4 "INERTNESS UNREADABLE"; exit 9; }; [ "$BEFORE" = "$AFTER" ] || { say4 "INERTNESS FAILED: guestd or the m2-gd* units changed"; exit 9; }
say4 "S9 1c done and inert"
