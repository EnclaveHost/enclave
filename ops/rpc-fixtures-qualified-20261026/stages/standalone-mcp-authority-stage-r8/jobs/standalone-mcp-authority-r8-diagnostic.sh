#!/usr/bin/env bash
# standalone-mcp-authority r8 = r7 (FROZEN; root-mcp-authority-r7-0407 rc 1: 71/73 = 6 rows / 65 tests PASS; both cli-combined rows 3/4)
# + P8, ONE test-only assertion (patches/P8-cli-combined-signer-mode-diagnostic.patch): the CLI's stray-flag refusal (cli/enclave.mjs
# configureIndependent, identical in base and candidate) names every independent-only flag incl. --chain-verifier; the old regex
# predates that flag. P8 asserts the exact full line, anchored; nonzero exit and noEnclave() unchanged. Product untouched.
# Root, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh standalone-mcp-authority-r8 1408 unshare -rn bash standalone-mcp-authority-stage/r8/jobs/standalone-mcp-authority-r8-diagnostic.sh
# REUSED (nothing cloned, compiled or compared): r6's qualified builds + comparator 23/23 + EQUAL (via r7's pinned receipts) and r7's
# 6 passing rows / 65 tests (R7-RUN-RECEIPT.sha256, REUSED-ROWS.txt). EXECUTED: ONLY test/cli-combined-independent.test.mjs on base and
# candidate private copies (2 rows / 8 tests). Accounting: all 8 EXPECTED-TAP rows = 73 tests, each exactly its count, 0 skip/cancel/todo.
# Exit: 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
M=$W/standalone-mcp-authority-stage; S=$M/r2; R6=$M/r6; R7=$M/r7; R8=$M/r8; RUN6=$R6/run/20261026T035555Z; RUN7=$R7/run/20261026T040635Z
SRC=$W/relay-consumer-source; BASE=b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604; T=test/cli-combined-independent.test.mjs
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
for d in $R8 $R7 $R6 $M/r5; do (cd $d && sha256sum -c --quiet SHA256SUMS) || setup "$(basename $d) stage manifest"; done; ok "r8 stage; r7/r6/r5 frozen"
(cd $S && sha256sum -c --quiet $R6/R2-PINS.sha256 && sha256sum -c --quiet SHA256SUMS) && ok "r2 inputs unchanged (pinned)" || setup "r2 stage manifest"
# ---- reused evidence, read only --------------------------------------------------------------------------------------------------
(cd $RUN6 && sha256sum -c --quiet $R7/R6-RUN-RECEIPT.sha256) && (cd $W && sha256sum -c --quiet $R7/R6-ROOT-LOG.sha256) && ok "r6 builds + comparator 23/23 + EQUAL receipts unchanged" || setup "r6 evidence changed"
(cd $RUN7 && sha256sum -c --quiet $R8/R7-RUN-RECEIPT.sha256 && sha256sum -c --quiet RECEIPTS.sha256) && (cd $W && sha256sum -c --quiet $R8/R7-ROOT-LOG.sha256) && ok "r7 run TAP receipts + root log unchanged" || setup "r7 evidence changed"
tapcheck() {  # $1 tap $2 n $3 rc -> 0 PASS / 1 FAIL / 3 INCOMPLETE
  python3 -I - "$1" "$2" "$3" <<'PY'
import re, sys
out, n, nrc = open(sys.argv[1], errors='replace').read(), int(sys.argv[2]), int(sys.argv[3])
got = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', out, re.M)}
print(f"  {sys.argv[1].rsplit('/',1)[-1]}: node rc {nrc}, {got}")
if any(k not in got for k in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')): print("  INCOMPLETE: summary missing"); sys.exit(3)
if got['fail'] or nrc: print("  FAIL"); sys.exit(1)
if got['tests'] != n or got['pass'] != n or got['cancelled'] or got['skipped'] or got['todo']: print(f"  INCOMPLETE: expected exactly {n}"); sys.exit(3)
print("  PASS")
PY
}
REUSED=0
while read -r file side n tap; do case $file in '#'*|'') continue;; esac
  grep -qx "$file $side $n" $S/EXPECTED-TAP.txt || setup "reused row $file $side $n is not an EXPECTED-TAP row"
  tapcheck $RUN7/$tap $n 0 || setup "reused r7 row $tap is not exactly $n passing"; REUSED=$((REUSED + n))
