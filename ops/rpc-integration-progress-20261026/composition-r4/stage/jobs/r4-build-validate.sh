#!/usr/bin/env bash
# r4: SAME candidate as r3 (refs/r3/candidate c4de37a3, private r3/src.git, read-only) with corrected build provenance:
#   * every private checkout gets the checked dependency closures (root, network/, relay/ node_modules) COPIED INSIDE it
#     (cp -a --reflink=auto; ext4 here = real copy, ~246 MB/tree), identity-checked against each tree's lockfiles before and
#     after; no out-of-tree dependency input, lockedInputs and symlink handling untouched;
#   * build-attested-guest-verify gets its REQUIRED argv: two independent `git archive` exports of the pinned image commit
#     0235e7d9659f1ccbf9f258bd03593d26f32f3f3a (outside the checkouts), check-only (the bundle is pinned to that commit);
#   * root's r3 inventory fix kept: exact SHAs resolved in src.git, nonempty per-component inventory, iterated from file.
# ROOT-LAUNCHED, FOREGROUND, offline, from work/rpc-production-final-20261025 (shared queue, 2560):
#   ./jobs/q-exit-status.sh rpc-runtime-composition-r4-N 2560 unshare -rn bash rpc-runtime-composition-stage/r4/jobs/r4-build-validate.sh [--precheck-only]
# --precheck-only: phase A only (reads and hashes; no clone, copy, build or test). Result: PASS | INCOMPLETE | FAIL (never inflated).
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-runtime-composition-stage; R3=$S/r3; R4=$S/r4; G=$R3/src.git
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave          # the checked dependency closures (read only)
IMG=0235e7d9659f1ccbf9f258bd03593d26f32f3f3a; DEPDIRS=". network relay"
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: FAIL (precheck)"; exit 9; fi; }
sha() { git --git-dir=$G rev-parse --verify -q "$1^{commit}"; }
echo "== A. static precheck (nothing cloned, copied, built or tested)"
ip link set lo up 2>/dev/null || true
need "offline namespace (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "user namespace root (unshare -r)" [ "$(id -u)" = 0 ]
need "r4 files == SHA256SUMS" bash -c "cd $R4 && sha256sum -c --quiet SHA256SUMS"
need "r3 frozen inputs == R3-PINS.sha256" bash -c "cd $R3 && sha256sum -c --quiet $R4/R3-PINS.sha256"
need "r3 private refs == r3/REFS.txt" bash -c "diff <(git --git-dir=$G for-each-ref --format='%(objectname) %(refname)') $R3/REFS.txt"
declare -A REF=([consumers]=refs/src/consumers [leaseRelay]=refs/src/leaseRelay [verifier]=refs/src/verifier [route]=refs/src/route [seam]=refs/src/consumers-seam [final]=refs/r3/candidate)
declare -A BASE=([consumers]=9fa02e1bc6 [leaseRelay]=9fa02e1bc6 [verifier]=9fa02e1bc6 [route]=9a4880464 [seam]=81ba66853)
declare -A SHA; for k in "${!REF[@]}"; do SHA[$k]=$(sha ${REF[$k]}) || { echo "[FAIL] ref $k"; echo "RESULT: FAIL (precheck)"; exit 9; }; done
need "candidate is the r3 candidate c4de37a3" [ "${SHA[final]}" = c4de37a3f97a3350b6e6a30fbc1f9ada66e2c91f ]
need "pinned image commit $IMG present" [ "$(sha $IMG)" = $IMG ]
need "generator scripts are the pinned blobs" bash -c "while read b f; do [ \"\$(git --git-dir=$G rev-parse ${SHA[final]}:\$f)\" = \$b ] || exit 1; done < $R4/GENERATORS.txt"
need "build-attested-guest-verify argv contract: <image tree> <image commit> [--check]" bash -c "git --git-dir=$G show ${SHA[final]}:scripts/build-attested-guest-verify.mjs | grep -qF 'usage: build-attested-guest-verify.mjs <image tree> <image commit> [--check]'"
need "both guest-verify manifests pin image commit $IMG" bash -c "for m in network/attested-guest-verify.bundle.mjs.manifest.json test/fixtures/attested-guest-image.bundle.mjs.manifest.json; do git --git-dir=$G show ${SHA[final]}:\$m | grep -q '\"imageCommit\": \"$IMG\"' || exit 1; done"
need "node v22.23.3" [ "$(node --version)" = v22.23.3 ]
need "anvil present (attested-route-composition needs it; a skip is never clean)" command -v anvil
need "esbuild 0.28.1 in the closure" [ "$(python3 -c "import json;print(json.load(open('$E/node_modules/esbuild/package.json'))['version'])")" = 0.28.1 ]
declare -A TH
for k in "${!REF[@]}"; do for d in $DEPDIRS; do nm=$E/node_modules; [ $d != . ] && nm=$E/$d/node_modules
  o=$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$k]} $d $nm) || { echo "[FAIL] deps $k $d: $o"; echo "RESULT: FAIL (precheck)"; exit 9; }
  th=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['treehash'])" "$o"); [ -z "${TH[$d]:-}" ] || [ "${TH[$d]}" = "$th" ] || { echo "[FAIL] closure $d changed during precheck"; exit 9; }; TH[$d]=$th
