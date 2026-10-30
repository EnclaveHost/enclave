#!/usr/bin/env bash
# r3: regenerate EVERY composed generated bundle in dependency order, then validate the regenerated candidate.
# ROOT-LAUNCHED, FOREGROUND, offline, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh rpc-runtime-composition-r3-1 2560 unshare -rn bash rpc-runtime-composition-stage/r3/jobs/r3-regenerate-validate.sh
# Writes only r3/run/r3-<UTC>/ (--shared clones of the private src.git: objects read-only, full git provenance). Per test 600 s.
# A. precheck  B. exact checkouts + checked deps  C. bundles: --check (record stale), regenerate in order, --check again, a
# second regeneration must be byte-identical; commit in the PRIVATE run checkout only  D. component tests (each component's own
# segment tests, incl. the reviewed seam aebf4c932) in the component tree vs the regenerated candidate  E. composed-stack tests
# Result: PASS only with zero fail/skip/todo/missing/0-test runs, clean baselines and all stack tests; INCOMPLETE when no
# regression but a baseline or stack condition is unmet; FAIL on any regression, stale bundle or precheck failure.
set -uo pipefail
R3=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-runtime-composition-stage/r3
NM=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/attested-verifier-source/node_modules
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: FAIL (precheck)"; exit 9; fi; }
ip link set lo up 2>/dev/null || true
need "offline (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "r3 files == SHA256SUMS" bash -c "cd $R3 && sha256sum -c --quiet SHA256SUMS"
need "private refs == REFS.txt" bash -c "diff <(git --git-dir=$R3/src.git for-each-ref --format='%(objectname) %(refname)') $R3/REFS.txt"
C=$(git --git-dir=$R3/src.git rev-parse refs/r3/candidate)
need "candidate pins SEAM-RESOLUTIONS.json + root receipt" bash -c "git --git-dir=$R3/src.git log -1 --format=%B $C | grep -qx \"Seam-Resolutions-Sha256: \$(sha256sum < $R3/SEAM-RESOLUTIONS.json | cut -c1-64)\""
need "stage 2 pins RESOLUTIONS-r3.json" bash -c "git --git-dir=$R3/src.git log -1 --format=%B refs/r3/stage2 | grep -qx \"Resolutions-Sha256: \$(sha256sum < $R3/RESOLUTIONS-r3.json | cut -c1-64)\""
NMLOCK=$(git -C $(dirname $NM) rev-parse HEAD:package-lock.json)
X=$R3/run/r3-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/logs $X/tmp $X/trees; export TEST_TMP=$X/tmp TMPDIR=$X/tmp
export GIT_AUTHOR_NAME=SteveDeFacto GIT_COMMITTER_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_AUTHOR_DATE=2026-10-26T00:00:00Z GIT_COMMITTER_DATE=2026-10-26T00:00:00Z
declare -A REF=([consumers]=refs/src/consumers [leaseRelay]=refs/src/leaseRelay [verifier]=refs/src/verifier [route]=refs/src/route [seam]=refs/src/consumers-seam [final]=refs/r3/candidate)
declare -A BASE=([consumers]=9fa02e1bc6 [leaseRelay]=9fa02e1bc6 [verifier]=9fa02e1bc6 [route]=9a4880464 [seam]=81ba66853)
incomplete=0; fail=0
for t in consumers leaseRelay verifier route seam final; do
  git clone -q --shared --no-checkout $R3/src.git $X/trees/$t && git -C $X/trees/$t -c advice.detachedHead=false checkout -q --detach $(git --git-dir=$R3/src.git rev-parse ${REF[$t]}) || { echo "RESULT: FAIL (checkout $t)"; exit 9; }
  ln -s "$(realpath $NM)" $X/trees/$t/node_modules
  [ "$(git -C $X/trees/$t rev-parse HEAD:package-lock.json)" = "$NMLOCK" ] || { echo "[INCOMPLETE] $t: package-lock.json differs from node_modules' lock"; incomplete=1; }
