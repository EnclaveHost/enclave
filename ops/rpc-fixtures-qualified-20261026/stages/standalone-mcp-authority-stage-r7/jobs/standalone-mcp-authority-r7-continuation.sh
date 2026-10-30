#!/usr/bin/env bash
# standalone-mcp-authority r7 = CONTINUATION of root's ended r6 run (root-mcp-authority-r6-0333, exit 20 SETUP AFTER: two independent
# offline builds, comparator unit tests 23/23, semantic EQUAL 426a7135...). Its only failure was the runner's own final clean check
# (`git status --porcelain` of base was non-empty: the `?? node_modules` symlink the runner itself had created). The product, the
# r2 candidate, the artifacts and the comparator are unchanged: NOTHING is cloned, compiled or compared again.
# Root, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh standalone-mcp-authority-r7 2560 unshare -rn bash standalone-mcp-authority-stage/r7/jobs/standalone-mcp-authority-r7-continuation.sh
# 1. r6's ended run is verified READ ONLY: every evidence file == R6-RUN-RECEIPT.sha256, root's log == R6-ROOT-LOG.sha256 with the
#    exact 23/23 and EQUAL lines; raw artifact + cache manifests recomputed == ARTIFACTS-*/CACHE-*; status == EXPECTED-STATUS-*.txt
#    EXACTLY (base: only `?? node_modules`; cand: the 3 patched files, the new test, `?? node_modules`); HEAD == b6ac5d657; base ==
#    BASE-b6ac5d657.sha256; cand == CANDIDATE.sha256 and the r2 patch reverse-applies; node_modules is the declared symlink; lock +
#    noble pins (DEPS-PINS.txt); Solidity source pins (r6 SOURCE-PINS.sha256).
# 2. Private copies (cp -a --reflink=auto) of base/cand; the same checks again on the copies.
# 3. ONLY the 8 EXPECTED-TAP.txt rows (73 tests) run in the copies, exactly as r6 would have: each exactly `# tests N`, `# pass N`,
#    0 fail/cancelled/skipped/todo, node rc 0. Afterwards: status still EXACTLY expected; artifact/cache manifests unchanged; ignored
#    entries recorded (IGNORED-DELTA.txt), and any ignored change under contracts/foundry fails.
# Exit: 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
M=$W/standalone-mcp-authority-stage; S=$M/r2; R6=$M/r6; R7=$M/r7; RUN6=$R6/run/20261026T035555Z; SRC=$W/relay-consumer-source
BASE=b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604; SEM=426a71358fd9773b4d599afe550e07efb7c8e817b00ca2b496b1df4589a1f0ac
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
(cd $R7 && sha256sum -c --quiet SHA256SUMS) && ok "r7 stage == SHA256SUMS" || setup "r7 stage manifest"
(cd $R6 && sha256sum -c --quiet SHA256SUMS) && ok "r6 stage unchanged (frozen)" || setup "r6 stage manifest"
(cd $M/r5 && sha256sum -c --quiet SHA256SUMS) && ok "r5 stage unchanged (frozen)" || setup "r5 stage manifest"
(cd $S && sha256sum -c --quiet $R6/R2-PINS.sha256 && sha256sum -c --quiet SHA256SUMS) && ok "r2 inputs unchanged (pinned)" || setup "r2 stage manifest"
# ---- 1. the ended r6 run, read only ---------------------------------------------------------------------------------------------
(cd $RUN6 && sha256sum -c --quiet $R7/R6-RUN-RECEIPT.sha256) && ok "r6 run evidence == R6-RUN-RECEIPT.sha256 ($(grep -c . $R7/R6-RUN-RECEIPT.sha256) files)" || setup "r6 run evidence changed"
(cd $W && sha256sum -c --quiet $R7/R6-ROOT-LOG.sha256) && ok "root's r6 log/rc pinned" || setup "root r6 log changed"
grep -Fxq "[ok] comparator unit tests 23/23 (incl. this run's real trees)" $W/logs/root-mcp-authority-r6-0333.out && grep -q "EQUAL semantic $SEM " $RUN6/comparator.out \
  && grep -Fxq '[FAIL] the artifact build changed tracked files' $W/logs/root-mcp-authority-r6-0333.out && ok "r6: comparator 23/23 + EQUAL ${SEM:0:16}; its only failure the runner clean check" || setup "r6 log lines differ"
