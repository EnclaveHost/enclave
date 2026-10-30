#!/bin/bash
# RESUME of M7 RUN 1 after the kernel OOM (root journal 19:57:03, run-p3891230-i37474689.scope, ~1.7G peak under the 1792
# MiB cap; build-1.rc 143). ROOT-LAUNCHED, FOREGROUND, OFFLINE, under the root-reviewed 2560 MiB queue candidate:
#   R=$PB/recovery; python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 \
#     --log $R/logs/build-1r1.guard -- env RUN=1 RESUME=1 unshare -rn bash $R/resume.sh > $R/logs/build-1r1.out 2>&1; \
#     echo $? > $R/logs/build-1r1.rc
# Validates the failed RUN 1 state (rc 143, no cargo result, no guard receipt, retained partial target, NO artifact) and
# the stage pins, then runs resume-body.sh = the UNCHANGED build.sh 2ee8b8de with counted, reviewed substitutions only
# (make-resume-body.py; re-derived and compared here). Same target-1/out-1, remaps, profile, source, epoch, flags: cargo
# keeps every completed unit and rebuilds only unfinished ones. Never removes target-1, out-1, logs or the cargo home.
# DRY=1: every check and the source re-derivation, NO compile, cap not enforced. A pass is a RESUMED RUN 1, not a fresh
# independent build and not a provenance or reproducibility pass.
set -uo pipefail
PB=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build
R=$PB/recovery; L=$PB/logs
die() { echo "## RESUME REFUSED: $*"; echo "## rc=1"; exit 1; }
need() { local w=$1; shift; "$@" && echo "[ok] $w" || die "$w"; }
h() { sha256sum < "$1" | cut -c1-64; }
[ "${RUN:-}" = 1 ] || die "RUN=1 required"
[[ "${RESUME:-}" =~ ^[1-9]$ ]] || die "RESUME=<attempt 1-9> required"
echo "== stage pins"
need "build.sh == RUN 1 script 2ee8b8de (unchanged)" [ "$(h $PB/build.sh)" = 2ee8b8dec0a64331e261f0fe2fcafed5c899554322a2a0a9bd9c236202d409ec ]
need "dry-check.sh == 7a373ccb (unchanged)" [ "$(h $PB/dry-check.sh)" = 7a373ccbe8e56a0f323ab3198a8088e49941c2025b725ead38edc27242c08aee ]
need "jobs/env.sh == cd1c6b56 (unchanged)" [ "$(h $PB/../jobs/env.sh)" = cd1c6b561bd2ff53d9d5fa9f86011478cdd1fc3f076061799c3fabd86d3fc738 ]
need "make-resume-body.py == f452b521 (reviewed)" [ "$(h $R/make-resume-body.py)" = f452b521cf7164b4f11f5b28ba51af5cf2aadb0f55e9d59272bfd748d8593755 ]
need "resume-body.sh == d350fe78 (reviewed)" [ "$(h $R/resume-body.sh)" = d350fe78a55d9c1e9a55bcdcf714731633da385984d589c36650fcd84942d17a ]
need "resume-body.sh == make-resume-body.py(build.sh) (only the counted substitutions)" python3 -I $R/make-resume-body.py --check $PB/build.sh $R/resume-body.sh
echo "== failed RUN 1 state (kept, never rewritten)"
need "build-1.rc == 143 ($(h $L/build-1.rc))" [ "$(cat $L/build-1.rc)" = 143 ]
need "build-1.out: started under cap 1792 ($(h $L/build-1.out))" bash -c "head -1 '$L/build-1.out' | grep -q '^\[queue\] START .* cap=1792MiB'"
need "build-1.out: ends '[queue] EXIT -15'" [ "$(tail -1 $L/build-1.out)" = "[queue] EXIT -15" ]
need "build-1.out: no cargo result line (compile interrupted)" bash -c "! grep -q '^## cargo build rc=' '$L/build-1.out'"
need "no RUN 1 guard receipt (as root's journal states)" [ ! -e $L/build-1.guard ]
if [ -n "${JOURNAL:-}" ]; then need "root journal excerpt names the OOM scope ($(h "$JOURNAL"))" grep -q 'run-p3891230-i37474689.scope' "$JOURNAL"; fi
need "target-1 retained with completed units ($(ls $PB/target-1/m7-release-nolto/.fingerprint 2>/dev/null | wc -l) fingerprints)" [ -d $PB/target-1/m7-release-nolto/.fingerprint ]
need "out-1 retained and EMPTY (no artifact)" bash -c "[ -d '$PB/out-1' ] && [ -z \"\$(find '$PB/out-1' -mindepth 1 -print -quit)\" ]"
if [ "${DRY:-0}" != 1 ]; then
  need "this attempt's logs are new (build-1r$RESUME.rc absent)" [ ! -e $R/logs/build-1r$RESUME.rc ]
  [ "$RESUME" = 1 ] || need "previous attempt build-1r$((RESUME-1)) ended non-zero" bash -c "[ -s '$R/logs/build-1r$((RESUME-1)).rc' ] && [ \"\$(cat '$R/logs/build-1r$((RESUME-1)).rc')\" != 0 ]"
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)
  need "running under the reviewed 2560 MiB allocation (memory.max $(cat $cg/memory.max 2>/dev/null))" [ "$(cat $cg/memory.max 2>/dev/null)" = 2684354560 ]
fi
echo "== resume body (build.sh 2ee8b8de + reviewed substitutions)"
export RUN RESUME
exec bash $R/resume-body.sh