done
F=$X/trees/final; echo "== C. generated bundles (dependency order; attested-guest-verify is pinned to image commit 0235e7d9: check only)"
GENS="build-host-admission build-metal-lease-gas build-host-service-packages build-mcp-guest-bundle build-platform-api-guest-bundle"
for g in $GENS build-attested-guest-verify; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-precheck-$g.out 2>&1; echo "[pre] $g --check rc $?"; done
for pass in 1 2; do for g in $GENS; do (cd $F && timeout 900 node scripts/$g.mjs) > $X/logs/gen-$pass-$g.out 2>&1 || { echo "[FAIL] regenerate $g (pass $pass)"; echo "RESULT: FAIL (bundle)"; exit 1; }; done
  git -C $F status --porcelain | grep -v ' node_modules$' > $X/gen-pass-$pass.status; git -C $F add -A -- . ':!node_modules'; git -C $F diff --cached --binary > $X/gen-pass-$pass.diff; git -C $F reset -q; done
cmp -s $X/gen-pass-1.diff $X/gen-pass-2.diff || { echo "[FAIL] regeneration is not deterministic (pass 1 != pass 2)"; fail=1; }
for g in $GENS build-attested-guest-verify; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-postcheck-$g.out 2>&1 || { echo "[FAIL] $g --check after regeneration"; fail=1; }; done
[ -z "$(git -C $F status --porcelain -- . ':!node_modules' | grep -vE '\.(bundle\.mjs|manifest\.json)$|^.. network/host-services/packages/')" ] || { echo "[FAIL] regeneration touched non-generated files"; git -C $F status --porcelain | head; fail=1; }
git -C $F add -A -- . ':!node_modules'; git -C $F -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m "compose: regenerate generated bundles from the composed sources (r3 job, private)

Regenerated-From: $C
Generators: $GENS (build-attested-guest-verify check only)" || { echo "RESULT: FAIL (regen commit)"; exit 1; }
FINAL=$(git -C $F rev-parse HEAD); git -C $F diff --stat $C HEAD | tail -1; echo "[ok] regenerated candidate $FINAL"
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
: > $X/RESULTS.tsv; echo "== D. component tests"
for k in consumers leaseRelay verifier route seam; do
  for t in $(git -C $F diff --name-only --diff-filter=AM ${BASE[$k]} ${REF[$k]} -- 'test/*.test.mjs' 'test/*.test.py' | grep -v e2e); do
    a=$(run1 $k $t "$k--$(echo $t | tr / _)"); if [ -e $F/$t ]; then b=$(run1 final $t "final--$k--$(echo $t | tr / _)"); else b=MISSING; fi
    if clean "$a"; then if clean "$b"; then v=ok; else v=REGRESSION; fail=1; fi; else v=BASELINE-NOT-CLEAN; incomplete=1; clean "$b" || true; fi
    printf '%s\t%s\tcomponent: %s\tfinal: %s\t%s\n' $k $t "$a" "$b" $v | tee -a $X/RESULTS.tsv
  done
done
echo "== E. composed-stack tests (real modules, recorded boundaries)"
for t in test/stack-provider-authority.test.mjs test/stack-chain-authority-boundary.test.mjs test/stack-custody-v2-refused.test.mjs test/stack-admin-controls.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs test/lease-pinned-relay-config.test.mjs test/metal-measured-control.test.mjs; do
  b=$(run1 final $t "stack--$(basename $t)"); if clean "$b"; then echo "[ok] $t $b"; else echo "[FAIL] $t $b"; fail=1; fi; printf 'STACK\t%s\tfinal: %s\n' $t "$b" >> $X/RESULTS.tsv; done
(cd $X && sha256sum RESULTS.tsv gen-pass-*.diff logs/*.out > RECEIPTS.sha256)
echo "## summary: regenerated $FINAL; $(grep -vc '^STACK' $X/RESULTS.tsv) component tests, regressions $(grep -c REGRESSION $X/RESULTS.tsv), baseline-not-clean $(grep -c BASELINE $X/RESULTS.tsv); stack $(grep -c '^STACK' $X/RESULTS.tsv)"
[ $fail = 0 ] || { echo "RESULT: FAIL"; exit 1; }
[ $incomplete = 0 ] || { echo "RESULT: INCOMPLETE (no regression; NOT a production pass)"; exit 3; }
echo "## rc=0 PASS (regenerated composed candidate $FINAL: component parity + composed-stack tests; private, not pushed, not imaged)"
