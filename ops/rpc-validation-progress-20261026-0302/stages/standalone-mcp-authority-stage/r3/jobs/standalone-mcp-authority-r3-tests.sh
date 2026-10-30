#!/usr/bin/env bash
# standalone-mcp-authority r3 = the r2 product and runner (r2 FROZEN; its inputs are read and pinned) + the Foundry contract
# artifacts the anvil rigs need (haveTools(): contracts/foundry/out is gitignored, so r2's fresh clones skipped 34 tests).
# Root, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh standalone-mcp-authority-r3 2560 unshare -rn bash standalone-mcp-authority-stage/r3/jobs/standalone-mcp-authority-r3-tests.sh
# Artifacts: compiled OFFLINE in EACH fresh clone (base and candidate) by the pinned forge with the pinned solc, from the
# exact checkout's contracts + foundry.toml (its compile settings untouched); the two builds must be byte-identical.
# Base = relay-consumer-source b6ac5d657 (fresh clones); candidate = base + standalone-mcp-authority-r2.patch (CANDIDATE.sha256).
# Each file in EXPECTED-TAP.txt must report exactly `# tests N`, `# pass N`, 0 fail/cancelled/skipped/todo, and node rc 0.
# Exit: 0 PASS; 1 FAIL; 30 INCOMPLETE (count mismatch, skip, todo, cancelled); 20 SETUP (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/standalone-mcp-authority-stage/r2; R3=$W/standalone-mcp-authority-stage/r3; SRC=$W/relay-consumer-source; BASE=b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
(cd $R3 && sha256sum -c --quiet SHA256SUMS) && ok "r3 stage == SHA256SUMS" || setup "r3 stage manifest"
(cd $S && sha256sum -c --quiet $R3/R2-PINS.sha256 && sha256sum -c --quiet SHA256SUMS) && ok "r2 inputs unchanged (frozen; pinned)" || setup "r2 stage manifest"
[ "$(git -C $SRC rev-parse "$BASE^{commit}" 2>/dev/null)" = $BASE ] && ok "base commit present" || setup "base commit missing"
X=$R3/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || setup "run dir exists"; mkdir -p $X
for t in base cand; do
  git clone -q --no-local --no-checkout $SRC $X/$t && git -C $X/$t -c advice.detachedHead=false checkout -q --detach $BASE || setup "clone $t"
done
(cd $X/cand && sha256sum -c --quiet $S/BASE-b6ac5d657.sha256) && ok "base files == BASE-b6ac5d657.sha256" || setup "base files"
git -C $X/cand apply --check $S/standalone-mcp-authority-r2.patch && git -C $X/cand apply $S/standalone-mcp-authority-r2.patch || setup "patch does not apply"
(cd $X/cand && sha256sum -c --quiet $S/CANDIDATE.sha256) && ok "candidate files == CANDIDATE.sha256" || setup "candidate files differ"
[ -z "$(git -C $X/base status --porcelain)" ] && ok "base clone clean" || setup "base clone dirty"
# dependencies: the existing install of the source checkout, linked read-only (no install, no network); the lock must match
cmp -s $SRC/package-lock.json $X/cand/package-lock.json && [ -d $SRC/node_modules ] || setup "package-lock differs or no node_modules"
for t in base cand; do ln -s $SRC/node_modules $X/$t/node_modules; done; ok "node_modules linked (package-lock identical)"
# ---- Foundry contract artifacts (the rigs' haveTools(): anvil, openssl AND contracts/foundry/out/...) ---------------------------
FORGE=/home/steven/.foundry/bin/forge SOLC=/home/steven/.local/share/svm/0.8.35/solc-0.8.35
[ "$(sha256sum < $FORGE | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && $FORGE --version | grep -q 4072e48705af9d93e3c0f6e29e93b5e9a40caed8 && ok "forge 1.7.1 (4072e487) pinned" || setup "forge binary is not the pinned one"
[ "$(sha256sum < $SOLC | cut -c1-64)" = fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4 ] && $SOLC --version | grep -q '0.8.35+commit.47b9dedd' && ok "solc 0.8.35+commit.47b9dedd pinned" || setup "solc binary is not the pinned one"
command -v anvil >/dev/null && command -v openssl >/dev/null && ok "anvil $(anvil --version | head -1 | awk '{print $2}'), $(openssl version | awk '{print $1, $2}')" || setup "anvil/openssl missing (the rigs would skip)"
for t in base cand; do grep -qx 'solc = "0.8.35"' $X/$t/foundry.toml || setup "$t foundry.toml does not pin solc 0.8.35"
  git -C $X/$t diff --quiet -- foundry.toml contracts || setup "$t: contracts/foundry.toml differ from the commit"
  [ -z "$(git -C $X/$t ls-files --others --exclude-standard -- contracts foundry.toml)" ] || setup "$t: untracked contract inputs"; done
closure() { git -C $1 ls-files -s -- foundry.toml contracts | sha256sum | cut -c1-64; }
CL=$(closure $X/base); [ "$(closure $X/cand)" = "$CL" ] && ok "contract input closure identical in both trees ($CL; the candidate patch touches no contract)" || setup "contract inputs differ between the trees"
SOURCES=$(sed -n 's/^source //p' $R3/CONTRACT-ARTIFACTS.txt); ARTS=$(sed -n 's/^artifact //p' $R3/CONTRACT-ARTIFACTS.txt)
for t in base cand; do for src in $SOURCES; do
  (cd $X/$t && FOUNDRY_OFFLINE=true timeout -k 10 1200 $FORGE build --offline -j 1 --use $SOLC "$src") > $X/forge-$t-$(basename $src .sol).log 2>&1 || setup "forge build $src ($t): $(tail -2 $X/forge-$t-$(basename $src .sol).log | tr '\n' ' ')"
done
  for a in $ARTS; do python3 -I -c "import json,sys; j=json.load(open(sys.argv[1])); b=j['bytecode']['object']; assert b.startswith('0x') and len(b)>2" $X/$t/contracts/foundry/out/$a || setup "$t: artifact $a missing or has no bytecode"; done
  (cd $X/$t/contracts/foundry && find out -type f -name '*.json' | LC_ALL=C sort | xargs sha256sum) > $X/ARTIFACTS-$t.sha256
done
cmp -s $X/ARTIFACTS-base.sha256 $X/ARTIFACTS-cand.sha256 && ok "both independent builds byte-identical ($(wc -l < $X/ARTIFACTS-base.sha256) artifacts, manifest $(sha256sum < $X/ARTIFACTS-base.sha256 | cut -c1-16))" || setup "the two artifact builds differ (non-deterministic or different inputs)"
printf 'closure %s\nforge 4f77da08 (1.7.1 4072e487)\nsolc fa8ac9a3 (0.8.35+commit.47b9dedd)\nsources %s\n' "$CL" "$(echo $SOURCES)" > $X/ARTIFACT-INPUTS.txt
[ -z "$(git -C $X/base status --porcelain)" ] && ok "base clone still clean (out/ and cache/ are gitignored build output)" || setup "the artifact build changed tracked files"
node --version; (cd $X/cand && node --check cli/independent.mjs && node --check mcp/independent.mjs && node --check mcp/independent-secrets.mjs && node --check mcp/server.mjs) && ok "candidate syntax" || setup "candidate syntax"
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
[ -z "$(git -C $X/base status --porcelain -- . ':!node_modules')" ] || { echo "[FAIL] base clone modified by the run"; rc=1; }
case $rc in 0) echo "RESULT: PASS";; 30) echo "RESULT: INCOMPLETE (never a pass)";; *) echo "RESULT: FAIL";; esac
exit $rc