python3 -I - $RUN6/comparator-unit.tap <<'PY' || setup "comparator-unit.tap is not exactly 23/23"
import re, sys
g = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', open(sys.argv[1]).read(), re.M)}
sys.exit(0 if g == {'tests': 23, 'pass': 23, 'fail': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0} else 1)
PY
read -r _ NMT < <(grep '^node_modules_target ' $R7/DEPS-PINS.txt); read -r _ LOCK < <(grep '^package_lock_sha256 ' $R7/DEPS-PINS.txt); read -r _ NOBLE < <(grep '^noble_sha3_sha256 ' $R7/DEPS-PINS.txt)
[ "$(sha256sum < $SRC/package-lock.json | cut -c1-64)" = $LOCK ] && [ "$(sha256sum < $SRC/node_modules/@noble/hashes/sha3.js | cut -c1-64)" = $NOBLE ] && ok "dependency lock + noble pinned" || setup "dependency closure pins differ"
check_tree() {   # $1 tree dir, $2 base|cand
  local d=$1 t=$2
  [ "$(git -C $d rev-parse HEAD)" = $BASE ] || setup "$t: HEAD is not $BASE"
  cmp -s <(git -C $d status --porcelain=v1) $R7/EXPECTED-STATUS-$t.txt || setup "$t: status is not EXACTLY EXPECTED-STATUS-$t.txt: $(git -C $d status --porcelain=v1 | tr '\n' ';')"
  [ -L $d/node_modules ] && [ "$(readlink $d/node_modules)" = "$NMT" ] || setup "$t: node_modules is not the declared symlink to $NMT"
  cmp -s $SRC/package-lock.json $d/package-lock.json || setup "$t: package-lock differs from the linked install"
  (cd $d && sha256sum -c --quiet $S/BASE-b6ac5d657.sha256 2>/dev/null) || [ $t = cand ] || setup "base: files != BASE-b6ac5d657.sha256"
  if [ $t = cand ]; then (cd $d && sha256sum -c --quiet $S/CANDIDATE.sha256) && git -C $d apply --check -R $S/standalone-mcp-authority-r2.patch || setup "cand: not exactly base + the r2 patch"; fi
  (cd $d && sha256sum -c --quiet $R6/SOURCE-PINS.sha256) || setup "$t: Solidity source pins differ"
  cmp -s <(cd $d/contracts/foundry && find out -type f -name '*.json' | LC_ALL=C sort | xargs sha256sum) $RUN6/ARTIFACTS-$t.sha256 || setup "$t: raw artifact manifest != r6 ARTIFACTS-$t.sha256"
  cmp -s <(sha256sum $d/contracts/foundry/cache/solidity-files-cache.json | sed "s| $d/| |") $RUN6/CACHE-$t.sha256 || setup "$t: forge cache != r6 CACHE-$t.sha256"
}
for t in base cand; do check_tree $RUN6/$t $t; done; ok "r6 trees: exact expected status, symlink, sources, patch, artifacts, cache"
# ---- 2. private copies ------------------------------------------------------------------------------------------------------------
X=$R7/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || setup "run dir exists"; mkdir -p $X/tmp; export TMPDIR=$X/tmp TEST_TMP=$X/tmp
for t in base cand; do cp -a --reflink=auto $RUN6/$t $X/$t || setup "copy $t"; check_tree $X/$t $t; git -C $X/$t status --porcelain=v1 --ignored | LC_ALL=C sort > $X/IGNORED-before-$t.txt; done
ok "private copies identical to r6's trees (r6 run untouched)"
FORGE=/home/steven/.foundry/bin/forge
[ "$(sha256sum < "$(readlink -f "$(command -v forge)")" | cut -c1-64)" = "$(sha256sum < $FORGE | cut -c1-64)" ] && [ "$(sha256sum < $FORGE | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && ok "forge on PATH is the pinned forge (lease-gas-forge.mjs runtime build)" || setup "forge on PATH is not the pinned forge"
command -v anvil >/dev/null && command -v openssl >/dev/null && ok "anvil + openssl present" || setup "anvil/openssl missing (the rigs would skip)"
node --version; (cd $X/cand && node --check cli/independent.mjs && node --check mcp/independent.mjs && node --check mcp/independent-secrets.mjs && node --check mcp/server.mjs) && ok "candidate syntax" || setup "candidate syntax"
# ---- 3. the 8 rows / 73 tests, nothing else ---------------------------------------------------------------------------------------
rc=0
while read -r file side n; do
  d=$X/$([ "$side" = base ] && echo base || echo cand); out=$X/$side-$(basename $file .test.mjs).tap
  (cd $d && timeout -k 10 300 node --test --test-reporter=tap --test-concurrency=1 $file) > $out 2>&1; nrc=$?
  python3 - "$out" "$n" "$nrc" <<'PY'; v=$?
import re, sys
out, n, nrc = open(sys.argv[1], errors='replace').read(), int(sys.argv[2]), int(sys.argv[3])
got = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', out, re.M)}
print(f"  {sys.argv[1].rsplit('/',1)[-1]}: node rc {nrc}, {got}")
need = ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')
if any(k not in got for k in need): print("  INCOMPLETE: summary missing"); sys.exit(3)
if got['fail'] or nrc: print("  FAIL"); sys.exit(1)
if got['tests'] != n or got['pass'] != n or got['cancelled'] or got['skipped'] or got['todo']: print(f"  INCOMPLETE: expected exactly {n} passing, 0 skipped/todo/cancelled"); sys.exit(3)
print("  PASS")
PY
  case $v in 0) ;; 3) [ $rc = 0 ] && rc=30 ;; *) rc=1 ;; esac