done; done; echo "[ok] dependency closures match every tree's lockfiles: root ${TH[.]:0:12} network ${TH[network]:0:12} relay ${TH[relay]:0:12}"
need "closures equal the recorded identities (DEPS.txt)" bash -c "[ \"$(printf '%s %s\n' . ${TH[.]} network ${TH[network]} relay ${TH[relay]})\" = \"\$(cat $R4/DEPS.txt)\" ]"
X=$R4/run/r4-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/logs $X/tmp $X/trees; export TEST_TMP=$X/tmp TMPDIR=$X/tmp
for k in consumers leaseRelay verifier route seam; do
  git --git-dir=$G diff --name-only --diff-filter=AM ${BASE[$k]} ${SHA[$k]} -- 'test/*.test.mjs' 'test/*.test.py' > $X/$k-tests.all || { echo "RESULT: FAIL (inventory $k)"; exit 9; }
  grep -v e2e $X/$k-tests.all > $X/$k-tests.txt || true; [ -s $X/$k-tests.txt ] || { echo "[FAIL] empty inventory $k"; echo "RESULT: FAIL (precheck)"; exit 9; }
  while IFS= read -r t; do git --git-dir=$G cat-file -e ${SHA[$k]}:$t || { echo "[FAIL] $k inventory names a missing $t"; exit 9; }; done < $X/$k-tests.txt
  echo "[ok] inventory $k: $(wc -l < $X/$k-tests.txt) tests"; done
STACK="test/stack-provider-authority.test.mjs test/stack-chain-authority-boundary.test.mjs test/stack-custody-v2-refused.test.mjs test/stack-admin-controls.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs test/lease-pinned-relay-config.test.mjs test/metal-measured-control.test.mjs"
for t in $STACK; do [ -e $R3/stack-tests/$(basename $t) ] || git --git-dir=$G cat-file -e ${SHA[final]}:$t || { echo "[FAIL] stack test $t missing"; exit 9; }; done; echo "[ok] stack inventory: 8 tests present"
need "disk: >= 4 GiB free for 6 trees + closures" [ "$(df -Pk $R4 | awk 'NR==2{print $4}')" -ge 4194304 ]
if [ "${1:-}" = --precheck-only ]; then rm -rf $X; echo "## precheck rc=0 (nothing cloned, copied, built or tested)"; exit 0; fi
echo "== B. exact checkouts with the dependency closures INSIDE each"
for t in consumers leaseRelay verifier route seam final; do T=$X/trees/$t
  git clone -q --shared --no-checkout $G $T 2>/dev/null && git -C $T -c advice.detachedHead=false checkout -q --detach ${SHA[$t]} || { echo "RESULT: FAIL (checkout $t)"; exit 9; }
  for d in $DEPDIRS; do src=$E/node_modules dst=$T/node_modules; [ $d != . ] && src=$E/$d/node_modules dst=$T/$d/node_modules
    [ ! -e $dst ] || { echo "[FAIL] $t: $d/node_modules already in the tree"; exit 9; }; cp -a --reflink=auto $src $dst || { echo "RESULT: FAIL (copy)"; exit 9; }
    o=$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$t]} $d $dst) && [ "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['treehash'])" "$o")" = "${TH[$d]}" ] || { echo "[FAIL] $t $d copy identity"; exit 9; }
  done
  [ -z "$(find $T -path $T/.git -prune -o -type l -print | while read l; do case "$(realpath -m "$l")" in $T/*) ;; *) echo "$l";; esac; done)" ] || { echo "[FAIL] $t has a symlink leaving the tree"; exit 9; }
  echo "[ok] $t ${SHA[$t]:0:12} + closures in-tree"; done