done < $R8/REUSED-ROWS.txt
[ $REUSED = 65 ] && ok "reused: 6 rows / 65 tests from root's r7 run" || setup "reused count $REUSED != 65"
grep -q 'did not match the regular expression /--signer-mode apply to independent mode' $RUN7/base-cli-combined-independent.tap && grep -q 'did not match the regular expression /--signer-mode apply to independent mode' $RUN7/candidate-cli-combined-independent.tap \
  && ok "r7's 2 failing rows failed exactly on the stale regex P8 replaces" || setup "r7 cli-combined failure is not the known assertion"
# ---- private copies of r6's qualified trees, r7's exact checks, then P8 ----------------------------------------------------------
read -r _ NMT < <(grep '^node_modules_target ' $R7/DEPS-PINS.txt); read -r _ LOCK < <(grep '^package_lock_sha256 ' $R7/DEPS-PINS.txt); read -r _ NOBLE < <(grep '^noble_sha3_sha256 ' $R7/DEPS-PINS.txt)
[ "$(sha256sum < $SRC/package-lock.json | cut -c1-64)" = $LOCK ] && [ "$(sha256sum < $SRC/node_modules/@noble/hashes/sha3.js | cut -c1-64)" = $NOBLE ] && ok "dependency lock + noble pinned" || setup "dependency closure pins differ"
arts() { cmp -s <(cd $1/contracts/foundry && find out -type f -name '*.json' | LC_ALL=C sort | xargs sha256sum) $RUN6/ARTIFACTS-$2.sha256 && cmp -s <(sha256sum $1/contracts/foundry/cache/solidity-files-cache.json | sed "s| $1/| |") $RUN6/CACHE-$2.sha256; }
X=$R8/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || setup "run dir exists"; mkdir -p $X/tmp; export TMPDIR=$X/tmp TEST_TMP=$X/tmp
PRE=$(sed -n 's/  pre-image .*//p' $R8/P8-PINS.txt); POST=$(sed -n 's/  post-image .*//p' $R8/P8-PINS.txt)
for t in base cand; do d=$X/$t
  cp -a --reflink=auto $RUN6/$t $d || setup "copy $t"
  [ "$(git -C $d rev-parse HEAD)" = $BASE ] && cmp -s <(git -C $d status --porcelain=v1) $R7/EXPECTED-STATUS-$t.txt || setup "$t: copy HEAD/status != r7 expected"
  [ -L $d/node_modules ] && [ "$(readlink $d/node_modules)" = "$NMT" ] && cmp -s $SRC/package-lock.json $d/package-lock.json || setup "$t: node_modules symlink/lock"
  (cd $d && sha256sum -c --quiet $R6/SOURCE-PINS.sha256) && arts $d $t || setup "$t: sources/artifacts/cache != r6"
  if [ $t = cand ]; then (cd $d && sha256sum -c --quiet $S/CANDIDATE.sha256) && git -C $d apply --check -R $S/standalone-mcp-authority-r2.patch || setup "cand: not base + r2 patch"
  else (cd $d && sha256sum -c --quiet $S/BASE-b6ac5d657.sha256) || setup "base: != BASE-b6ac5d657.sha256"; fi
  [ "$(sha256sum < $d/$T | cut -c1-64)" = $PRE ] || setup "$t: $T is not the P8 pre-image"
  git -C $d apply $R8/patches/P8-cli-combined-signer-mode-diagnostic.patch && [ "$(sha256sum < $d/$T | cut -c1-64)" = $POST ] || setup "$t: P8 did not produce the pinned post-image"
  cmp -s <(git -C $d status --porcelain=v1 | LC_ALL=C sort) <(LC_ALL=C sort $R8/EXPECTED-STATUS-P8-$t.txt) || setup "$t: status after P8 != EXPECTED-STATUS-P8-$t.txt"
  RF=$(awk '!/^#/ && NF {print "'"$d"'/" $1}' $R8/REUSED-ROWS.txt | sort -u)
  ! grep -lE "cli-combined-independent" $RF $d/test/helpers/*.mjs 2>/dev/null | grep -q . || setup "$t: a reused test or helper references the P8 file (the reused rows would be affected)"
  git -C $d status --porcelain=v1 --ignored | LC_ALL=C sort > $X/IGNORED-before-$t.txt
done; ok "copies == r6's qualified trees; P8 applied exactly (pre/post pinned); no reused test imports the P8 file"
FORGE=/home/steven/.foundry/bin/forge
[ "$(sha256sum < "$(readlink -f "$(command -v forge)")" | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && command -v anvil >/dev/null && command -v openssl >/dev/null && ok "pinned forge on PATH, anvil, openssl" || setup "forge/anvil/openssl"
# ---- execute ONLY the 2 cli-combined rows ----------------------------------------------------------------------------------------
rc=0; EXEC=0
while read -r file side n; do
  [ "$file" = $T ] || continue
  d=$X/$([ "$side" = base ] && echo base || echo cand); out=$X/$side-cli-combined-independent.tap
  (cd $d && timeout -k 10 300 node --test --test-reporter=tap --test-concurrency=1 $file) > $out 2>&1; nrc=$?
  tapcheck $out $n $nrc; v=$?; EXEC=$((EXEC + n))
  case $v in 0) ;; 3) [ $rc = 0 ] && rc=30 ;; *) rc=1 ;; esac
done < $S/EXPECTED-TAP.txt
[ $EXEC = 8 ] || { echo "[FAIL] executed rows cover $EXEC tests, not 8"; rc=1; }
[ $((REUSED + EXEC)) = "$(awk '{s+=$3} END{print s}' $S/EXPECTED-TAP.txt)" ] && echo "  accounting: 65 reused + $EXEC executed = $((REUSED + EXEC)) = every EXPECTED-TAP test" || { echo "[FAIL] accounting"; rc=1; }
for t in base cand; do
  cmp -s <(git -C $X/$t status --porcelain=v1 | LC_ALL=C sort) <(LC_ALL=C sort $R8/EXPECTED-STATUS-P8-$t.txt) || { echo "[FAIL] $t: tracked/untracked state changed by the tests"; rc=1; }
  arts $X/$t $t || { echo "[FAIL] $t: contract artifacts/cache changed by the tests"; rc=1; }
  git -C $X/$t status --porcelain=v1 --ignored | LC_ALL=C sort > $X/IGNORED-after-$t.txt; diff $X/IGNORED-before-$t.txt $X/IGNORED-after-$t.txt > $X/IGNORED-DELTA-$t.txt
  echo "  $t ignored-entry delta: $(grep -c '^[<>]' $X/IGNORED-DELTA-$t.txt) lines (recorded)"; grep -E '^[<>] !! contracts/foundry/' $X/IGNORED-DELTA-$t.txt && { echo "[FAIL] $t: ignored output under contracts/foundry changed"; rc=1; }
done
(cd $RUN6 && sha256sum -c --quiet $R7/R6-RUN-RECEIPT.sha256) && (cd $RUN7 && sha256sum -c --quiet $R8/R7-RUN-RECEIPT.sha256) || { echo "[FAIL] reused evidence changed during the run"; rc=1; }
(cd $X && sha256sum *.tap IGNORED-*.txt > RECEIPTS.sha256)
case $rc in 0) echo "RESULT: PASS (73/73: 65 reused from r7 + 8 executed with P8; builds/comparator reused from r6)";; 30) echo "RESULT: INCOMPLETE (never a pass)";; *) echo "RESULT: FAIL";; esac
exit $rc
