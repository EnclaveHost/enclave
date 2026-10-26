#!/bin/bash
# historical-origin-segments-stage/r4: ROOT-OWNED, OFFLINE, FOREGROUND job (Claude prepares; root runs; nothing in the background).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   jobs/q-exit-status.sh root-historical-origin-r4-1 1024 unshare -Urn bash historical-origin-segments-stage/r4/jobs/root-r4-integration-tests.sh
# 1024 MiB = the r14-witness job's own budget for the same r14 wrapper/readiness suites. No network (route check), loopback only.
# Suites (each a structured unittest.TestResult receipt; PASS needs testsRun == expected and 0 failures/errors/skips/xfail/xpass):
#   A  r4 suite: anchored origin 9 + segments/overlay 19 (incl. root 1259 freshness regressions) + integration 13 (patched r14 wrapper +
#      readiness + publisher; current-time freshness parity: expired/NaN/Infinity/bool/future) = 41
#   B  the wrapper's OWN frozen job (wrapper-pruned-identity-stage 281c73cf) on a private copy carrying the r4 PATCHED r14 wrapper:
#      existing 34 + pruned 15 = Ran 49, Ran 34 baseline, baseline blocker reproduced, every mutant KILLED (as the r14 job requires)
#   C  r14 readiness sampler suite (93), UNMODIFIED test file, on the r4 PATCHED sampler; and on the r14 original (baseline): both 93/0
#   D  r14 ops-readiness suite (27), UNMODIFIED, on a private r14 tree copy with the r4 PATCHED publisher+sampler; and baseline: both 27/0
#   F  compose/r15-candidate == tools/compose_r15_candidate.py output (r14 + r4 overlays + lib + pin cascade + MANIFEST)
#   E  legacy activation regression-equivalence: source test_coverage_activation.py (24c37c51) with CHAIN_SERVICE = r14 original, then
#      = r4 patched: identical testsRun and identical not-passed ids required (its baseline status is printed, not assumed)
# r14-witness (SHA256SUMS 1ba2d51a) and r2 (3e82a357) are verified before and after and never written; overlays are proven = r14 + patch.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/historical-origin-segments-stage/r4; R3=$W/historical-origin-segments-stage/r3; R2=$W/historical-origin-segments-stage/r2; R14=$W/base-finality-proof-stage/r14-witness
WRAP=$W/wrapper-pruned-identity-stage; C=$W/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT"; echo "## historical-origin-r4 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
trap '[ -n "$PT" ] && rm -rf --one-file-system -- "$PT"' EXIT
mkdir -p "$OUT" || exit 9
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || die "loopback is not up"
ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
frozen() {
  (cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "r4 != SHA256SUMS"
  pin $R3/SHA256SUMS 9ff56dee722b38b1fc6e996a5157114e1a5a341b525064c1b56bcbbc790e6ed0; (cd $R3 && sha256sum -c --quiet SHA256SUMS) || die "frozen r3 changed"
  pin $R14/SHA256SUMS 1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b; (cd $R14 && sha256sum -c --quiet SHA256SUMS) || die "r14-witness changed"
  pin $R2/SHA256SUMS 3e82a3572133fb3fb740e5130b3934bbf81b3703e56474785b09fa896e39de47; (cd $R2 && sha256sum -c --quiet SHA256SUMS) || die "r2 changed"
  pin $WRAP/SHA256SUMS 281c73cfa3be770f9b3b8ab0ca81052ed0ccb5248e524b4d96829695ec5895f7; (cd $WRAP && sha256sum -c --quiet SHA256SUMS) || die "wrapper stage changed"
  pin $W/base-finality-proof-stage/r6/SHA256SUMS 1655f54f72c3b1416687cdb50e34f2c868a328010036c23d98848a73be08406c
  (cd $W/base-finality-proof-stage/r6 && sha256sum -c --quiet SHA256SUMS) || die "r6 baseline changed"
}
frozen
pin $R14/wrapper/chain_service.py 9607b831c8941d1108022a500cf1ae328367b84a110e38b00fdd18476ff4656a
pin $R14/readiness/readiness_sampler.py 340b47dc2bf3a3d8ffb1609f0f1db686f06ef7d5a6426c6609595290d71d7d25
pin $R14/readiness/publish_readiness.py 155b5cb7f9501feb4826426a295816cd4ee7a29583d8e0ddb7ccf5bb9a5d585d
pin $R14/readiness/test_readiness_sampler.py 6496a3e05a14c51e3134760a2d19423f7d6aa8a15e64bf231bd09b194927d4b1
pin $C/coverage/coverage_gate.py b4f6d639c3f9b12f73938d5993ce0897fe56dcbec1ada3123c4ad80d0ff3854b
pin $C/coverage/origin_extract.py 6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c
pin $C/coverage/test_coverage_gate.py 5d5d8604e41f920ab72eb964516ae3b0a228824207fc5b6ab8ee4244d104fc14
pin $C/coverage/test_origin_extract.py b9b026da24f4b73c5a7918537fc58e9e72c2058e213a15bb858f6ee8c412d4df
pin $C/chain_service.py 75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92
pin $C/test_coverage_activation.py 24c37c51d20f164434739093dd513d9206968e0ac60aec1ba59271b1116fa6f7
pin $C/l1-anchor-a1/live-1958/a1-evidence.json b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c
pin $W/base-finality-proof-stage/r12-final/vendor/anchor-bootstrap.mjs 90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8
pin $W/source/node_modules/@noble/hashes/sha3.js 313da3570150e80b02c3631508ba99099438d2daff641b9cadb2198e0f1d18ec
pin $W/coverage-stage/kzgcheck/target/release/kzgcheck 00b3eeb94efece39e4f2cf8e34d5d3450d532328ccc667a6a74e83b151be10eb
for f in anchored_origin.py segments.py bind_anchor.mjs; do cmp -s $R2/src/$f $S/src/$f || die "r4 src/$f is not the r2 byte"; done
# every overlay is exactly r14 + its patch, and the patched copies pin exactly r4/src's verifier bytes
/usr/bin/python3 -I - "$S" "$R14" <<'PY' || die "overlay composition"
import hashlib, pathlib, re, subprocess, sys, tempfile
S, R = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for rel in ('wrapper/chain_service.py', 'readiness/readiness_sampler.py', 'readiness/publish_readiness.py'):
    with tempfile.TemporaryDirectory() as t:
        x = pathlib.Path(t, 'x'); x.write_bytes((R / rel).read_bytes())
        subprocess.run(['patch', '-s', str(x)], stdin=open(S / 'overlay' / (rel + '.r14.patch')), check=True)
        assert x.read_bytes() == (S / 'overlay' / rel).read_bytes(), ('overlay is not r14 + patch', rel)
want = {f: h(S / 'src' / f) for f in ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py')}
for rel in ('wrapper/chain_service.py', 'readiness/readiness_sampler.py'):
    got = dict(re.findall(r"'(anchored_origin\.py|segments\.py|anchored_acceptance\.py)': '([0-9a-f]{64})'", (S / 'overlay' / rel).read_text()))
    assert got == want, (rel, got, want)
print('overlays = r14 + patch; verifier pins = r4/src:', {k: v[:12] for k, v in want.items()})
PY
PT=$(mktemp -d /tmp/hos-r4.XXXXXX) || die "mktemp"
export TMPDIR=$PT HOME=$PT KZGCHECK=$W/coverage-stage/kzgcheck/target/release/kzgcheck NODE=/usr/bin/node PYTHONDONTWRITEBYTECODE=1
RUN="python3 -B $S/tests/run_all.py"
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle --exclude=./tmp -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
verdict() {   # name receipt rc
  if [ "$3" = 0 ] && python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["pass"] is True else 1)' "$2"; then
    echo "PASS $1 $(python3 -B -c 'import json,sys; c=json.load(open(sys.argv[1]))["counts"]; print("testsRun", c["testsRun"], "failures", c["failures"], "errors", c["errors"], "skipped", c["skipped"])' "$2")"
  else fail "$1 (rc $3; receipt $2)"; fi; }
# readiness private dirs: patched (r4) and baseline (r14)
RD=$PT/readiness-r4; RB=$PT/readiness-r14; mkdir -p $RD $RB
cp $S/overlay/readiness/readiness_sampler.py $S/overlay/readiness/publish_readiness.py $RD/ && cp $R14/readiness/require_ready.py $R14/readiness/test_readiness_sampler.py $RD/ || die "readiness copy"
cp $R14/readiness/readiness_sampler.py $R14/readiness/publish_readiness.py $R14/readiness/require_ready.py $R14/readiness/test_readiness_sampler.py $RB/ || die "baseline copy"
{ echo "node $($NODE --version) python $(python3 --version 2>&1) uid $(id -u)"; sha256sum < "$S/SHA256SUMS"; } > "$OUT/env.txt"
# ---- A: r4 suite (41) ------------------------------------------------------------------------------------------------------
(cd $S/tests && READINESS_DIR=$RD PYTHONPATH=$S/tests timeout 2400 $RUN $OUT/A.json $OUT/A.txt 41 test_anchored_origin test_segments test_r3_integration < /dev/null > $OUT/A.summary 2>&1); verdict A-r4-suite $OUT/A.json $?
# ---- B: the wrapper's own frozen job on a private copy carrying the PATCHED r14 wrapper -----------------------------------------
WC=$PT/wrapper-stage; tcopy $WRAP $WC; mkdir -p $WC/tmp; cp $S/overlay/wrapper/chain_service.py $WC/overlay/wrapper/chain_service.py || die "wrapper copy"
(cd $WC && env -i PATH=/usr/bin:/bin bash ./jobs.sh < /dev/null) > $OUT/B-wrapper-pruned.txt 2>&1; r=$?
if [ $r = 0 ] && grep -qx "rc=0" $OUT/B-wrapper-pruned.txt && grep -qx "BASELINE REPRODUCES BLOCKER" $OUT/B-wrapper-pruned.txt \
   && grep -q "^Ran 49 tests in " $OUT/B-wrapper-pruned.txt && grep -q "^Ran 34 tests in " $OUT/B-wrapper-pruned.txt \
   && grep -qx "$(sha256sum < $S/overlay/wrapper/chain_service.py | cut -c1-64)  overlay/wrapper/chain_service.py" $OUT/B-wrapper-pruned.txt \
   && ! grep -qE 'skipped|expected failure|SURVIVED' $OUT/B-wrapper-pruned.txt; then echo "PASS B-wrapper-pruned (existing 34 + pruned 15 = 49, baseline blocker, all mutants killed) on the r3 wrapper"
else fail "B-wrapper-pruned: rc $r (see $OUT/B-wrapper-pruned.txt)"; fi
# ---- C: readiness sampler suite, r3 patched and r14 baseline ----------------------------------------------------------------
for v in r4:$RD r14:$RB; do n=${v%%:*} d=${v#*:}
  (cd $d && ORIGIN_EXTRACT=$C/coverage/origin_extract.py PYTHONPATH=$d timeout 2400 $RUN $OUT/C-$n.json $OUT/C-$n.txt 93 test_readiness_sampler < /dev/null > $OUT/C-$n.summary 2>&1); verdict C-sampler-$n $OUT/C-$n.json $?
done
# ---- D: ops-readiness suite on private r14 trees (patched publisher+sampler / original) -------------------------------------
for v in r4 r14; do T=$PT/tree-$v; tcopy $R14 $T
  [ $v = r4 ] && { cp $S/overlay/readiness/readiness_sampler.py $S/overlay/readiness/publish_readiness.py $T/readiness/ || die "tree overlay"; }
  (cd $T/tests && PYTHONPATH=$T/tests timeout 1200 $RUN $OUT/D-$v.json $OUT/D-$v.txt 27 test_ops_readiness < /dev/null > $OUT/D-$v.summary 2>&1); verdict D-ops-readiness-$v $OUT/D-$v.json $?
done
# ---- E: legacy activation regression-equivalence (source test_coverage_activation, r14 original vs r3 patched wrapper) -------------
E=$PT/activation; mkdir -p $E; cp $C/test_coverage_activation.py $E/ || die "activation copy"
for v in r14:$R14/wrapper/chain_service.py r4:$S/overlay/wrapper/chain_service.py; do n=${v%%:*} cs=${v#*:}
  (cd $E && CHAIN_SERVICE=$cs OPS_SOURCE=$C PYTHONPATH=$E timeout 1200 $RUN $OUT/E-$n.json $OUT/E-$n.txt any test_coverage_activation < /dev/null > $OUT/E-$n.summary 2>&1)
done
python3 -B - $OUT/E-r14.json $OUT/E-r4.json <<'PY' || fail "E: the patched wrapper changes the legacy activation results"
import json, sys
b, p = (json.load(open(x)) for x in sys.argv[1:3])
print(f"E legacy activation baseline(r14): testsRun {b['counts']['testsRun']} notPassed {len(b['notPassed'])}; patched(r4): testsRun {p['counts']['testsRun']} notPassed {len(p['notPassed'])}")
assert b['counts']['testsRun'] == p['counts']['testsRun'] > 0 and b['notPassed'] == p['notPassed'], (b['notPassed'], p['notPassed'])
print('PASS E-legacy-activation-equivalent' + ('' if b['pass'] else ' (NOTE: baseline r14 itself does not pass this source suite: ' + ', '.join(b['notPassed'])[:400] + ')'))
PY
# ---- F: the r15 candidate tree (compose/r15-candidate) is exactly what the composer produces from frozen r14 + these r4 bytes --------
(cd $S/compose/r15-candidate && sha256sum -c --quiet SHA256SUMS) || fail "F: r15 candidate != its SHA256SUMS"
python3 -B $S/tools/compose_r15_candidate.py $PT/r15-regen > $OUT/F-compose.txt 2>&1 && cmp -s $PT/r15-regen/SHA256SUMS $S/compose/r15-candidate/SHA256SUMS \
  && echo "PASS F-r15-candidate-reproducible $(sha256sum < $S/compose/r15-candidate/SHA256SUMS | cut -c1-64)" || fail "F: candidate is not the composer output (see $OUT/F-compose.txt)"
frozen
if [ $rc = 0 ]; then echo "PASS historical-origin-r4 A 41 + B 49/34/mutants + C 93x2 + D 27x2 + E equivalent + F candidate reproducible" > $OUT/RESULT; else echo "FAIL historical-origin-r4 (see job output)" > $OUT/RESULT; fi
cat $OUT/RESULT; echo "## outputs $OUT"; echo "## r4 SHA256SUMS $(sha256sum < $S/SHA256SUMS | cut -c1-64)"; echo "## historical-origin-r4 rc=$rc"; exit $rc
