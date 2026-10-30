#!/bin/bash
# SECOND RESUME of M7 RUN 1, under the root-reviewed 4096 MiB queue candidate. ROOT-LAUNCHED, FOREGROUND, OFFLINE:
#   R4=$PB/recovery-4096; python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 4096 \
#     --log $R4/logs/build-1r2.guard -- env RUN=1 RESUME=2 unshare -rn bash $R4/resume-4096.sh > $R4/logs/build-1r2.out 2>&1; \
#     echo $? > $R4/logs/build-1r2.rc
# History it validates (pinned, never rewritten): RUN 1 kernel OOM under 1792 (rc 143, root journal 57da8c0b), then the
# first resume build-1r1 STOPPED by the memory guard under 2560 (rc 99: tree 2565 MiB > 2560; rustc 2252 + cargo 306 on
# base-node-core), no artifact. Body = recovery/resume-body.sh d350fe78 with ONLY the derivation dir moved into
# recovery-4096 (make-resume-body-4096.py, re-derived from the UNCHANGED build.sh 2ee8b8de and compared here). Same
# target-1/out-1, source, epoch, profile, remaps, flags, cargo command, smokes. Never removes target-1, out-1, any log or
# the cargo home; never writes into recovery/. DRY=1: every check + source re-derivation, NO compile, cap not enforced.
# A pass is a RESUMED RUN 1 (units from three sessions), NOT a fresh independent build, NOT a provenance pass.
set -uo pipefail
PB=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build
R1=$PB/recovery; R4=$PB/recovery-4096; L=$PB/logs
die() { echo "## RESUME REFUSED: $*"; echo "## rc=1"; exit 1; }
need() { local w=$1; shift; "$@" && echo "[ok] $w" || die "$w"; }
h() { sha256sum < "$1" | cut -c1-64; }
pin() { need "$1 == ${2:0:8}" [ "$(h "$1")" = "$2" ]; }
[ "${RUN:-}" = 1 ] || die "RUN=1 required"
[[ "${RESUME:-}" =~ ^[2-9]$ ]] || die "RESUME=<attempt 2-9> required (attempt 1 was recovery/build-1r1)"
echo "== stage pins (originals unchanged)"
pin $PB/build.sh 2ee8b8dec0a64331e261f0fe2fcafed5c899554322a2a0a9bd9c236202d409ec
pin $PB/dry-check.sh 7a373ccbe8e56a0f323ab3198a8088e49941c2025b725ead38edc27242c08aee
pin $PB/../jobs/env.sh cd1c6b561bd2ff53d9d5fa9f86011478cdd1fc3f076061799c3fabd86d3fc738
pin $R1/make-resume-body.py f452b521cf7164b4f11f5b28ba51af5cf2aadb0f55e9d59272bfd748d8593755
pin $R1/resume-body.sh d350fe78a55d9c1e9a55bcdcf714731633da385984d589c36650fcd84942d17a
pin $R1/resume.sh 6c9c5e52d30f8334dc410f591830738dcde592cfd5f4bd1279b82b2fb361f025
pin $R4/make-resume-body-4096.py 3b760157ba5a8a10a47f5dafe52e4479f40df1d678141c302559c82813dc2e52
pin $R4/resume-body-4096.sh 09fda204545783b6c989ae3d6caf59f221cd6d599d033a2937fa782bae88f940
need "resume-body-4096.sh == make-resume-body-4096.py(build.sh)" python3 -I $R4/make-resume-body-4096.py --check $PB/build.sh $R4/resume-body-4096.sh
need "resume-body-4096.sh differs from the reviewed d350fe78 body ONLY in the derivation dir (2 lines)" bash -c "[ \"\$(diff $R1/resume-body.sh $R4/resume-body-4096.sh | grep -c '^[<>]')\" = 4 ] && [ -z \"\$(diff <(sed 's|/recovery-4096/|/recovery/|; s|recovery-4096/derived|recovery/derived|' $R4/resume-body-4096.sh) $R1/resume-body.sh)\" ]"
echo "== original RUN 1 failure (kernel OOM under 1792)"
need "build-1.rc == 143" [ "$(cat $L/build-1.rc)" = 143 ]
pin $L/build-1.out 88a266b7116eb27892bbbcc2e14b663f99ac123c89d572898eaddab1cb7a979e
need "no RUN 1 guard receipt" [ ! -e $L/build-1.guard ]
pin $R1/logs/root-oom-journal.txt 57da8c0b9bf8486f69a861937284a651e90461d8cdc590ae6df9dff7ed4de20b
need "root journal: oom-kill of run-p3891230-i37474689.scope" grep -q "run-p3891230-i37474689.scope: Failed with result 'oom-kill'" $R1/logs/root-oom-journal.txt
echo "== first resume failure (memory guard under 2560)"
need "build-1r1.rc == 99" [ "$(cat $R1/logs/build-1r1.rc)" = 99 ]
pin $R1/logs/build-1r1.out b3a2ba27139d541f49f553e5c057135dc5f1a6f15e86eb5efc2506f30ee23b4a
pin $R1/logs/build-1r1.guard 202e157bb72ee2d91701e39f239ce6efb86bafe8531ab5c4e698b9467dc0b5df
need "build-1r1: started under cap 2560" bash -c "head -1 $R1/logs/build-1r1.out | grep -q '^\[queue\] START .* cap=2560MiB'"
need "build-1r1: guard stop 2565 > 2560, no cargo result" bash -c "grep -q 'STOPPING own job: process tree RSS 2565 MiB > 2560 MiB' $R1/logs/build-1r1.out && ! grep -q '^## cargo build rc=' $R1/logs/build-1r1.out && [ \"\$(tail -1 $R1/logs/build-1r1.out)\" = '[queue] EXIT 99' ]"
need "no other attempt in recovery/ (only build-1r1)" bash -c "[ \"\$(ls $R1/logs | grep -c '^build-1r')\" = 3 ]"
echo "== retained state"
need "target-1 retained ($(ls $PB/target-1/m7-release-nolto/.fingerprint 2>/dev/null | wc -l) fingerprints)" [ -d $PB/target-1/m7-release-nolto/.fingerprint ]
need "out-1 retained and EMPTY (no artifact)" bash -c "[ -d '$PB/out-1' ] && [ -z \"\$(find '$PB/out-1' -mindepth 1 -print -quit)\" ]"
need "no linked binary (target-1/m7-release-nolto/base absent)" [ ! -e $PB/target-1/m7-release-nolto/base ]
if [ "${DRY:-0}" != 1 ]; then
  need "this attempt's logs are new (recovery-4096/logs/build-1r$RESUME.rc absent)" [ ! -e $R4/logs/build-1r$RESUME.rc ]
  need "no collision with recovery/ (build-1r$RESUME.* absent there)" bash -c "! ls $R1/logs/build-1r$RESUME.* >/dev/null 2>&1"
  [ "$RESUME" = 2 ] || need "previous attempt build-1r$((RESUME-1)) ended non-zero" bash -c "[ -s '$R4/logs/build-1r$((RESUME-1)).rc' ] && [ \"\$(cat '$R4/logs/build-1r$((RESUME-1)).rc')\" != 0 ]"
  cg=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup | head -1)
  need "running under the reviewed 4096 MiB allocation (memory.max $(cat $cg/memory.max 2>/dev/null))" [ "$(cat $cg/memory.max 2>/dev/null)" = 4294967296 ]
fi
echo "== resume body (build.sh 2ee8b8de + reviewed substitutions; derivation in recovery-4096)"
export RUN RESUME
exec bash $R4/resume-body-4096.sh
