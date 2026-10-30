#!/usr/bin/env bash
# Root runner: G5 stale-regex fix for test/attested-chain-verifier.test.mjs on the FROZEN r12 final tree.
# Works ONLY on a scratch copy inside this stage; the r12 run (trees/, image-*/) is read, hashed before and after, never written.
# No network, no build, no queue, no commit. Exit 0 only if every check below matches.
set -euo pipefail
BASE=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
STAGE=$BASE/provider-verifier-composition-review-stage/r2
RUN=$BASE/rpc-runtime-composition-stage/r12/run/r4-20261026T031250Z
FINAL=$RUN/trees/final
PATCH=$STAGE/patch/g5-exact-cause.patch
TS=$(date -u +%Y%m%dT%H%M%SZ)
OUT=$STAGE/jobs/out-$TS; SCRATCH=$STAGE/jobs/scratch-$TS
mkdir -p "$OUT"
fail() { echo "FAIL: $*" | tee -a "$OUT/SUMMARY.txt"; exit 1; }

# pinned inputs (frozen run + staged files)
check() { local want=$1 f=$2; local got; got=$(sha256sum "$f" | cut -d' ' -f1); [ "$got" = "$want" ] || fail "hash $f: $got != $want"; }
pins() {
  check e439642ae156b00c0d69114627b424e36539a30376bc6d23e2cb63b2b515f957 "$FINAL/test/attested-chain-verifier.test.mjs"
  check f4fd60a8b77b47d65a6a29220c71687fcdb0fda4d9fe6d0dd31367cd6daa6387 "$FINAL/test/attested-route-composition.test.mjs"
  check 6ee6dc6edda978b306f8363ffcb30174bd9fca3e3670b5d26b8387d121b884eb "$FINAL/network/wg-provider/attested-authority.mjs"
  check 478bc424a2d431928962a3d4e48280e398d571b37cf7695609b0254dc0ffc652 "$PATCH"
  check e439642ae156b00c0d69114627b424e36539a30376bc6d23e2cb63b2b515f957 "$STAGE/work/a/test/attested-chain-verifier.test.mjs"
  check 2a2968e64205f5ab00ac770ea4d3adeebf9f7f7f3f6e5ce1393aff67b538cf9b "$STAGE/work/b/test/attested-chain-verifier.test.mjs"
}
(cd "$STAGE" && sha256sum -c --quiet MANIFEST.sha256)
pins
( cd "$FINAL" && find . -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum ) > "$OUT/final-tree.before.sha256"

test "$(git -C "$FINAL" rev-parse HEAD)" = debbfb377d90f4193ea9182f5cb67d714ffaa322
cp -a --reflink=auto "$FINAL" "$SCRATCH"
cd "$SCRATCH"

# run one test file; expect exact pass/fail counts (node:test TAP summary)
runt() { local label=$1 file=$2 wp=$3 wf=$4 log="$OUT/$1.tap"; local rc=0
  timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 "$file" > "$log" 2>&1 || rc=$?
  python3 - "$log" "$wp" "$wf" "$rc" <<'CHECK'
import re,sys
p,f,rc=map(int,sys.argv[2:]);out=open(sys.argv[1]).read()
d={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',out,re.M)}
print(sys.argv[1],rc,d)
assert d=={'tests':p+f,'pass':p,'fail':f,'cancelled':0,'skipped':0,'todo':0},d
assert rc==(1 if f else 0),rc
CHECK
}


# 1. negative control: the unpatched final reproduces the r12 result (14 pass, 1 fail: G5, the stale chainVerifier regex)
runt pre-attested-chain-verifier test/attested-chain-verifier.test.mjs 14 1
grep -q '^not ok .* - G5: ' "$OUT/pre-attested-chain-verifier.tap" || fail 'pre: failing subtest is not G5'
grep -q 'chainVerifier is not used with chainAuthority \\"attested-verifier\\" (a local verifier is a different authority): remove it' "$OUT/pre-attested-chain-verifier.tap" \
  || grep -q 'chainVerifier is not used with chainAuthority "attested-verifier" (a local verifier is a different authority): remove it' "$OUT/pre-attested-chain-verifier.tap" \
  || fail 'pre: G5 actual error is not the documented chainVerifier refusal'

# 2. apply the staged patch (test file only) and confirm the exact after-image
patch -p1 --dry-run < "$PATCH" > "$OUT/patch-dry-run.txt"
patch -p1 < "$PATCH" > "$OUT/patch-apply.txt"
check 2a2968e64205f5ab00ac770ea4d3adeebf9f7f7f3f6e5ce1393aff67b538cf9b test/attested-chain-verifier.test.mjs
diff -u "$FINAL" "$SCRATCH" -r -q -x node_modules > "$OUT/scratch-vs-final.txt" 2>&1 || true
[ "$(grep -c . "$OUT/scratch-vs-final.txt")" = 1 ] && grep -q 'test/attested-chain-verifier.test.mjs' "$OUT/scratch-vs-final.txt" || fail 'patch touched more than the one test file'

# 3. patched: both named tests plus the provider-verifier stack the r12 run ran against final
runt attested-chain-verifier       test/attested-chain-verifier.test.mjs 15 0
runt attested-route-composition    test/attested-route-composition.test.mjs 7 0
runt metal-measured-control        test/metal-measured-control.test.mjs 15 0
runt attested-paid-provider        test/attested-paid-provider.test.mjs 11 0
runt attested-provider-collateral  test/attested-provider-collateral.test.mjs 8 0
runt host-services-agent-verifier  test/host-services-agent-verifier.test.mjs 5 0

# 4. the frozen run is unchanged
pins
( cd "$FINAL" && find . -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum ) > "$OUT/final-tree.after.sha256"
cmp -s "$OUT/final-tree.before.sha256" "$OUT/final-tree.after.sha256" || fail 'frozen final tree changed during the run'
echo "OK all checks; outputs in $OUT; scratch $SCRATCH (delete when reviewed)" | tee -a "$OUT/SUMMARY.txt"
