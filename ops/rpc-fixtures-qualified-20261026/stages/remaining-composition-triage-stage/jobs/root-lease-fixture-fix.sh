#!/bin/bash
# remaining-composition-triage-stage: root's targeted job for the ONE uncovered r12 cause - the stale test adapter
# test/helpers/windows-lease-runtime-fixture.mjs (PREPARED; NOT run by Claude). Reads the r12 candidate's git objects and the
# r12 consumers tree's built artifacts only (git --no-optional-locks; nothing in r12 is written). Unpatched evidence is r12's own
# receipts (reused, not rerun): the four lease-* rows fail with "does not provide an export named 'chainAuthorityFromEnv'".
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/remaining-composition-triage-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 2560 --log $ST/logs/root-lease-fixture-fix.guard -- unshare -rn bash $ST/jobs/root-lease-fixture-fix.sh > $ST/logs/root-lease-fixture-fix.out 2>&1; echo $? > $ST/logs/root-lease-fixture-fix.rc
# PASS only if all 7 files match EXACTLY (rc 0, tests = pass, fail/skipped/todo/cancelled 0).
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/remaining-composition-triage-stage; R12=$P/rpc-runtime-composition-stage/r12; X=$R12/run/r4-20261026T031250Z; FG=$X/trees/final/.git
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; C=debbfb377d90f4193ea9182f5cb67d714ffaa322
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; T=$OUT/tree; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## lease-fixture rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" "$T" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
(cd "$R12" && sha256sum -c --quiet SHA256SUMS) || die "r12 stage changed"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME=/home/steven FOUNDRY_OFFLINE=true TMPDIR=$OUT/tmp
[ "$(sha256sum < /home/steven/.foundry/bin/forge | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] || die "forge is not the pinned 1.7.1"
[ "$(sha256sum < /home/steven/.foundry/bin/anvil | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
while read -r b p; do [ "$(git --no-optional-locks --git-dir=$FG rev-parse $C:$p)" = $b ] || die "candidate blob of $p is not $b"; done <<'EOF'
2218d397e81aabe4fe2d50cdfb276696b89b4a80 test/helpers/windows-lease-runtime-fixture.mjs
3d0311e462002783556a0abc984cf51b170a5b01 windows/node/chain.mjs
EOF
for t in lease-designated-relays:67b896836 lease-host-relay:729355c20 lease-pinned-relay:de6d60dd5 lease-relay-migration:847e8df38 windows-current-runtime:755831cf1 windows-host-app-funded:6d563ca55 windows-release-journal:c326e9504; do
  [ "$(git --git-dir=$FG rev-parse --short=9 $C:test/${t%%:*}.test.mjs)" = ${t##*:} ] || die "test blob ${t%%:*}"; done
git --no-optional-locks --git-dir=$FG archive $C | tar -x -C $T || die "export"
for d in . network relay; do src=$E/node_modules; [ $d != . ] && src=$E/$d/node_modules; dst=$T/node_modules; [ $d != . ] && dst=$T/$d/node_modules
  cp -a --reflink=auto "$(realpath -e $src)" $dst || die "$d closure copy"
  want=$(awk -v d=$d '$1==d{print $2}' $R12/DEPS.txt); got=$(python3 -I -B $R12/tools/deps-identity.py $FG $C $d $dst | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')
  [ -n "$want" ] && [ "$got" = "$want" ] || die "$d closure != DEPS.txt"; done
python3 -I -B $R12/tools/copy-artifacts.py $X/trees/consumers/contracts/foundry $T/contracts/foundry $X/ARTIFACTS-consumers.sha256 > $OUT/logs/copy-artifacts.out 2>&1 || die "bound artifacts: $(tail -1 $OUT/logs/copy-artifacts.out)"
(cd $T && timeout 600 node relay/build-network.mjs) > $OUT/logs/network-runtime.out 2>&1 || die "network runtime"
(cd $T && git apply --check $ST/patches/windows-lease-runtime-fixture-exports.patch && git apply $ST/patches/windows-lease-runtime-fixture-exports.patch) || die "patch does not apply"
[ "$(git hash-object $T/test/helpers/windows-lease-runtime-fixture.mjs)" = fbdcfd281d3540eedf6c7ae2cc49faa0712577d8 ] || die "patched fixture is not the reviewed blob"
for t in lease-designated-relays lease-host-relay lease-pinned-relay lease-relay-migration windows-current-runtime windows-host-app-funded windows-release-journal; do
  (cd $T && timeout -k 10 900 node --test --test-reporter=tap --test-timeout=600000 test/$t.test.mjs < /dev/null) > $OUT/logs/$t.tap 2>&1; echo $? > $OUT/logs/$t.rc; done
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1])
EXPECTED = {"lease-designated-relays": 5, "lease-host-relay": 3, "lease-pinned-relay": 4, "lease-relay-migration": 8,
            "windows-current-runtime": 3, "windows-host-app-funded": 3, "windows-release-journal": 7}
fails, got = [], {}
for t, n in EXPECTED.items():
    s = (L / f"{t}.tap").read_text(errors="replace"); r = int((L / f"{t}.rc").read_text())
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
    got[t] = {"rc": r, **c}
    if (r, c.get("tests"), c.get("pass"), c.get("fail"), c.get("skipped"), c.get("todo"), c.get("cancelled")) != (0, n, n, 0, 0, 0, 0):
        fails.append(f"{t}: {got[t]} (expected {n}/{n}, nothing skipped)")
print(json.dumps({"ok": not fails, "fails": fails, "results": got}, indent=1)); sys.exit(1 if fails else 0)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## lease-fixture rc=$rc"; exit $rc
