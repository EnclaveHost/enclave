#!/usr/bin/env bash
# Bounded offline validation of the composed CANDIDATE against its components. ROOT-LAUNCHED, FOREGROUND, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh rpc-runtime-composition-validate-N 1536 unshare -rn bash rpc-runtime-composition-stage/jobs/validate-composition.sh
# Optional: RESOLUTIONS=<dir> RESOLUTIONS_SHA256=<reviewed sha> to compose stage 2 (route). Without them only stage 1 is validated.
# 1 compose (compose.sh into a fresh run dir). 2 for each composed component: the tests its OWN segment added/changed
# (test/*.test.mjs and test/*.test.py, no e2e) run in the component's tree AND the composed tree; a test that passes in the
# component must pass composed (a component failure is recorded as pre-existing, never a pass). 3 invariant probes
# (v2 refusal, unsafe/no safe-finalized tier, no implicit public fallback, admin controls) as unchanged-text checks.
# Reuses only existing repo tests. Writes only run/validate-<UTC>/. Accept only `## rc=0`. NOT an integration test of the stack.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$W/rpc-runtime-composition-stage; NM=$W/attested-verifier-source/node_modules
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: PRECHECK-FAILED"; exit 9; fi; }
ip link set lo up 2>/dev/null || true
need "offline (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "stage files == SHA256SUMS" bash -c "cd $S && sha256sum -c --quiet SHA256SUMS"
X=$S/run/validate-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/logs $X/tmp; export TEST_TMP=$X/tmp TMPDIR=$X/tmp
args=(); [ -n "${RESOLUTIONS:-}" ] && args=(--resolutions "$RESOLUTIONS" --resolutions-sha256 "${RESOLUTIONS_SHA256:?}")
bash $S/compose.sh $X/compose "${args[@]}" > $X/logs/compose.out 2>&1; rc=$?; tail -3 $X/logs/compose.out; [ $rc = 0 ] || { echo "RESULT: COMPOSE-FAILED rc $rc"; exit 10; }
T=$X/compose/tree; G="git -C $T"; KS="consumers leaseRelay verifier"; $G rev-parse -q --verify HEAD^{/stage 2} >/dev/null 2>&1 && KS="$KS route"
lock() { git -C "$1" rev-parse HEAD:package-lock.json 2>/dev/null || echo -; }
need "node_modules source lock == composed lock (else tests would run against other deps)" [ "$(git -C $W/attested-verifier-source rev-parse HEAD:package-lock.json)" = "$($G rev-parse HEAD:package-lock.json)" ]
mkdir -p $X/trees; $G archive HEAD | (mkdir $X/trees/composed && tar -x -C $X/trees/composed); ln -s $NM $X/trees/composed/node_modules
fail=0; : > $X/RESULTS.tsv
for k in $KS; do
  base=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["heads"][sys.argv[2]]["base"])' $S/COMMIT-MANIFEST.json $k)
  [ $k = route ] && base=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["lineages"]["routeSnapshot"]["commit"])' $S/COMMIT-MANIFEST.json)
  mkdir $X/trees/$k; $G archive refs/src/$k | tar -x -C $X/trees/$k; ln -s $NM $X/trees/$k/node_modules
  [ "$($G rev-parse refs/src/$k:package-lock.json 2>/dev/null)" = "$($G rev-parse HEAD:package-lock.json)" ] || echo "[note] $k has a different package-lock.json: its own-tree runs use the composed node_modules"
  for t in $($G diff --name-only --diff-filter=AM $base refs/src/$k -- 'test/*.test.mjs' 'test/*.test.py' | grep -v e2e); do
    for side in $k composed; do
      case $t in *.py) cmd=(python3 "$t");; *) cmd=(node --test --test-timeout=300000 "$t");; esac
      (cd $X/trees/$side && timeout -k 10 600 "${cmd[@]}") > "$X/logs/$k--$side--$(echo $t | tr / _).out" 2>&1; echo $? > "$X/logs/$k--$side--$(echo $t | tr / _).rc"
    done
    a=$(cat "$X/logs/$k--$k--$(echo $t | tr / _).rc"); b=$(cat "$X/logs/$k--composed--$(echo $t | tr / _).rc")
    v=same; [ $a = 0 ] && [ $b != 0 ] && { v=REGRESSION; fail=1; }; [ $a != 0 ] && v="pre-existing-failure(component rc $a)"
    printf '%s\t%s\tcomponent=%s\tcomposed=%s\t%s\n' $k $t $a $b "$v" | tee -a $X/RESULTS.tsv
  done
done
echo "== invariant probes (text present in the composed tree exactly where the component has it)"
for p in "network/chain-authority.mjs:no safe or finalized tier" "network/verified-chain.mjs:finality: 'none'" "network/chain-authority.mjs:There is no provider pool, no fallback" \
         "custody/chain-source.mjs:v2 readers (custody/v2/quorum.mjs) REFUSE a verifier client" "network/discovery.mjs:no implicit public gateway or fallback direct dial exists"; do f=${p%%:*} s=${p#*:}
  grep -qF "$s" $X/trees/composed/$f && echo "[ok] $f: $s" || { echo "[FAIL] $f lost: $s"; fail=1; }; done
$G diff --stat refs/src/verifier HEAD -- network/rpc-runtime.mjs metal/chain-verifier-image.json scripts/rpc-runtime | tail -1 | sed 's/^/[verifier runtime\/pin\/recipe files vs composed] /'
[ -z "$($G diff --name-only refs/src/verifier HEAD -- network/rpc-runtime.mjs metal/chain-verifier-image.json scripts/rpc-runtime)" ] || { echo "[FAIL] the composed runtime pin/recipe files differ from the verifier head"; fail=1; }
(cd $X && sha256sum RESULTS.tsv logs/*.out compose/COMPOSITION.json > RECEIPTS.sha256)
echo "## summary: $(grep -c . $X/RESULTS.tsv) component tests; regressions $(grep -c REGRESSION $X/RESULTS.tsv); pre-existing $(grep -c pre-existing $X/RESULTS.tsv); composed $(python3 -I -c 'import json,sys;print(json.load(open(sys.argv[1]))["status"])' $X/compose/COMPOSITION.json)"
[ $fail = 0 ] || { echo "RESULT: VALIDATION-FAILED"; exit 1; }
echo "## rc=0 (component tests compared on the composed CANDIDATE; NOT integration-tested, NOT built, NOT imaged, NOT pushed)"
