#!/usr/bin/env python3
"""Derive the run-2 job, guest launcher and host watcher (+ its test) from the REVIEWED originals by exact, counted
substitutions; `--check` re-derives and compares all four. Sources (pinned):
  job       root-test-m10.sh            51ffbda2  (m10-bootstrap/jobs)        -> bundle/runner/m10-guest-test-2.sh
  launcher  run-guest.sh                b67fcec1  (m10-guest-validation)      -> bundle/runner/run-guest-2.sh
  watcher   guest-build-watch.py        31264eb0  (jobs/)                     -> host/guest-build-watch-2.py
  test      test-guest-build-watch.py   608162b7  (jobs/)                     -> host/test-guest-build-watch-2.py
Job: step 0 only (from phase() onward byte-identical): FRESH run-2 tree/control from the OLD stage's verified base tar + the
M7 patch + the FIXED M10 patch (pinned d97c31b5); the ENDED run-1 cargo-home/target reused IN PLACE as mutable caches
(no copy), verified offline (verify-deps.py: every crate checksum, fsck of every git db); staged toolchain from the OLD
stage; logs in the run-2 directory. Usage: make-run2-files.py OUTDIR | --check OUTDIR"""
import hashlib, os, sys
W = "/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025"
SRC = {"job": (f"{W}/finality-stage/m10-bootstrap/jobs/root-test-m10.sh", "51ffbda21d257a9af3b2ab935b3e63b7801112ae4c47ed1645fa67074ad2bae5", "bundle/runner/m10-guest-test-2.sh"),
       "launcher": (f"{W}/finality-stage/m10-guest-validation/runner/run-guest.sh", "b67fcec15d11df81938c77c7f951246c0314a958d79aeff1d8195cc6520f9429", "bundle/runner/run-guest-2.sh"),
       "watcher": (f"{W}/jobs/guest-build-watch.py", "31264eb00ba7a912fcef719b5abb768673f67bbd76e3b8d4a65962d9e34868e5", "host/guest-build-watch-2.py"),
       "test": (f"{W}/jobs/test-guest-build-watch.py", "608162b73841cc1ecf905b48334949eb1fa6c8b07fab4b65e7ad77cda910ff8c", "host/test-guest-build-watch-2.py")}
