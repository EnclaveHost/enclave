#!/usr/bin/env python3
"""Derive jobs/root-build-test-recovery.sh from the ORIGINAL v2 job root-build-test.sh (7c95ec5b...) by 3 counted
insertions: (1) run recovery-precheck.sh right after the toolchain check; (2) after the closure checks, COPY the ended
original target into the NEW recovery target (dependency reuse only; the member test binary must still be REBUILT, and
every control rebuilt and different); (3) a label on the patched step. Every other line is byte-identical: fresh tree from
git archive 5476069f, private cargo home copy + closure verification, lock pin and single inserted entry, cargo tree
closure check, 23 named tests with `23 passed; 0 failed`, 17 exact controls, lib.rs restore checks, optional RELEASE lane.
Usage: make-recovery-job.py ORIGINAL_JOB OUT | --check ORIGINAL_JOB RECOVERY_JOB"""
import hashlib, sys
ORIG_SHA = "7c95ec5bda0fa5812be493d592e1b87c7ed924155fa75c6372dca662a8c384ab"
SUBS = [
 ('[ "$(rustc --version | cut -d\' \' -f2)" = 1.96.0 ] || die "toolchain is not 1.96.0"\n',
  '[ "$(rustc --version | cut -d\' \' -f2)" = 1.96.0 ] || die "toolchain is not 1.96.0"\n'
  'bash "$S/jobs/recovery-precheck.sh" || die "RECOVERY: precheck refused (original evidence, product sources or derivations differ)"\n'),
 ('cmp -s "$L/closure-manifest.json" "$S/inputs/closure-manifest.json" || die "closure manifest differs from the prepared inputs/closure-manifest.json"\n',
  'cmp -s "$L/closure-manifest.json" "$S/inputs/closure-manifest.json" || die "closure manifest differs from the prepared inputs/closure-manifest.json"\n'
  '[ -d "$O/build/target/debug" ] && [ ! -e "$CARGO_TARGET_DIR" ] || die "RECOVERY: original target missing or recovery target exists"\n'
  'cp -a --reflink=auto "$O/build/target" "$CARGO_TARGET_DIR" || die "RECOVERY: target copy failed"\n'
  'echo "## RECOVERY: reusing a COPY of the ended original target for dependencies only (original untouched); the member test binary must still be REBUILT"\n'),
 ('echo "## [1] patched: build + run all tests"\n',
  'echo "## [1] patched (RECOVERY: product lib.rs/main.rs/Cargo.toml unchanged; fixture-only tests.rs f1bd5c1c): build + run all tests"\n'),
]
def derive(job):
    raw = open(job, "rb").read()
    assert hashlib.sha256(raw).hexdigest() == ORIG_SHA, "not the original v2 job 7c95ec5b"
    s = raw.decode()
    for a, b in SUBS:
        assert s.count(a) == 1, ("anchor not exactly once", a[:70]); s = s.replace(a, b)
    return s
if __name__ == "__main__":
    if sys.argv[1] == "--check": sys.exit(0 if derive(sys.argv[2]) == open(sys.argv[3]).read() else 1)
    open(sys.argv[2], "w").write(derive(sys.argv[1]))
