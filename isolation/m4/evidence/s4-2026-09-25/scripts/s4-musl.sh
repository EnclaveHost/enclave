#!/usr/bin/env bash
# S4 step 0 for the musl-init release 79c5ecf2 (image aa6c985c; 5d's INSTALL.md step 0): musl for the new tree's init, at
# the DEFAULT prefix guestd's template build reads (~/.cache/enclave-isolation/musl-1.2.6: the unit sets no MUSL_PREFIX).
# It runs the RELEASE COMMIT's own isolation/m2/build-musl.sh (the pinned tarball sha256 AND musl's signature by the
# pinned key; static only; /usr/bin/gcc), without root, in a scope capped at 4 GiB at nice 10; it writes only the
# prefix. INERT: the running guestd's tree (iso-17e182a8) never reads it. Before s4-install.sh, whose 1d needs it.
# Then the prefix's SOURCE and libc.a must be 5d's (libc.a 4f72e098...). A failed build leaves nothing (the prefix is
# removed only if this run created it).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
IMGM=aa6c985c688e73ffc2ec547b691c2d804e50ad69; PFX=$HOME/.cache/enclave-isolation/musl-1.2.6
LIBC=4f72e098ed0562e8361f7c1713189c5cd7b3e6672dd8d9311d32c49201260959
BEFORE=$(snap) || { say4 "REFUSING: guestd/unit state unreadable or not the 3 running canaries"; exit 2; }
[ ! -e "$PFX" ] || { say4 "REFUSING: $PFX exists"; exit 3; }
avail=$(awk '/^MemAvailable/{print int($2/1024)}' /proc/meminfo); [ "$avail" -ge 40960 ] || { say4 "REFUSING: MemAvailable ${avail} MiB < 40 GiB"; exit 4; }
W=$(mktemp -d); created=0
cleanup() { rm -rf "$W"; if [ "$created" = 1 ] && [ -z "${DONE:-}" ]; then rm -rf "$PFX"; say4 "step 0: the partial prefix was removed"; fi; }
trap cleanup EXIT
git -C $MAIN show "$IMGM:isolation/m2/build-musl.sh" > "$W/build-musl.sh"
created=1
systemd-run --user --scope --quiet -p MemoryMax=4G nice -n 10 env -u CC -u CFLAGS -u LDFLAGS sh "$W/build-musl.sh" "$PFX" > "$W/out" 2>&1 \
  || { cat "$W/out" >> $LOG4; say4 "step 0 FAILED: build-musl.sh (see install.log)"; exit 5; }
cat "$W/out" >> $LOG4
grep -qx "libc.a sha256 $LIBC" "$PFX/SOURCE" && [ "$(sha256sum < "$PFX/lib/libc.a" | cut -c1-64)" = "$LIBC" ] \
  || { say4 "step 0 FAILED: libc.a is not 5d's $LIBC"; exit 6; }
grep -q "^signature VALIDSIG by 836489290BB6B70F99FFDA0556BCDB593020450F$" "$PFX/SOURCE" || { say4 "step 0 FAILED: no VALIDSIG record"; exit 6; }
[ -r "$PFX/lib/musl-gcc.specs" ] && [ -r "$PFX/COPYRIGHT" ] || { say4 "step 0 FAILED: specs or COPYRIGHT missing"; exit 6; }
AFTER=$(snap) || { say4 "INERTNESS UNREADABLE"; exit 9; }; [ "$BEFORE" = "$AFTER" ] || { say4 "INERTNESS FAILED: guestd or the m2-gd* units changed"; exit 9; }
DONE=1; say4 "step 0: musl 1.2.6 at $PFX (libc.a ${LIBC:0:12}, signature VALIDSIG by the pinned key); inert"
