#!/bin/bash
# scripted-lease-adapter-fix-stage (P6): root's targeted job for the stale SCRIPTED test adapter
# test/helpers/windows-lease-scripted-fixture.mjs (PREPARED; NOT run by Claude). Same shape as remaining-composition-triage-stage's
# lease-fixture job, minus forge/anvil and the contract artifacts (no rig is reached: static closure of 50 source files has no
# network runtime and no contracts/foundry/out). Reads r12's git objects only; nothing in r12 is written.
# Unpatched evidence is r12's OWN receipt, reused (not rerun): final 0/1, SyntaxError "... does not provide an export named
# 'chainAuthorityFromEnv'"; route 16/16 is the count source.
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/scripted-lease-adapter-fix-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 1024 --log $ST/logs/root-scripted-adapter-fix.guard -- unshare -rn bash $ST/jobs/root-scripted-adapter-fix.sh > $ST/logs/root-scripted-adapter-fix.out 2>&1; echo $? > $ST/logs/root-scripted-adapter-fix.rc
# PASS only if rc 0 and exactly tests 16 = pass 16, fail/skipped/todo/cancelled 0.
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/scripted-lease-adapter-fix-stage; R12=$P/rpc-runtime-composition-stage/r12; X=$R12/run/r4-20261026T031250Z; FG=$X/trees/final/.git
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; C=debbfb377d90f4193ea9182f5cb67d714ffaa322; TEST=test/windows-node-lease-renewal-keeper.test.mjs
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; T=$OUT/tree; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## scripted-adapter rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" "$T" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R12" && sha256sum -c --quiet SHA256SUMS) || die "r12 stage changed"
export PATH=/usr/bin:/bin HOME=/home/steven TMPDIR=$OUT/tmp
# source pins (candidate blobs)
while read -r b p; do [ "$(git --git-dir=$FG rev-parse $C:$p)" = $b ] || die "candidate blob of $p is not $b"; done <<'EOF'
7f953dbe80fa8c1a7bb1ea64c811c0572f283c04 test/helpers/windows-lease-scripted-fixture.mjs
3d0311e462002783556a0abc984cf51b170a5b01 windows/node/chain.mjs
a597ca873869eeeaa01d3e86ab0f076230fabbff test/windows-node-lease-renewal-keeper.test.mjs
EOF
[ "$(git --git-dir=$FG grep -l windows-lease-scripted-fixture $C -- test | sed "s/^$C://")" = $TEST ] || die "the scripted adapter has consumers other than $TEST"
# reused unpatched receipts (exact bytes, bound in r12 receipts/RECEIPTS.tsv)
NEG=$X/logs/regress--final--test_windows-node-lease-renewal-keeper.test.mjs.out; CNT=$X/logs/regress--route--test_windows-node-lease-renewal-keeper.test.mjs.out
[ "$(sha256sum < $NEG | cut -c1-64)" = a446a6dd2727e712c59174b5c7714986d196b8d85e83f8ec9a64da0a5f35734e ] || die "r12 final receipt is not the reviewed bytes"
[ "$(sha256sum < $CNT | cut -c1-64)" = 907c8240370cbc08c506b829c28376d3313ed8c9ebda73151b2037075288391d ] || die "r12 route receipt is not the reviewed bytes"
grep -q "does not provide an export named 'chainAuthorityFromEnv'" $NEG && grep -qx '# fail 1' $NEG || die "negative receipt does not show the stale export"
grep -qx '# tests 16' $CNT && grep -qx '# pass 16' $CNT && grep -qx '# skipped 0' $CNT || die "route receipt is not 16/16"
grep -q "a446a6dd2727e712c59174b5c7714986d196b8d85e83f8ec9a64da0a5f35734e" $X/receipts/RECEIPTS.tsv || die "negative receipt not bound in RECEIPTS.tsv"
echo "reused unpatched: final 0/1 (stale export) a446a6dd; route 16/16 907c8240"
# private export + the three dependency closures with r12's DEPS.txt identity
git --git-dir=$FG archive $C | tar -x -C $T || die "export"
for d in . network relay; do src=$E/node_modules; [ $d != . ] && src=$E/$d/node_modules; dst=$T/node_modules; [ $d != . ] && dst=$T/$d/node_modules
  cp -a --reflink=auto "$(realpath -e $src)" $dst || die "$d closure copy"
  want=$(awk -v d=$d '$1==d{print $2}' $R12/DEPS.txt); got=$(python3 -I -B $R12/tools/deps-identity.py $FG $C $d $dst | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')
  [ -n "$want" ] && [ "$got" = "$want" ] || die "$d closure != DEPS.txt"; done
(cd $T && patch -p1 --dry-run -f -s < $ST/patches/windows-lease-scripted-fixture-exports.patch && patch -p1 -f -s --no-backup-if-mismatch < $ST/patches/windows-lease-scripted-fixture-exports.patch) || die "patch does not apply"
[ "$(git hash-object $T/test/helpers/windows-lease-scripted-fixture.mjs)" = 6832c9fd372d0272c4a7f91e10de7cf686d242fa ] || die "patched adapter is not the reviewed blob"
# r12's exact test command
(cd $T && timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 $TEST < /dev/null) > $OUT/logs/renewal-keeper.tap 2>&1; echo $? > $OUT/logs/renewal-keeper.rc
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1]); s = (L / "renewal-keeper.tap").read_text(errors="replace"); r = int((L / "renewal-keeper.rc").read_text())
c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
ok = (r, c.get("tests"), c.get("pass"), c.get("fail"), c.get("skipped"), c.get("todo"), c.get("cancelled")) == (0, 16, 16, 0, 0, 0, 0)
print(json.dumps({"ok": ok, "rc": r, **c, "expected": "16/16, nothing skipped"}, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## scripted-adapter rc=$rc"; exit $rc
