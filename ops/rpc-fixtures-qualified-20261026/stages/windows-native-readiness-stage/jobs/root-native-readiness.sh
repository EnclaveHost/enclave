#!/bin/bash
# windows-native-readiness-stage: root's job for r12's only remaining NOT-RUN test - windows-node-lease-readiness test 9, the native
# PowerShell cutover gate (PREPARED; NOT run by Claude). LOCAL, offline: the existing PowerShell 7.4.6 (node-hold-package-20261021,
# used by root's earlier lease-readiness run) and the existing cutover tools (lease-readiness-20261022/cutover; the only version in
# the workspace), placed beside a private export of the r12 candidate exactly where the UNCHANGED test resolves them
# (../../cutover/tools, ../../cutover/helper). No Windows host, SSH, install or build of product code; nothing in r12 is written.
# The gate parses the helper and evaluates ONLY its pure ReadinessNumber/LeaseReady functions over the test's fixture - this is
# native-PowerShell gate qualification, NOT proof of a Windows live RPC cutover.
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/windows-native-readiness-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $ST/logs/root-native-readiness.guard -- unshare -rn bash $ST/jobs/root-native-readiness.sh > $ST/logs/root-native-readiness.out 2>&1; echo $? > $ST/logs/root-native-readiness.rc
# PASS only if: rc 0, `# tests 9`, `# pass 9`, 0 fail/skipped/todo/cancelled (test 9 RUN, not skipped).
set -uo pipefail
ip link set lo up 2>/dev/null || true
WK=/home/steven/Documents/Codex/2026-10-18/wo/work; P=$WK/rpc-production-final-20261025
ST=$P/windows-native-readiness-stage; R12=$P/rpc-runtime-composition-stage/r12; FG=$R12/run/r4-20261026T031250Z/trees/final/.git
E=$WK/enclave; C=debbfb377d90f4193ea9182f5cb67d714ffaa322; TF=test/windows-node-lease-readiness.test.mjs
PW=$WK/node-hold-package-20261021/tools/pwsh; CUT=$WK/lease-readiness-20261022/cutover
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## native-readiness rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R12" && sha256sum -c --quiet SHA256SUMS) || die "r12 stage changed"
# the exact test and helper blobs (the test is used UNCHANGED)
while read -r b p; do [ "$(git --no-optional-locks --git-dir=$FG rev-parse $C:$p)" = $b ] || die "candidate blob of $p is not $b"; done <<'EOF'
8a06240767e2f7b8fb3e408f83c8f4a8c7106cdf test/windows-node-lease-readiness.test.mjs
06bbcd5a4478a0ffe333e4d717c310eb875d6bf9 test/helpers/fake-base-rpc.mjs
3d0311e462002783556a0abc984cf51b170a5b01 windows/node/chain.mjs
EOF
# the native tools: exact bytes (one version exists in the workspace) and the pinned PowerShell 7.4.6 tree (apphost + its DLLs)
[ "$(sha256sum < $CUT/tools/gate-from-report.ps1 | cut -c1-64)" = 08d6dff1b13abf1c6d117a0e3f678fcc9fd0206122c866b41ccc2f5f36d84fc9 ] || die "gate-from-report.ps1 differs"
[ "$(sha256sum < $CUT/helper/node-hold-cutover.ps1 | cut -c1-64)" = f1cd279d63f072367103f2210f318435eb2811f5848a8acc65009be22a93cd02 ] || die "node-hold-cutover.ps1 differs"
[ "$(sha256sum < $PW/pwsh | cut -c1-64)" = 827b5d8ed210a85bf06214e500a955f5ad72bd0afd90127de727eb7d5d70187e ] || die "pwsh apphost differs"
TD=$(python3 -I -B - "$PW" <<'PY'
import hashlib, os, sys
root = sys.argv[1]; rows = []
for d, ds, fs in os.walk(root):
    ds.sort()
    for f in sorted(fs):
        p = os.path.join(d, f); r = os.path.relpath(p, root)
        rows.append(f"L {r} -> {os.readlink(p)}" if os.path.islink(p) else f"F {r} {oct(os.lstat(p).st_mode & 0o777)} {hashlib.sha256(open(p,'rb').read()).hexdigest()}")
rows.sort(); print(hashlib.sha256(('\n'.join(rows) + '\n').encode()).hexdigest())
PY
); [ "$TD" = 45b346f4c3aede929185c61b0e7baa40c6574bf612ac13d9d17f4c5528eaf014 ] || die "the PowerShell tree differs ($TD)"
[ "$(DOTNET_CLI_TELEMETRY_OPTOUT=1 POWERSHELL_TELEMETRY_OPTOUT=1 HOME=$OUT/tmp $PW/pwsh --version 2>&1 | head -1)" = "PowerShell 7.4.6" ] || die "pwsh --version is not 7.4.6"
# private export + the cutover tools beside it (exactly ../../cutover from the test) + the dependency closures (read-only links)
T=$OUT/repo; mkdir -p $T && git --no-optional-locks --git-dir=$FG archive $C | tar -x -C $T || die "export"
mkdir -p $OUT/cutover/tools $OUT/cutover/helper && cp $CUT/tools/gate-from-report.ps1 $OUT/cutover/tools/ && cp $CUT/helper/node-hold-cutover.ps1 $OUT/cutover/helper/ || die "cutover tools copy"
for d in . network relay; do src=$E/node_modules; [ $d != . ] && src=$E/$d/node_modules; dst=$T/node_modules; [ $d != . ] && dst=$T/$d/node_modules
  ln -s "$(realpath -e $src)" $dst || die "$d closure link"
  want=$(awk -v d=$d '$1==d{print $2}' $R12/DEPS.txt); got=$(python3 -I -B $R12/tools/deps-identity.py $FG $C $d "$(realpath -e $src)" | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')
  [ -n "$want" ] && [ "$got" = "$want" ] || die "$d closure != DEPS.txt"; done
(cd $T && timeout 600 node relay/build-network.mjs) > $OUT/logs/network-runtime.out 2>&1 || die "network runtime (r12's fixture context)"
(cd $T && env PWSH=$PW/pwsh DOTNET_CLI_TELEMETRY_OPTOUT=1 POWERSHELL_TELEMETRY_OPTOUT=1 HOME=$OUT/tmp TMPDIR=$OUT/tmp \
   timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 $TF < /dev/null) > $OUT/logs/readiness.tap 2>&1; echo $? > $OUT/logs/readiness.rc
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1]); t = (L / 'readiness.tap').read_text(errors='replace'); r = int((L / 'readiness.rc').read_text())
c = {k: int(m.group(1)) for k in ('tests', 'pass', 'fail', 'skipped', 'todo', 'cancelled') for m in [re.search(rf'^# {k} (\d+)$', t, re.M)] if m}
ran9 = bool(re.search(r'^ok 9 - actual Host readiness serializes into the exact cutover gate; a cold successor is refused$', t, re.M))
ok = (r, c.get('tests'), c.get('pass'), c.get('fail'), c.get('skipped'), c.get('todo'), c.get('cancelled')) == (0, 9, 9, 0, 0, 0, 0) and ran9
print(json.dumps({'ok': ok, 'rc': r, **c, 'nativeGateRan': ran9}, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## native-readiness rc=$rc"; exit $rc
