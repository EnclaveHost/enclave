#!/usr/bin/env python3
"""Derive runner/m10-guest-test.sh from the PINNED original M10 job root-test-m10.sh (51ffbda2...) by exact, counted line
substitutions in step 0 ONLY (environment, source and cache locations, toolchain checks). From `phase()` onward the body is
byte-identical: every phase, filter, --test-threads=2, named M10 test, exact negative-control failure set, per-package
`cargo clean -p` and fresh=false requirement. Step 0 keeps the original FRESH-build semantics ([ ! -e $B ], new tree, new
control, new private cargo home) but takes the base source from the pinned stage tar instead of a host git repository, and
the cache from the stage instead of the host M7 cargo home, then verifies every locked dependency offline.
Usage: make-guest-runner.py JOB OUT | --check JOB RUNNER"""
import hashlib, sys
JOB_SHA = "51ffbda21d257a9af3b2ab935b3e63b7801112ae4c47ed1645fa67074ad2bae5"
SUBS = [
 ('. "$(dirname "$0")/env.sh"', '. "$(cd "$(dirname "$0")" && pwd)/guest-env.sh"  # GUEST: stage layout, fresh run dir, staged toolchain'),
 ('H=$M/jobs; L=$M/logs; rc=0', 'H=$M/jobs; L=$RUN/logs; rc=0  # GUEST: logs in the per-run directory (the stage stays read-only)'),
 ('echo "## toolchain $(rustc --version) | $(cargo --version)"',
  'echo "## toolchain $(rustc --version) | $(cargo --version)"\n'
  '[ "$(rustc --version)" = "rustc 1.96.0 (ac68faa20 2026-05-25)" ] && [ "$(cargo --version)" = "cargo 1.96.0 (30a34c682 2026-05-25)" ] || die "GUEST: toolchain is not the staged rust 1.96.0"\n'
  '[ "$(command -v rustc)" = "$TC/bin/rustc" ] && [ "$(command -v cargo)" = "$TC/bin/cargo" ] || die "GUEST: rustc/cargo not from the staged toolchain $TC"\n'
  '[ "$CARGO_BUILD_JOBS" = 1 ] && [ "${RUSTFLAGS:-}" = "-C link-arg=-Wl,--threads=1" ] || die "GUEST: need CARGO_BUILD_JOBS=1 and RUSTFLAGS=\'-C link-arg=-Wl,--threads=1\' (one compiler/linker)"\n'
  'echo "## GUEST run $RUN: stage $M, build $B, CARGO_BUILD_JOBS=$CARGO_BUILD_JOBS RUSTFLAGS=\'$RUSTFLAGS\' CC=$(command -v cc) $(cc --version | head -1)"'),
 ('[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"',
  '[ "$(sha $M/src/base-$BASE_REV.tar)" = "$BASE_TAR_SHA" ] || die "GUEST: base source tar is not the staged git archive of $BASE_REV"'),
 ('git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$B/tree" || die "git archive | tar failed"',
  'tar -x -C "$B/tree" -f "$M/src/base-$BASE_REV.tar" || die "tar -x of the staged git archive failed"'),
 ('cp -r --reflink=auto "$M7_CARGO_HOME/registry" "$M7_CARGO_HOME/git" "$CARGO_HOME/" || die "cargo home copy"',
  'cp -r --reflink=auto "$M/cargo-home/registry" "$M/cargo-home/git" "$CARGO_HOME/" || die "cargo home copy"\n'
  'python3 -I "$M/runner/verify-deps.py" "$B/tree/Cargo.lock" "$CARGO_HOME" > "$L/verify-deps.json" || die "GUEST: offline dependency verification failed (see verify-deps.json)"\n'
  'echo "## GUEST: every locked dependency present offline: $(python3 -I -c \'import json,sys;d=json.load(open(sys.argv[1]));print(d["registryPackages"],"registry +",d["gitPackages"],"git; Cargo.lock",d["lockSha256"][:16])\' "$L/verify-deps.json")"'),
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