SUBS = {
 "job": [
  ('. "$(dirname "$0")/env.sh"', '. "$(cd "$(dirname "$0")" && pwd)/guest-env-2.sh"  # GUEST run 2: repair stage, OLD stage toolchain/tar, reused run-1 caches'),
  ('H=$M/jobs; L=$M/logs; rc=0', 'H=$M/jobs; L=$RUN/logs; rc=0  # GUEST: logs in the run-2 directory'),
  ('echo "## toolchain $(rustc --version) | $(cargo --version)"',
   'echo "## toolchain $(rustc --version) | $(cargo --version)"\n'
   '[ "$(rustc --version)" = "rustc 1.96.0 (ac68faa20 2026-05-25)" ] && [ "$(cargo --version)" = "cargo 1.96.0 (30a34c682 2026-05-25)" ] || die "GUEST: toolchain is not the staged rust 1.96.0"\n'
   '[ "$(command -v rustc)" = "$TC/bin/rustc" ] && [ "$(command -v cargo)" = "$TC/bin/cargo" ] || die "GUEST: rustc/cargo not from the staged toolchain $TC"\n'
   '[ "$CARGO_BUILD_JOBS" = 1 ] && [ "${RUSTFLAGS:-}" = "-C link-arg=-Wl,--threads=1" ] || die "GUEST: need CARGO_BUILD_JOBS=1 and RUSTFLAGS=\'-C link-arg=-Wl,--threads=1\'"\n'
   '[ "$(sha $M/m10-bootstrap-anchor.patch)" = "$M10_FIXED_SHA" ] || die "GUEST: M10 patch is not the fixed d97c31b5 (test-only import fix)"\n'
   '[ "$CARGO_HOME" = "$CACHE/cargo-home" ] && [ "$CARGO_TARGET_DIR" = "$CACHE/target" ] && [ -d "$CARGO_HOME/registry" ] && [ -d "$CARGO_TARGET_DIR/debug" ] || die "GUEST: run-1 caches missing or not the configured ones"\n'
   'echo "## GUEST run 2 $RUN: repair stage $M, OLD stage $OLD, REUSED run-1 caches $CACHE/{cargo-home,target} (mutable), CC=$(command -v cc) $(cc --version | head -1)"'),
  ('[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ] || die "base repo not at $BASE_REV"',
   '[ "$(sha $OLD/src/base-$BASE_REV.tar)" = "$BASE_TAR_SHA" ] || die "GUEST: base source tar is not the staged git archive of $BASE_REV"'),
  ('git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$B/tree" || die "git archive | tar failed"',
   'tar -x -C "$B/tree" -f "$OLD/src/base-$BASE_REV.tar" || die "tar -x of the staged git archive failed"'),
  ('cp -r --reflink=auto "$M7_CARGO_HOME/registry" "$M7_CARGO_HOME/git" "$CARGO_HOME/" || die "cargo home copy"',
   '# RUN 2: the ENDED run-1 cargo home is reused in place (not recopied); it must still satisfy every locked dependency offline\n'
   'python3 -I "$M/runner/verify-deps.py" "$B/tree/Cargo.lock" "$CARGO_HOME" > "$L/verify-deps.json" || die "GUEST: offline dependency verification of the reused cargo home failed (see verify-deps.json)"\n'
   'echo "## GUEST: reused cargo home satisfies every locked dependency offline: $(python3 -I -c \'import json,sys;d=json.load(open(sys.argv[1]));print(d["registryPackages"],"registry +",d["gitPackages"],"git; fsck",all(d["fsckFullStrict"].values()))\' "$L/verify-deps.json")"'),
 ],
 "launcher": [
  ("BASE=/srv/m10-guest-validation; S=$BASE/stage; N=${1:-}; WANT=${2:-}",
   "BASE=/srv/m10-guest-validation; S=$BASE/stage-import-recovery; OLD=$BASE/stage; CACHE=$BASE/runs/run-1/build; N=${1:-}; WANT=${2:-}"),
  ('[[ "$N" =~ ^[1-9]$ ]] && [[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: usage run-guest.sh <1-9> <manifest-sha256>"; exit 2; }',
   '[[ "$N" =~ ^[2-9]$ ]] && [[ "$WANT" =~ ^[0-9a-f]{64}$ ]] || { echo "## REFUSED: usage run-guest-2.sh <2-9> <repair-manifest-sha256>"; exit 2; }'),
  ("bash $S/runner/verify-stage.sh $S $WANT > $R/run-$N.preflight.out 2>&1",
   "bash $S/runner/verify-stage-2.sh $S $WANT > $R/run-$N.preflight.out 2>&1"),
  ("-p ReadWritePaths=$RUN -p WorkingDirectory=$RUN", '-p "ReadWritePaths=$RUN $CACHE/cargo-home $CACHE/target" -p WorkingDirectory=$RUN'),
  ("  -E M10_STAGE=$S -E M10_RUN=$RUN -E HOME=$RUN/home", "  -E M10_STAGE=$S -E M10_OLD_STAGE=$OLD -E M10_CACHE=$CACHE -E M10_RUN=$RUN -E HOME=$RUN/home"),
  ("     /bin/bash $S/runner/m10-guest-test.sh > $R/run-$N.out 2>&1", "     /bin/bash $S/runner/m10-guest-test-2.sh > $R/run-$N.out 2>&1"),
 ],
 "watcher": [
  ("a.add_argument('attempt',type=int,choices=range(1,10))", "a.add_argument('attempt',type=int,choices=range(2,10))"),
  ("check=f'sudo test ! -e {base}/runs/run-{n} && sudo test ! -e {base}/receipts/run-{n}.rc && ! sudo systemctl is-active --quiet {unit}'",
   "check=f'sudo test ! -e {base}/runs/run-{n} && sudo test ! -e {base}/receipts/run-{n}.rc && ! sudo systemctl is-active --quiet {unit} && sudo test -s {base}/receipts/run-1.rc && ! sudo systemctl is-active --quiet m10-guest-validation-1.service'"),
  ("cmd=SSH+[f'sudo bash {base}/stage/runner/run-guest.sh {n} {p.manifest}']", "cmd=SSH+[f'sudo bash {base}/stage-import-recovery/runner/run-guest-2.sh {n} {p.manifest}']"),
 ],
 "test": [("with_name('guest-build-watch.py')", "with_name('guest-build-watch-2.py')")],
}
def derive(k):
    src, pin, _ = SRC[k]; raw = open(src, "rb").read(); assert hashlib.sha256(raw).hexdigest() == pin, (k, "source pin")
    s = raw.decode()
    for a, b in SUBS[k]:
        assert s.count(a) == 1, (k, a[:70]); s = s.replace(a, b)
    return s
if __name__ == "__main__":
    chk = sys.argv[1] == "--check"; out = sys.argv[2] if chk else sys.argv[1]; bad = 0
    for k in SRC:
        p = os.path.join(out, SRC[k][2])
        if chk: bad += derive(k) != open(p).read()
        else: open(p, "w").write(derive(k))
    sys.exit(1 if bad else 0)