F=$X/trees/final
echo "== C. the pinned image tree, twice (independent git-archive exports, outside the checkouts)"
for i in a b; do mkdir $X/image-$i && git --git-dir=$G archive $IMG | tar -x -C $X/image-$i || { echo "RESULT: FAIL (image export)"; exit 9; }; done
echo "== D. generated bundles in dependency order"
GENS="build-host-admission build-metal-lease-gas build-host-service-packages build-mcp-guest-bundle build-platform-api-guest-bundle"
for g in $GENS; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-precheck-$g.out 2>&1; echo "[pre] $g --check rc $? (stale before regeneration is expected)"; done
fail=0; incomplete=0
for i in a b; do (cd $F && timeout 600 node scripts/build-attested-guest-verify.mjs $X/image-$i $IMG --check) > $X/logs/guest-verify-check-$i.out 2>&1 || { echo "[FAIL] pinned guest-verify bundles do not reproduce from image export $i"; fail=1; }; done
for pass in 1 2; do for g in $GENS; do (cd $F && timeout 900 node scripts/$g.mjs) > $X/logs/gen-$pass-$g.out 2>&1 || { echo "[FAIL] regenerate $g (pass $pass): $(grep -m1 Error $X/logs/gen-$pass-$g.out)"; echo "RESULT: FAIL (bundle)"; exit 1; }; done
  git -C $F add -A -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules'; git -C $F diff --cached --binary > $X/gen-pass-$pass.diff; git -C $F reset -q
  sha256sum $F/relay/network-runtime.bundle.mjs > $X/gen-pass-$pass.ignored.sha256; done
