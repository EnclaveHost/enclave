#!/bin/bash
# offchain-registration-fixture-stage: root's targeted job for the ONE remaining offchain-heartbeat-writers failure (PREPARED;
# NOT run by Claude). Test-only: case 1 waited for "[registry] registered https://host.independent.test", but the rig registers
# that endpoint first, so the REAL supervisor (unchanged) ADOPTS the row via setProofKey. The patch accepts either reviewed boot
# path for the rig's own row id only and binds the chain row (endpoint/operator/active) before measuring; every zero-heartbeat,
# three-60s-period, one-price-drift, deregistration, CORS and signed-capacity assertion is unchanged.
# Inputs: the COMPLETED rig r2 run's final tree (MockFeed built, base supervisor fixture placed) - read only, copied fresh.
# Unpatched evidence reused, not rerun: rig r2 final 2 pass / 1 fail (6189579f...), ownercli identical (same test+supervisor blobs).
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/offchain-registration-fixture-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 768 --log $ST/logs/root-offchain-registration-fixture.guard -- unshare -rn bash $ST/jobs/root-offchain-registration-fixture.sh > $ST/logs/root-offchain-registration-fixture.out 2>&1; echo $? > $ST/logs/root-offchain-registration-fixture.rc
# PASS only if rc 0 and exactly tests 3 = pass 3, fail/skipped/todo/cancelled 0 (all three cases, negative control included).
set -uo pipefail
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/offchain-registration-fixture-stage; RR=$P/rig-artifact-closure-stage/r2; RUN=$RR/run/20261026T034813Z; SRC=$RUN/trees/final
TEST=test/offchain-heartbeat-writers.test.mjs HBF=supervisor.base-6f2c7da46.js
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; T=$OUT/tree; rc=0; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## offchain-registration rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/logs" "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
[ "$(sha256sum < $RR/SHA256SUMS | cut -c1-64)" = aaea7dfa2a7f9fbfde8322ba41b72ea5df2a606298fbb65c8b3cefce37ab7c9a ] && (cd $RR && sha256sum -c --quiet SHA256SUMS) || die "rig r2 stage changed"
[ "$(sha256sum < $RUN/RECEIPTS.sha256 | cut -c1-64)" = e33f07bb5726747bf8557284458307d73a2239c5447a6a2fba92dce7210eac57 ] && (cd $RUN && sha256sum -c --quiet RECEIPTS.sha256) || die "rig r2 receipts changed"
NEG=$RUN/logs/rerun--final--test_offchain-heartbeat-writers.test.mjs.tap
[ "$(sha256sum < $NEG | cut -c1-64)" = 6189579f4ba28a455b264cff1d32c2e6b9e5b26017d7a55fce74e03e8903413b ] || die "reused unpatched receipt is not the reviewed bytes"
grep -q '^not ok 1 - the REAL supervisor' $NEG && grep -q 'adopted the existing registration of https://host.independent.test' $NEG && grep -qx '# pass 2' $NEG && grep -qx '# fail 1' $NEG || die "reused receipt does not show the adoption-path failure"
# tools exactly as the rig r2 run used them (anvil for the rig; forge for its runtime builds)
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME=/home/steven FOUNDRY_OFFLINE=true TMPDIR=$OUT/tmp TEST_TMP=$OUT/tmp
[ "$(sha256sum < "$(command -v forge)" | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] || die "forge is not the pinned 1.7.1"
[ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
# fresh private copy of the completed tree, then exact identity checks on the copy
cp -a --reflink=auto "$SRC" "$T" || die "copy"
pins() { while read -r h p; do case $p in HEAD) [ "$(git --git-dir=$1/.git rev-parse HEAD)" = $h ] || return 1;;
  porcelain*) [ "$(git --git-dir=$1/.git --work-tree=$1 status --porcelain=v1 --untracked-files=all --ignored | sha256sum | cut -c1-64)" = $h ] || return 1;;
  *) [ "$(git hash-object $1/$p)" = $h ] || return 1;; esac; done < $ST/SOURCE-PINS.txt; }
pins "$T" || die "fresh copy differs from SOURCE-PINS.txt (HEAD / blobs / porcelain)"
[ "$(sha256sum < $T/contracts/foundry/out/EnclaveDeployments.multicallValue.t.sol/MockFeed.json | cut -c1-64)" = ae2e63e011b8801f1f92fc0c9e4bdad6a060f55a7e47a03e5fe94c17ec7cf81d ] || die "MockFeed is not the rig r2 artifact"
(cd $T && patch -p1 --dry-run -f -s < $ST/patches/offchain-heartbeat-registration-adoption.patch && patch -p1 -f -s --no-backup-if-mismatch < $ST/patches/offchain-heartbeat-registration-adoption.patch) || die "patch does not apply"
[ "$(git hash-object $T/$TEST)" = 4260cd8e5724d66fb2741eac4a176e5f563c93f2 ] || die "patched test is not the reviewed blob"
# full file, all 3 cases; outer timeout above the test's own declared 900 s case timeout (rig r2's outer 600 s was too tight)
(cd $T && OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR=$T/$HBF timeout -k 10 1500 node --test --test-reporter=tap --test-timeout=900000 $TEST < /dev/null) > $OUT/logs/heartbeat.tap 2>&1; echo $? > $OUT/logs/heartbeat.rc
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1]); s = (L / "heartbeat.tap").read_text(errors="replace"); r = int((L / "heartbeat.rc").read_text())
c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}
ok = (r, c.get("tests"), c.get("pass"), c.get("fail"), c.get("skipped"), c.get("todo"), c.get("cancelled")) == (0, 3, 3, 0, 0, 0, 0)
ok = ok and all(re.search(rf"^ok {i} - ", s, re.M) for i in (1, 2, 3))
print(json.dumps({"ok": ok, "rc": r, **c, "expected": "3/3, nothing skipped"}, indent=1)); sys.exit(0 if ok else 1)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## offchain-registration rc=$rc"; exit $rc
