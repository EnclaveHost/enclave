#!/usr/bin/env python3
"""(recovery-6144: recovery-4096/make-resume-body-4096.py 71237196 with only the log/regeneration dirs and one echo changed) Derive resume-body.sh from the PINNED original M10 job jobs/root-test-m10.sh (51ffbda2...) by exact, counted line
substitutions. Only step 0 changes: instead of CREATING build/ (which now exists and is retained), it regenerates
pristine 5476069f + M7 + M10 (+ control) in a private temp dir and requires build/tree and build/control to be identical,
re-checks the three-line control difference, compares the private cargo home's crate archives with the M7 one, and writes
logs to a NEW directory. phase(), ok(), ran(), run_filter(), control_check(), every filter, expected test name, expected
control failure set and the fresh=false requirement are byte-identical. Usage: make-resume-body.py JOB OUT | --check JOB BODY"""
import hashlib, sys
JOB_SHA = "51ffbda21d257a9af3b2ab935b3e63b7801112ae4c47ed1645fa67074ad2bae5"
M = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap"
SUBS = [
 ('. "$(dirname "$0")/env.sh"', f'. {M}/jobs/env.sh  # RESUME: this body lives in recovery-6144/'),
 ('H=$M/jobs; L=$M/logs; rc=0',
  'H=$M/jobs; L=$M/recovery-6144/logs/run-${RESUME:?}; RT=$M/recovery-6144/regen-$RESUME; rc=0  # RESUME: new log dir; old logs kept'),
 ('echo "## toolchain $(rustc --version) | $(cargo --version)"',
  'echo "## toolchain $(rustc --version) | $(cargo --version)"\n'
  '[ "$CARGO_BUILD_JOBS" = 1 ] && [ "${RUSTFLAGS:-}" = "-C link-arg=-Wl,--threads=1" ] || die "RESUME: need CARGO_BUILD_JOBS=1 and the original RUSTFLAGS (one compiler/linker; same fingerprints)"\n'
  'echo "## RESUME after node-build guard stops at 1792, 2560, 4096 (floor) and 4096 (cap 4262 MiB): CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS RUSTFLAGS=\'$RUSTFLAGS\'"'),
 ('[ ! -e "$B" ] || die "$B exists (owned by this stage): remove it for a clean run"',
  '[ -d "$B/target/debug/.fingerprint" ] && [ -d "$B/tree" ] && [ -d "$B/control" ] && [ -d "$CARGO_HOME/registry" ] || die "RESUME: retained build/ incomplete"'),
 ('mkdir -p "$B/tree" "$CARGO_HOME" "$L" || die "mkdir failed"',
  '[ ! -e "$L" ] && [ ! -e "$RT" ] && mkdir -p "$L" "$RT/tree" || die "RESUME: log or regeneration dir exists (use a new RESUME number)"'),
 ('git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$B/tree" || die "git archive | tar failed"',
  'git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$RT/tree" || die "git archive | tar failed"'),
 ('[ -f "$B/tree/Cargo.toml" ] && [ -f "$B/tree/Cargo.lock" ] || die "archive incomplete"',
  '[ -f "$RT/tree/Cargo.toml" ] && [ -f "$RT/tree/Cargo.lock" ] || die "archive incomplete"'),
 ('(cd "$B/tree" && git apply --check "$M/inputs/base-l1-verify.patch" && git apply "$M/inputs/base-l1-verify.patch" && git apply --check "$M/m10-bootstrap-anchor.patch" && git apply "$M/m10-bootstrap-anchor.patch") || die "patches do not apply"',
  '(cd "$RT/tree" && git apply --check "$M/inputs/base-l1-verify.patch" && git apply "$M/inputs/base-l1-verify.patch" && git apply --check "$M/m10-bootstrap-anchor.patch" && git apply "$M/m10-bootstrap-anchor.patch") || die "patches do not apply"'),
 ('cp -a "$B/tree" "$B/control" && python3 -I "$M/control/disable-anchor-checks.py" "$B/control" || die "control preparation"',
  'cp -a "$RT/tree" "$RT/control" && python3 -I "$M/control/disable-anchor-checks.py" "$RT/control" || die "control preparation"\n'
  '[ -z "$(diff -r "$RT/tree" "$B/tree" 2>&1)" ] && echo "## RESUME: build/tree == regenerated 5476069f + M7 + M10" || die "RESUME: build/tree differs from the regenerated tree"\n'
  '[ -z "$(diff -r "$RT/control" "$B/control" 2>&1)" ] && echo "## RESUME: build/control == regenerated control" || die "RESUME: build/control differs from the regenerated control"'),
 ('[ "$(diff -r "$B/tree" "$B/control" | grep -c \'^>\')" = 3 ] || die "control differs by more than the three disabled lines"',
  '[ "$(diff -r "$B/tree" "$B/control" | grep -c \'^>\')" = 3 ] || die "control differs by more than the three disabled lines"\n'
  '[ "$(diff -r "$RT/tree" "$RT/control" | grep -c \'^>\')" = 3 ] && echo "## RESUME: control differs by exactly the three disabled lines" || die "regenerated control differs by more than three lines"'),
 ('cp -r --reflink=auto "$M7_CARGO_HOME/registry" "$M7_CARGO_HOME/git" "$CARGO_HOME/" || die "cargo home copy"',
  '[ -z "$(diff -rq "$M7_CARGO_HOME/registry/cache" "$CARGO_HOME/registry/cache" 2>&1)" ] && echo "## RESUME: private cargo home crate archives == M7 cargo home" || die "RESUME: private cargo home crate archives differ from the M7 copy"\n'
  'rm -rf "$RT"  # RESUME: only this run\'s own regeneration copy\n'
  '[ "${DRY:-0}" = 1 ] && { echo "## DRY: every pre-build check passed; nothing compiled; build/ and old logs untouched"; exit 0; }'),
]
def derive(job):
    raw = open(job, "rb").read()
    assert hashlib.sha256(raw).hexdigest() == JOB_SHA, "job is not the pinned root-test-m10.sh 51ffbda2"
    lines = raw.decode().split("\n")
    for a, b in SUBS:
        assert lines.count(a) == 1, ("anchor not exactly once", a); lines[lines.index(a)] = b
    return "\n".join(lines)
if __name__ == "__main__":
    if sys.argv[1] == "--check": sys.exit(0 if derive(sys.argv[2]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1]))