cmp -s $X/gen-pass-1.diff $X/gen-pass-2.diff && cmp -s <(cut -c1-64 $X/gen-pass-1.ignored.sha256) <(cut -c1-64 $X/gen-pass-2.ignored.sha256) || { echo "[FAIL] regeneration is not deterministic"; fail=1; }
for g in $GENS; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-postcheck-$g.out 2>&1 || { echo "[FAIL] $g --check after regeneration"; fail=1; }; done
for i in a b; do (cd $F && timeout 600 node scripts/build-attested-guest-verify.mjs $X/image-$i $IMG --check) > $X/logs/guest-verify-postcheck-$i.out 2>&1 || { echo "[FAIL] guest-verify check after regeneration ($i)"; fail=1; }; done
bad=$(git -C $F status --porcelain -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules' | grep -vE '\.(bundle\.mjs|manifest\.json)$' | grep -v '^.. network/host-services/packages/' || true)
[ -z "$bad" ] || { echo "[FAIL] regeneration touched non-generated files: $bad"; fail=1; }
git -C $F add -A -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules'
GIT_AUTHOR_NAME=SteveDeFacto GIT_COMMITTER_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_AUTHOR_DATE=2026-10-26T00:00:00Z GIT_COMMITTER_DATE=2026-10-26T00:00:00Z \
  git -C $F -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m "compose: regenerate generated bundles from the composed sources (r4 job, private)

Regenerated-From: ${SHA[final]}
Generators: $GENS; build-attested-guest-verify check-only against git-archive exports of $IMG
Dependency-Closures: root ${TH[.]} network ${TH[network]} relay ${TH[relay]}" || { echo "RESULT: FAIL (regen commit)"; exit 1; }
FINAL=$(git -C $F rev-parse HEAD); echo "[ok] regenerated candidate $FINAL ($(git -C $F diff --stat ${SHA[final]} HEAD | tail -1))"
cp $R3/stack-tests/*.mjs $F/test/
summ() { python3 -I - "$1" <<'PY'
import re, sys
s = open(sys.argv[1], errors="replace").read(); g = lambda k: sum(int(x) for x in re.findall(rf"^# {k} (\d+)$", s, re.M))
if re.search(r"^Ran \d+ tests?", s, re.M):
    n = int(re.search(r"^Ran (\d+) tests?", s, re.M).group(1)); sk = sum(int(x) for x in re.findall(r"skipped=(\d+)", s)); ok = bool(re.search(r"^OK", s, re.M))
    print(f"pass={n if ok else 0} fail={0 if ok else 1} skip={sk} todo=0")
else: print(f"pass={g('pass')} fail={g('fail')} skip={g('skipped')} todo={g('todo')}")
PY
}
run1() { local tree=$1 test=$2 log=$X/logs/$3.out
  case $test in *.py) (cd $X/trees/$tree && timeout -k 10 600 python3 "$test" -v) > $log 2>&1;; *) (cd $X/trees/$tree && timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 "$test") > $log 2>&1;; esac
  echo "$? $(summ $log)"; }
clean() { case "$1" in "0 pass=0 "*) return 1;; "0 "*"fail=0 skip=0 todo=0") return 0;; *) return 1;; esac; }
echo "== E. component tests (component tree vs regenerated candidate)"; : > $X/RESULTS.tsv
for k in consumers leaseRelay verifier route seam; do while IFS= read -r t; do
  a=$(run1 $k $t "$k--$(echo $t | tr / _)"); if [ -e $F/$t ]; then b=$(run1 final $t "final--$k--$(echo $t | tr / _)"); else b=MISSING; fi
  if clean "$a"; then if clean "$b"; then v=ok; else v=REGRESSION; fail=1; fi; else v=BASELINE-NOT-CLEAN; incomplete=1; fi
  printf '%s\t%s\tcomponent: %s\tfinal: %s\t%s\n' $k $t "$a" "$b" $v | tee -a $X/RESULTS.tsv; done < $X/$k-tests.txt; done
echo "== F. composed-stack tests"
for t in $STACK; do b=$(run1 final $t "stack--$(basename $t)"); if clean "$b"; then echo "[ok] $t $b"; else echo "[FAIL] $t $b"; fail=1; fi; printf 'STACK\t%s\tfinal: %s\n' $t "$b" >> $X/RESULTS.tsv; done
echo "== G. dependency closures unchanged after builds and tests"
for t in consumers leaseRelay verifier route seam final; do for d in $DEPDIRS; do dst=$X/trees/$t/node_modules; [ $d != . ] && dst=$X/trees/$t/$d/node_modules
  [ "$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$t]} $d $dst | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')" = "${TH[$d]}" ] || { echo "[FAIL] $t $d closure changed during the run"; fail=1; }; done; done
for d in $DEPDIRS; do nm=$E/node_modules; [ $d != . ] && nm=$E/$d/node_modules; [ "$(python3 -I $R4/tools/deps-identity.py $G ${SHA[final]} $d $nm | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')" = "${TH[$d]}" ] || { echo "[FAIL] source closure $d changed"; fail=1; }; done
(cd $X && sha256sum RESULTS.tsv gen-pass-* logs/*.out > RECEIPTS.sha256)
echo "## summary: regenerated $FINAL; component tests $(grep -vc '^STACK' $X/RESULTS.tsv), regressions $(grep -c REGRESSION $X/RESULTS.tsv), baseline-not-clean $(grep -c BASELINE $X/RESULTS.tsv); stack $(grep -c '^STACK' $X/RESULTS.tsv)"
[ $fail = 0 ] || { echo "RESULT: FAIL"; exit 1; }
[ $incomplete = 0 ] || { echo "RESULT: INCOMPLETE (no regression; NOT a production pass)"; exit 3; }
echo "## rc=0 PASS (regenerated composed candidate $FINAL: bundles reproducible, component parity, composed-stack tests; private, not pushed, not imaged)"
