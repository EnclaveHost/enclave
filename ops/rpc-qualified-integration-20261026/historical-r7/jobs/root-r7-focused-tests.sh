#!/bin/bash
# historical-origin-segments-stage/r7: ROOT-OWNED (FOCUSED), OFFLINE, FOREGROUND job (Claude prepares; root runs; nothing in the background).
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && \
#   jobs/q-exit-status.sh root-historical-origin-r7-1 1024 unshare -Urn bash historical-origin-segments-stage/r7/jobs/root-r7-focused-tests.sh
# 1024 MiB = the r14-witness job's own budget for the same r14 wrapper/readiness suites. No network (route check), loopback only.
# Suites (each a structured unittest.TestResult receipt; PASS needs testsRun == expected and 0 failures/errors/skips/xfail/xpass):
#   A  r5 suite: anchored origin 9 + segments/overlay 19 + integration 13 (r4 parity, initial window) + r5 continuation 13 (real journal/
#      watermark/lock run('base') phases, producer permit helpers, readiness post-bootstrap vs initial) = 54
#   B  the wrapper's OWN frozen job (wrapper-pruned-identity-stage 281c73cf) on a private copy carrying the r5 PATCHED r14 wrapper:
#      existing 34 + pruned 15 = Ran 49, Ran 34 baseline, baseline blocker reproduced, every mutant KILLED (as the r14 job requires)
#   C  r14 readiness sampler suite (93), UNMODIFIED test file, on the r5 PATCHED sampler; and on the r14 original (baseline): both 93/0
#   D  r14 ops-readiness suite (27), UNMODIFIED, on a private r14 tree copy with the r5 PATCHED publisher+sampler; and baseline: both 27/0
#   F  compose/r17-candidate == tools/compose_r17_candidate.py output (r14 + r5 overlays + lib + pin cascade + MANIFEST)
#   E  legacy activation regression-equivalence: source test_coverage_activation.py (24c37c51) with CHAIN_SERVICE = r14 original, then
#      = r5 patched: identical testsRun and identical not-passed ids required (its baseline status is printed, not assumed)
# r14-witness (SHA256SUMS 1ba2d51a) and r2 (3e82a357) are verified before and after and never written; overlays are proven = r14 + patch.
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/historical-origin-segments-stage/r7; R6=$W/historical-origin-segments-stage/r6; R5=$W/historical-origin-segments-stage/r5; R4=$W/historical-origin-segments-stage/r4; R3=$W/historical-origin-segments-stage/r3; R2=$W/historical-origin-segments-stage/r2; R14=$W/base-finality-proof-stage/r14-witness
WRAP=$W/wrapper-pruned-identity-stage; C=$W/source/ops/rpc-backend-bootstrap/2026-10-25
OUT=$S/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT"; echo "## historical-origin-r7 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
trap '[ -n "$PT" ] && rm -rf --one-file-system -- "$PT"' EXIT
mkdir -p "$OUT" || exit 9
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || die "loopback is not up"
ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
frozen() {
  (cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "r7 != SHA256SUMS"
  pin $R6/SHA256SUMS 0f2ee122fa6f265903e28d46989de6d7ac77b8ac923a0c094a95b21c2c612d16; (cd $R6 && sha256sum -c --quiet SHA256SUMS) || die "frozen r6 changed"
  pin $R5/SHA256SUMS 6b820ca1363297ef16ee3d0ca9610695fd2639ea54073ced8568688637712d94; (cd $R5 && sha256sum -c --quiet SHA256SUMS) || die "frozen r5 changed"
  pin $R4/SHA256SUMS 57d9772024e33507797688210c8d1eb972ae57c0487bfdee0c8e99f6ab4cfe6b; (cd $R4 && sha256sum -c --quiet SHA256SUMS) || die "frozen r4 changed"
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
pin $R14/producer/base_launch.py 5e567c93676a7f7fd48040a7f90ffae860f454a0a69efd8f3f1445a5b87b224b
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
for f in anchored_origin.py segments.py bind_anchor.mjs; do cmp -s $R2/src/$f $S/src/$f || die "r7 src/$f is not the r2 byte"
  done; for f in $(cd $R5 && ls overlay/*/*.py tests/*.py | grep -v test_r5_continuation.py | tr "\n" " "); do cmp -s $R5/$f $S/$f || die "r7 $f is not the frozen r5 byte"; done
# every overlay is exactly r14 + its patch, and the patched copies pin exactly r5/src's verifier bytes
/usr/bin/python3 -I - "$S" "$R14" <<'PY' || die "overlay composition"
import hashlib, pathlib, re, subprocess, sys, tempfile
S, R = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
for rel in ('wrapper/chain_service.py', 'readiness/readiness_sampler.py', 'readiness/publish_readiness.py', 'producer/base_launch.py'):
    with tempfile.TemporaryDirectory() as t:
        x = pathlib.Path(t, 'x'); x.write_bytes((R / rel).read_bytes())
        subprocess.run(['patch', '-s', str(x)], stdin=open(S / 'overlay' / (rel + '.r14.patch')), check=True)
        assert x.read_bytes() == (S / 'overlay' / rel).read_bytes(), ('overlay is not r14 + patch', rel)
want = {f: h(S / 'src' / f) for f in ('anchored_origin.py', 'segments.py', 'anchored_acceptance.py')}
for rel in ('wrapper/chain_service.py', 'readiness/readiness_sampler.py'):
    got = dict(re.findall(r"'(anchored_origin\.py|segments\.py|anchored_acceptance\.py)': '([0-9a-f]{64})'", (S / 'overlay' / rel).read_text()))
    assert got == want, (rel, got, want)
print('overlays = r14 + patch; verifier pins = r5/src:', {k: v[:12] for k, v in want.items()})
PY
PT=$(mktemp -d /tmp/hos-r7.XXXXXX) || die "mktemp"
export TMPDIR=$PT HOME=$PT KZGCHECK=$W/coverage-stage/kzgcheck/target/release/kzgcheck NODE=/usr/bin/node PYTHONDONTWRITEBYTECODE=1
RUN="python3 -B $S/tests/run_all.py"
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle --exclude=./tmp -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
verdict() {   # name receipt rc
  if [ "$3" = 0 ] && python3 -B -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if d["pass"] is True else 1)' "$2"; then
    echo "PASS $1 $(python3 -B -c 'import json,sys; c=json.load(open(sys.argv[1]))["counts"]; print("testsRun", c["testsRun"], "failures", c["failures"], "errors", c["errors"], "skipped", c["skipped"])' "$2")"
  else fail "$1 (rc $3; receipt $2)"; fi; }
# readiness private dirs: patched (r5) and baseline (r14)
RD=$PT/readiness-r5; RB=$PT/readiness-r14; mkdir -p $RD $RB
cp $S/overlay/readiness/readiness_sampler.py $S/overlay/readiness/publish_readiness.py $RD/ && cp $R14/readiness/require_ready.py $R14/readiness/test_readiness_sampler.py $RD/ || die "readiness copy"
cp $R14/readiness/readiness_sampler.py $R14/readiness/publish_readiness.py $R14/readiness/require_ready.py $R14/readiness/test_readiness_sampler.py $RB/ || die "baseline copy"
{ echo "node $($NODE --version) python $(python3 --version 2>&1) uid $(id -u)"; sha256sum < "$S/SHA256SUMS"; } > "$OUT/env.txt"
# ---- A: r5 suite (54) ------------------------------------------------------------------------------------------------------
(cd $S/tests && READINESS_DIR=$RD PYTHONPATH=$S/tests timeout 2400 $RUN $OUT/A.json $OUT/A.txt 54 test_anchored_origin test_segments test_r3_integration test_r5_continuation < /dev/null > $OUT/A.summary 2>&1); verdict A-r5-suite $OUT/A.json $?
# ---- B/C/D: REUSED, never re-run: root's TERMINAL r5 run root-historical-r5-1287 (rc 1 only from A and the E skip) actually passed
# B (wrapper-pruned 49/34/baseline/mutants), C (sampler 93 on r5 and r14) and D (ops-readiness 27 on r5 and r14) on bytes that r7 carries
# UNCHANGED. Reuse requires: the exact receipt/output bytes (sha), their PASS criteria re-evaluated here, the run bound to r5 SHA256SUMS,
# and byte identity of every code/test input those suites read (r7 overlays == r5 overlays; r14 and the wrapper stage frozen above).
R5RUN=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/historical-origin-segments-stage/r5/logs/run-20261026T121237Z-1651535
pin $W/logs/root-historical-r5-1287.out c247442c079eb5d8d1919045b434c6ecc24b7403a189e7d6058eb0665857da5d
pin $R5RUN/env.txt 91c17632e6831aac4ec562f1dc8e94e33f414e7e8a44f72ba26d6b7215002388
grep -qx '6b820ca1363297ef16ee3d0ca9610695fd2639ea54073ced8568688637712d94  -' $R5RUN/env.txt || die "reused run is not bound to r5 SHA256SUMS"
pin $R5RUN/B-wrapper-pruned.txt 24ba17913b96288cb15acee06677d871e6b130de6cb8442a16ab364f499c543e
pin $R5RUN/C-r5.json 979993e4f2096eca477edb26ccbe48707672b98d83e497b0548718827415a4e1; pin $R5RUN/C-r14.json 979993e4f2096eca477edb26ccbe48707672b98d83e497b0548718827415a4e1
pin $R5RUN/D-r5.json cd71416401081dcd2cd1cc67823816f070b33d04c4a4c52fe95de623ce2da29b; pin $R5RUN/D-r14.json cd71416401081dcd2cd1cc67823816f070b33d04c4a4c52fe95de623ce2da29b
pin $R5RUN/C-r5.txt a65c6fd8f7b8dc0e905d77d5234a181d8e2e80a043bd8c412e8bb38ec6ac7f26; pin $R5RUN/C-r14.txt 50d2abea614f0a295fcada8fe82b67f8e836821f3ac5320f21569a0f2f9455ef
pin $R5RUN/D-r5.txt 653dae8536914541e9840716b3858197cb091777fa9df10d599b1737916d6866; pin $R5RUN/D-r14.txt a4ebbcda44f42837246e9c3260c22f3847b93ba8cad0cc0ed5a97dd3a0943e47
for f in overlay/wrapper/chain_service.py overlay/readiness/readiness_sampler.py overlay/readiness/publish_readiness.py; do cmp -s $R5/$f $S/$f || die "$f differs from the r5 bytes the reused receipts tested"; done
for l in 'PASS B-wrapper-pruned (existing 34 + pruned 15 = 49, baseline blocker, all mutants killed) on the r3 wrapper' \
         'PASS C-sampler-r5 testsRun 93 failures 0 errors 0 skipped 0' 'PASS C-sampler-r14 testsRun 93 failures 0 errors 0 skipped 0' \
         'PASS D-ops-readiness-r5 testsRun 27 failures 0 errors 0 skipped 0' 'PASS D-ops-readiness-r14 testsRun 27 failures 0 errors 0 skipped 0'; do
  grep -qxF "$l" $W/logs/root-historical-r5-1287.out || die "reused PASS line absent: $l"; done      # ("r3 wrapper" is that job's stale label; the B receipt's sha line binds the byte)
B=$R5RUN/B-wrapper-pruned.txt
grep -qx "rc=0" $B && grep -qx "BASELINE REPRODUCES BLOCKER" $B && grep -q "^Ran 49 tests in " $B && grep -q "^Ran 34 tests in " $B \
  && grep -qx "$(sha256sum < $S/overlay/wrapper/chain_service.py | cut -c1-64)  overlay/wrapper/chain_service.py" $B && ! grep -qE 'skipped|expected failure|SURVIVED' $B \
  || die "reused B receipt does not show a full pass on THIS wrapper byte"
python3 -B - $R5RUN <<'PYU' || die "reused C/D receipts are not full passes"
import json, sys
for n, want in (('C-r5', 93), ('C-r14', 93), ('D-r5', 27), ('D-r14', 27)):
    d = json.load(open(f'{sys.argv[1]}/{n}.json'))
    assert d['pass'] is True and d['counts'] == {'testsRun': want, 'failures': 0, 'errors': 0, 'skipped': 0, 'expectedFailures': 0, 'unexpectedSuccesses': 0}, (n, d['counts'])
print('REUSED B 49/34/baseline/mutants, C 93 x2, D 27 x2 from root-historical-r5-1287 (byte-identical inputs)')
PYU
# ---- E: legacy activation regression-equivalence (source test_coverage_activation, r14 original vs r3 patched wrapper) -------------
E=$PT/activation; mkdir -p $E; cp $C/test_coverage_activation.py $E/ || die "activation copy"
REAL=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/base-download-tuning/snapshot-manifest-observed.json
pin $REAL 1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2   # the observed raw Base snapshot manifest (RealManifest fixture)
for v in r14:$R14/wrapper/chain_service.py r5:$S/overlay/wrapper/chain_service.py; do n=${v%%:*} cs=${v#*:}
  (cd $E && REAL_SNAPSHOT_MANIFEST=$REAL TEST_TMP=$PT CHAIN_SERVICE=$cs OPS_SOURCE=$C PYTHONPATH=$E timeout 1200 $RUN $OUT/E-$n.json $OUT/E-$n.txt any test_coverage_activation < /dev/null > $OUT/E-$n.summary 2>&1)
done
python3 -B - $OUT/E-r14.json $OUT/E-r5.json <<'PY' || fail "E: the patched wrapper changes the legacy activation results"
import json, sys
b, p = (json.load(open(x)) for x in sys.argv[1:3])
print(f"E legacy activation baseline(r14): testsRun {b['counts']['testsRun']} notPassed {len(b['notPassed'])}; patched(r5): testsRun {p['counts']['testsRun']} notPassed {len(p['notPassed'])}")
assert b['counts']['testsRun'] == p['counts']['testsRun'] > 0 and b['notPassed'] == p['notPassed'], (b['notPassed'], p['notPassed'])
# r6: no skip is accepted any more (r4/r5 runs skipped RealManifest: REAL_SNAPSHOT_MANIFEST was not provided); both must fully pass
assert b['pass'] is True and p['pass'] is True and b['counts']['skipped'] == p['counts']['skipped'] == 0, ('not a full pass', b['counts'], p['counts'], b['notPassed'])
print(f"PASS E-legacy-activation (r14 and r6 wrapper both testsRun {p['counts']['testsRun']}, 0 failures/errors/skips; RealManifest on 1f0c4e6c)")
PY
# ---- F: r17 (r6, frozen) unchanged and reproducible from r6's composer; r7 changes only tests, so the candidate bytes are r17's
(cd $R6/compose/r17-candidate && sha256sum -c --quiet SHA256SUMS) || fail "F: r17 candidate != its SHA256SUMS"
pin $R6/compose/r17-candidate/SHA256SUMS b31dba16c15825562188d432b59b51addc9cc8d4d9952c578a9677aa4f6c3778
python3 -B $R6/tools/compose_r17_candidate.py $PT/r17-regen > $OUT/F-compose.txt 2>&1 && cmp -s $PT/r17-regen/SHA256SUMS $R6/compose/r17-candidate/SHA256SUMS \
  && echo "PASS F-r17-candidate-reproducible b31dba16c15825562188d432b59b51addc9cc8d4d9952c578a9677aa4f6c3778" || fail "F: r17 is not the composer output (see $OUT/F-compose.txt)"
frozen
if [ $rc = 0 ]; then echo "PASS historical-origin-r7 A 54 + E full pass (real manifest) + F r17 reproducible; B/C/D reused from root 1287 (verified)" > $OUT/RESULT; else echo "FAIL historical-origin-r7 (see job output)" > $OUT/RESULT; fi
cat $OUT/RESULT; echo "## outputs $OUT"; echo "## r7 SHA256SUMS $(sha256sum < $S/SHA256SUMS | cut -c1-64)"; echo "## historical-origin-r7 rc=$rc"; exit $rc