done < $S/EXPECTED-TAP.txt
# ---- after: exact tracked state, unchanged artifacts, ignored delta recorded ---------------------------------------------------
for t in base cand; do
  cmp -s <(git -C $X/$t status --porcelain=v1) $R7/EXPECTED-STATUS-$t.txt || { echo "[FAIL] $t: tracked/untracked state changed by the tests"; rc=1; }
  cmp -s <(cd $X/$t/contracts/foundry && find out -type f -name '*.json' | LC_ALL=C sort | xargs sha256sum) $RUN6/ARTIFACTS-$t.sha256 || { echo "[FAIL] $t: contract artifacts changed by the tests"; rc=1; }
  git -C $X/$t status --porcelain=v1 --ignored | LC_ALL=C sort > $X/IGNORED-after-$t.txt
  diff $X/IGNORED-before-$t.txt $X/IGNORED-after-$t.txt > $X/IGNORED-DELTA-$t.txt; echo "  $t ignored-entry delta: $(grep -c '^[<>]' $X/IGNORED-DELTA-$t.txt) lines (recorded in IGNORED-DELTA-$t.txt)"
  grep -E '^[<>] !! contracts/foundry/' $X/IGNORED-DELTA-$t.txt && { echo "[FAIL] $t: ignored output under contracts/foundry changed"; rc=1; }
done
(cd $RUN6 && sha256sum -c --quiet $R7/R6-RUN-RECEIPT.sha256) || { echo "[FAIL] the ended r6 run changed"; rc=1; }
(cd $X && sha256sum *.tap IGNORED-*.txt > RECEIPTS.sha256)
case $rc in 0) echo "RESULT: PASS (73/73 over r6's qualified builds; comparator 23/23 + EQUAL reused from r6)";; 30) echo "RESULT: INCOMPLETE (never a pass)";; *) echo "RESULT: FAIL";; esac
exit $rc
