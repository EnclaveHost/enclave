#!/usr/bin/env bash
# lease-deep-recovery r2: offline, strict TAP. Root, from work/rpc-production-final-20261025, after review:
#   ./jobs/q-exit-status.sh lease-move-r2 1024 unshare -rn bash lease-deep-recovery-solution-stage/r2/jobs/lease-move-r2-tests.sh
# Base = relay-consumer-source 81ba66853 (fresh clones); candidate = base + move-release-recovery-r2.patch (CANDIDATE.sha256).
# Each file in EXPECTED-TAP.txt must report exactly `# tests N`, `# pass N`, 0 fail/cancelled/skipped/todo, and node rc 0.
# Exit: 0 PASS; 1 FAIL; 30 INCOMPLETE (count mismatch, skip, todo, cancelled); 20 SETUP (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/lease-deep-recovery-solution-stage/r2; SRC=$W/relay-consumer-source; BASE=81ba668531d17151db810e14562c77a672d742e4
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
(cd $S && sha256sum -c --quiet SHA256SUMS) && ok "r2 stage == SHA256SUMS" || setup "r2 stage manifest"
[ "$(git -C $SRC rev-parse "$BASE^{commit}" 2>/dev/null)" = $BASE ] && ok "base commit present" || setup "base commit missing"
X=$S/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || setup "run dir exists"; mkdir -p $X
for t in base cand; do
  git clone -q --no-local --no-checkout $SRC $X/$t && git -C $X/$t -c advice.detachedHead=false checkout -q --detach $BASE || setup "clone $t"
done
[ "$(git -C $X/cand rev-parse $BASE:cli/enclave.mjs)" = 4ef7f7a15904a2279d3cfdda872ac4aafeb7f786 ] && ok "base cli/enclave.mjs blob 4ef7f7a1" || setup "base blob"
git -C $X/cand apply --check $S/move-release-recovery-r2.patch && git -C $X/cand apply $S/move-release-recovery-r2.patch || setup "patch does not apply"
(cd $X/cand && sha256sum -c --quiet $S/CANDIDATE.sha256) && ok "candidate files == CANDIDATE.sha256" || setup "candidate files differ"
[ -z "$(git -C $X/base status --porcelain)" ] && ok "base clone clean" || setup "base clone dirty"
# dependencies: the existing install of the source checkout, linked read-only (no install, no network); the lock must match
cmp -s $SRC/package-lock.json $X/cand/package-lock.json && [ -d $SRC/node_modules ] || setup "package-lock differs or no node_modules"
for t in base cand; do ln -s $SRC/node_modules $X/$t/node_modules; done; ok "node_modules linked (package-lock identical)"
node --version; (cd $X/cand && node --check cli/enclave.mjs && node --check cli/move-release-confirm.mjs) && ok "candidate syntax" || setup "candidate syntax"
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
