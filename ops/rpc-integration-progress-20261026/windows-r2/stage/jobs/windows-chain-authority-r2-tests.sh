#!/usr/bin/env bash
# windows-chain-authority r2: offline, strict TAP. PREPARED; NOT run by Claude. Root, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh windows-chain-authority-r2 1792 unshare -rn bash windows-chain-authority-stage/r2/jobs/windows-chain-authority-r2-tests.sh
# Candidate = relay-consumer-source aebf4c932 (seams + its regenerated lease bundle + deep CLI, pushed) + windows-chain-authority-r2.patch
# (CANDIDATE.sha256). No bundled source changes: the committed bundles must pass --check UNCHANGED (any staleness is a SETUP failure,
# never silently rebuilt). The tests drive real modules against loopback recorders only. PASS only if every EXPECTED-TAP count is
# exact, 0 fail/cancelled/skipped/todo, rc 0; plus the existing lease-seams/move tests as regressions (strict counts below).
# Exit: 0 PASS; 1 FAIL; 30 INCOMPLETE; 20 SETUP (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/windows-chain-authority-stage/r2; SRC=$W/relay-consumer-source; BASE=aebf4c9321279c37afce863c2bd6144a96128cea
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
(cd $S && sha256sum -c --quiet SHA256SUMS) && ok "stage == SHA256SUMS" || setup "stage manifest"
[ "$(git -C $SRC rev-parse "$BASE^{commit}" 2>/dev/null)" = $BASE ] && ok "base commit present" || setup "base commit"
X=$S/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || setup "run dir exists"; mkdir -p $X; D=$X/cand
git clone -q --no-local --no-checkout $SRC $D && git -C $D -c advice.detachedHead=false checkout -q --detach $BASE || setup "clone"
git -C $D apply --check $S/windows-chain-authority-r2.patch && git -C $D apply $S/windows-chain-authority-r2.patch || setup "patch does not apply"
(cd $D && sha256sum -c --quiet $S/CANDIDATE.sha256) && ok "candidate files == CANDIDATE.sha256" || setup "candidate files differ"
cmp -s $SRC/package-lock.json $D/package-lock.json && [ -d $SRC/node_modules ] || setup "package-lock differs or no node_modules"
ln -s "$(readlink -f $SRC/node_modules)" $D/node_modules && ok "node_modules linked (absolute; package-lock identical; read-only use)"
(cd $D && node scripts/build-windows-lease-runtime.mjs --check && node scripts/build-metal-lease-gas.mjs --check && node scripts/build-host-admission.mjs --check) > $X/bundles.out 2>&1 \
  || { cat $X/bundles.out; setup "a committed bundle is stale at aebf4c932 (regenerate in the source, never here)"; }
grep -q "refusingChainAuthority" $D/windows/node/lease-gas-runtime.bundle.mjs && ok "rebuilt Windows bundle exports the chain authority" || setup "bundle lacks the authority exports"
sha256sum $D/windows/node/lease-gas-runtime.bundle.mjs* $D/metal/guest/lease-gas-conduit.bundle.mjs* > $X/bundles.sha256
node --version; (cd $D && for f in chain host host-identity network-enroll agent; do node --check windows/node/$f.mjs || exit 1; done) && ok "candidate syntax" || setup "candidate syntax"
rc=0
while read -r file side n; do
  out=$X/$(basename $file .test.mjs).tap
  (cd $D && timeout -k 10 600 node --test --test-reporter=tap --test-concurrency=1 $file) > $out 2>&1; nrc=$?
  python3 - "$out" "$n" "$nrc" <<'PY'; v=$?
import re, sys
out, n, nrc = open(sys.argv[1], errors='replace').read(), int(sys.argv[2]), int(sys.argv[3])
got = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', out, re.M)}
print(f"  {sys.argv[1].rsplit('/',1)[-1]}: node rc {nrc}, {got}")
if any(k not in got for k in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')): print("  INCOMPLETE: summary missing"); sys.exit(3)
if got['fail'] or nrc: print("  FAIL"); sys.exit(1)
if got['tests'] != n or got['pass'] != n or got['cancelled'] or got['skipped'] or got['todo']: print(f"  INCOMPLETE: expected exactly {n} passing"); sys.exit(3)
print("  PASS")
PY
  case $v in 0) ;; 3) [ $rc = 0 ] && rc=30 ;; *) rc=1 ;; esac
done < $S/EXPECTED-TAP.txt
case $rc in 0) echo "RESULT: PASS";; 30) echo "RESULT: INCOMPLETE (never a pass)";; *) echo "RESULT: FAIL";; esac
exit $rc
