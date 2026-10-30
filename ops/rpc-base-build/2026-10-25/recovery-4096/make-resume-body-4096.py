#!/usr/bin/env python3
"""(recovery-4096: identical to recovery/make-resume-body.py f452b521 except the derivation dir) Derive resume-body.sh from the UNCHANGED RUN 1 build.sh (2ee8b8de...) by exact, counted line substitutions only.
Everything else (pins, source re-derivation, toolchain, profile, epoch, RUSTFLAGS/CFLAGS remaps, cargo command, artifact
facts, smokes) stays byte-identical. Usage: make-resume-body.py BUILD_SH OUT  (or --check BUILD_SH BODY: exit 0 iff equal)."""
import hashlib, sys
BUILD_SHA = "2ee8b8dec0a64331e261f0fe2fcafed5c899554322a2a0a9bd9c236202d409ec"
PB = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/production-build"
SUBS = [  # (original line, replacement): each original must occur exactly once
 ('. "$(dirname "$0")/../jobs/env.sh"',
  f'PB={PB}  # RESUME: fixed RUN 1 location (this body lives in recovery/)\n. "$PB/../jobs/env.sh"'),
 ('P=$(cd "$(dirname "$0")" && pwd); RUN=${RUN:?RUN=1|2}; TGT=$P/target-$RUN; OUT=$P/out-$RUN; S=$BUILD/src',
  'P=$PB; RUN=${RUN:?RUN=1|2}; TGT=$P/target-$RUN; OUT=$P/out-$RUN; S=$BUILD/src; RD=$P/recovery-4096/derived-$RUN-r${RESUME:?}  # RESUME: source re-derivation outside out-1'),
 ('[[ "$RUN" =~ ^[12]$ ]] || die "RUN must be 1 or 2"',
  '[[ "$RUN" = 1 ]] || die "RESUME is for RUN 1 only"'),
 ('need "target and out dirs are new" [ ! -e "$TGT" ]',
  'need "RESUME: RUN 1 target retained ($TGT/$PROFILE)" [ -d "$TGT/$PROFILE/.fingerprint" ]'),
 ('need "out dir new" [ ! -e "$OUT" ]',
  'need "RESUME: no RUN 1 artifact yet (out-1/base absent)" [ ! -e "$OUT/base" ]\nneed "RESUME: no linked binary yet ($PROFILE/base absent)" [ ! -e "$TGT/$PROFILE/base" ]\nneed "RESUME: derivation dir new" [ ! -e "$RD" ]'),
 ('mkdir -p "$OUT/derived"; git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$OUT/derived"; (cd "$OUT/derived" && git apply "$PATCH")',
  'mkdir -p "$RD"; git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$RD"; (cd "$RD" && git apply "$PATCH")'),
 ('need "build/src == git archive $BASE_REV + patch (no other difference)" bash -c "[ -z \\"\\$(diff -rq \'$OUT/derived\' \'$S\' 2>&1)\\" ]"',
  'need "build/src == git archive $BASE_REV + patch (no other difference)" bash -c "[ -z \\"\\$(diff -rq \'$RD\' \'$S\' 2>&1)\\" ]"'),
 ('rm -rf "$OUT/derived"', 'rm -rf "$RD"  # RESUME: only this run\'s own recovery-4096/derived-* copy'),
 ('[ "${DRY:-0}" = 1 ] && { rm -rf "$OUT"; echo "## DRY: every pre-compile check passed; nothing compiled"; exit 0; }',
  '[ "${DRY:-0}" = 1 ] && { echo "## DRY: every pre-compile check passed; nothing compiled; target-1/out-1 untouched"; exit 0; }'),
 ('echo "== build ($(date -u +%FT%TZ))"', 'echo "== build: RESUME of RUN 1 in the retained target (cargo rebuilds only unfinished units) ($(date -u +%FT%TZ))"'),
 ('echo "## rc=0 (ONE build: provenance = recorded recipe + inputs; NOT a reproducibility claim)"',
  'echo "## rc=0 (RESUMED RUN 1 after a kernel OOM; ONE build: NOT a fresh independent build, NOT a reproducibility claim)"'),
]
def derive(src):
    raw = open(src, "rb").read()
    assert hashlib.sha256(raw).hexdigest() == BUILD_SHA, "build.sh is not the RUN 1 script 2ee8b8de"
    lines = raw.decode().split("\n")
    for a, b in SUBS:
        assert lines.count(a) == 1, ("substitution anchor not exactly once", a)
        lines[lines.index(a)] = b
    return "\n".join(lines)
if __name__ == "__main__":
    if sys.argv[1] == "--check":
        sys.exit(0 if derive(sys.argv[2]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1]))
