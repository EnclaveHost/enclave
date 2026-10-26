#!/bin/bash
# composition-baseline-fixes-stage: root's targeted job for the r9 BASELINE-NOT-CLEAN components (PREPARED; NOT run by Claude).
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/composition-baseline-fixes-stage
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 6144 --log $ST/logs/root-baseline-fixes.guard -- unshare -rn bash $ST/jobs/root-baseline-fixes.sh > $ST/logs/root-baseline-fixes.out 2>&1; echo $? > $ST/logs/root-baseline-fixes.rc
# Reads r9's private src.git (git archive only; r9, r10 and every source tree are never written). Private exports under
# $ST/runs/<id>/trees, each with the dependency closures COPIED inside (as r9 does), the network runtime built by its real
# builder, the contracts built by an OFFLINE forge with the locally installed solc 0.8.35 (no download), then exact per-file
# counts. PASS only if every row of EXPECTED below matches exactly (tests, pass, fail, skipped=0, todo=0, cancelled=0, the rc,
# and for the preserved original failure the exact failing test name). Any other result - including a timeout - fails.
set -uo pipefail
ip link set lo up || exit 9
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$P/composition-baseline-fixes-stage; G=$P/rpc-runtime-composition-stage/r9/src.git
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave                  # the dependency closures r9 copies (root, network/, relay/)
CAND=82ec7d455cc6e9957c1500f6e58ffde557093392                              # refs/r9/candidate
CONS=81ba668531d17151db810e14562c77a672d742e4                              # refs/src/consumers (the r9 component baseline)
PATCH=$ST/patches/native-relay-remote-verifier-refusal.patch
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## INVALID: $*"; echo "## baseline-fixes rc=1"; exit 1; }
fail() { echo "## FAIL: $*"; rc=1; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/trees" "$OUT/logs" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "stage files differ from SHA256SUMS"
[ "$(git --git-dir=$G rev-parse refs/r9/candidate)" = $CAND ] && [ "$(git --git-dir=$G rev-parse refs/src/consumers)" = $CONS ] || die "r9 refs moved"
export HOME=/home/steven PATH=/home/steven/.foundry/bin:/usr/bin:/bin FOUNDRY_OFFLINE=true
SOLC=$HOME/.local/share/svm/0.8.35/solc-0.8.35
[ "$(sha256sum < $SOLC | cut -c1-64)" = fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4 ] || die "solc 0.8.35 differs from the observed install"
[ "$(sha256sum < $HOME/.foundry/bin/forge | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] || die "forge differs from the observed install"
[ "$(sha256sum < $HOME/.foundry/bin/anvil | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil differs from the observed install"
{ forge --version; anvil --version; openssl version; node --version; } > "$OUT/tools.txt" 2>&1 || die "a required tool does not run (forge/anvil/openssl/node)"
mk() {      # mk NAME COMMIT: exact export + the dependency closures inside it
  local T=$OUT/trees/$1; mkdir -p "$T" && git --git-dir=$G archive "$2" | tar -x -C "$T" || die "$1 export"
  for d in . network relay; do
    [ -d "$E/$d/node_modules" ] || continue
    [ ! -e "$T/$d/node_modules" ] || die "$1: $d/node_modules already present"
    cp -a --reflink=auto "$(realpath -e "$E/$d/node_modules")" "$T/$d/node_modules" || die "$1: copy $d/node_modules"
  done
  (cd "$T" && timeout 600 node relay/build-network.mjs) > "$OUT/logs/$1-network-runtime.out" 2>&1 || die "$1: relay/build-network.mjs"
}
run() {     # run TREE FILE TAG
  (cd "$OUT/trees/$1" && timeout 1800 node --test --test-reporter=tap --test-timeout=600000 "$2" < /dev/null) > "$OUT/logs/$3.tap" 2>&1; echo $? > "$OUT/logs/$3.rc"
}
# --- the r9 candidate: network runtime + offline forge build (real contract artifacts), then the targeted tests
mk candidate $CAND
# the SAME artifact convention as root's jobs/forge-subset.sh (repo foundry.toml, forge 1.7.1, svm solc 0.8.35, offline, one solc job);
# the FULL build here because the rigs read src and test-dir artifacts. da0's MCP r3 artifact step may replace this line 1:1.
(cd "$OUT/trees/candidate" && timeout -k 10 3600 forge build --offline -j 1) > "$OUT/logs/candidate-forge.out" 2>&1 || die "forge build --offline -j 1 (candidate)"
[ -f "$OUT/trees/candidate/contracts/foundry/out/SessionMocks.sol/MockUSDC3009.json" ] && [ -f "$OUT/trees/candidate/contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json" ] || die "forge produced no MockUSDC3009 / EnclaveDeployments artifact"
run candidate test/native-relay-chain-authority.test.mjs cand-native-ORIGINAL                 # the original failure, preserved
(cd "$OUT/trees/candidate" && git apply --check "$PATCH" && git apply "$PATCH") || die "patch does not apply to the candidate"
run candidate test/native-relay-chain-authority.test.mjs cand-native-PATCHED
run candidate test/storage-front-binding-release.test.mjs cand-storage-front
run candidate test/lease-relay-host-policy.test.mjs cand-lease-host-policy
run candidate test/dns-relay-chain-authority.smoke.test.mjs cand-dns-smoke
# --- the r9 component baseline (consumers head) WITH its generated network runtime: the DNS smoke baseline
mk consumers $CONS
run consumers test/dns-relay-chain-authority.smoke.test.mjs cons-dns-smoke
# --- exact verdict
python3 -I - "$OUT/logs" <<'PY' > "$OUT/verdict.json" || rc=1
import json, re, sys, pathlib
L = pathlib.Path(sys.argv[1])
NAT6 = "dns-relay process (challenge replica child): the app-zone reader reads only the verifier; the default never asks it; a remote URL stops it"
EXPECTED = {  # tag: (rc, tests, pass, fail, [exact failing names])
  "cand-native-ORIGINAL": (1, 8, 7, 1, [NAT6]), "cand-native-PATCHED": (0, 8, 8, 0, []), "cand-storage-front": (0, 5, 5, 0, []),
  "cand-lease-host-policy": (0, 9, 9, 0, []), "cand-dns-smoke": (0, 4, 4, 0, []), "cons-dns-smoke": (0, 4, 4, 0, [])}
fails, got = [], {}
for tag, (rc, n, p, f, names) in EXPECTED.items():
    t = (L / f"{tag}.tap").read_text(errors="replace"); r = int((L / f"{tag}.rc").read_text())
    c = {k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", t, re.M)] if m}
    failing = sorted(set(re.findall(r"^not ok \d+ - (.+?)(?: #.*)?$", t, re.M)))
    got[tag] = {"rc": r, **c, "failing": failing}
    if (r, c.get("tests"), c.get("pass"), c.get("fail"), c.get("skipped"), c.get("todo"), c.get("cancelled"), failing) != (rc, n, p, f, 0, 0, 0, sorted(names)):
        fails.append(f"{tag}: got {got[tag]}, expected rc {rc} tests {n} pass {p} fail {f} skip/todo/cancelled 0 failing {names}")
print(json.dumps({"ok": not fails, "fails": fails, "results": got}, indent=1)); sys.exit(1 if fails else 0)
PY
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "stage files CHANGED during the run"
cat "$OUT/verdict.json"; echo "## outputs: $OUT"; echo "## baseline-fixes rc=$rc"; exit $rc
