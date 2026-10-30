#!/bin/bash
# Canonical local-rig e2e for the FINAL candidate source (PREPARED by Claude; NOT run). Local reth dev chain with a synthetic head:
# NOT mainnet, SNP or production proof. Root, from work/rpc-production-final-20261025 (the live candidate worktree is never used):
#   python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 4096 --log logs/root-canonical-final-inputs.guard -- \
#     unshare -rn env CANDIDATE_COMMIT=<full sha> bash jobs/root-canonical-final-inputs.sh > logs/root-canonical-final-inputs.out 2>&1; echo $? > logs/root-canonical-final-inputs.rc
# Inputs (existing, hash-pinned; nothing compiled except the candidate's own relay/build-network.mjs bundle step, as r12 B2 did):
#   helios     canonical-verifier-binary-stage/run/build-20261026T004633Z/out/helios 8250f08a (the ONLY helios the final source's
#              network/rpc-runtime.mjs PINNED_BUILDS accepts) -> HELIOS_BASE_BIN and RUNTIME_BIN_DIR/helios-eeffcc9
#   listener   9ca75047, witness-check 4fe0cd3b (both in PINNED_BUILDS) from resume-after-checkpoint-20261022/rpc-runtime-final-integration/bin-release
#   reth       2.8.0 8cdd1f35 (local rig engine) from .../rpc-runtime-final-integration/bin/reth-v2.8.0
#   genesis    the commit's own test/fixtures/reth-dev-8453-genesis.json cc045d9d
#   deps       root/network/relay node_modules closures from work/enclave, identity-checked against the commit's lockfiles AND r12 DEPS.txt
#   forge out  rig-artifact-closure-stage/r2 final tree (incl. MockFeed), only if the commit's contract closure is d8b3d312
# RUNTIME_BIN_DIR holds REGULAR-FILE copies: network/rpc-runtime.mjs:333-335 refuses any symlink in a binary path.
# Exit: 0 all 3 files pass (no skip/todo/cancel); 1 fail; 30 incomplete; 20 setup.
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
F=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-runtime-final-integration
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
CAND=$P/rpc-final-candidate-20261026/tree; R12=$P/rpc-runtime-composition-stage/r12
ART=$P/rig-artifact-closure-stage/r2/run/20261026T034813Z
HELIOS=$P/canonical-verifier-binary-stage/run/build-20261026T004633Z/out/helios
CLOSURE=d8b3d3125991c5596b42fdc2561c26dd5d40cd1f7978260456a7ccdd92969b89
TESTS="test/policy-verifier.e2e.test.mjs test/chain-consumer-closure.e2e.test.mjs test/windows-verifier.e2e.test.mjs"
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
pin() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || setup "$1 is not the pinned regular file $2"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route; loopback up)" || setup "network route present: run under unshare -rn"
[ "$(node --version)" = v22.23.3 ] || setup "node $(node --version) is not v22.23.3 (r12's runtime)"
C=${CANDIDATE_COMMIT:?set CANDIDATE_COMMIT to the finalized candidate commit}
G=$(git -C $CAND rev-parse --git-common-dir) && [ "$(git --git-dir=$G rev-parse --verify "$C^{commit}" 2>/dev/null)" = "$C" ] || setup "CANDIDATE_COMMIT $C is not a full commit id in $G"
(cd $R12 && sha256sum -c --quiet SHA256SUMS) || setup "r12 stage (DEPS.txt, deps-identity.py) changed"
pin $HELIOS 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378
pin $F/bin-release/enclave-base-head-listener 9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3
pin $F/bin-release/witness-check 4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411
pin $F/bin/reth-v2.8.0 8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250
OUT=$P/logs/root-canonical-final-inputs-$(date -u +%Y%m%dT%H%M%SZ); B=$OUT/runtime-bin; mkdir -p $OUT/repo $OUT/tmp $B || setup "out dir"
# ---- the exact commit, exported (no worktree, no change to the candidate repo) -----------------------------------------------
git --git-dir=$G archive "$C" | tar -x -C $OUT/repo || setup "export $C"
for h in 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378 9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3 4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411; do
  grep -q "'$h'" $OUT/repo/network/rpc-runtime.mjs || setup "the final source's PINNED_BUILDS does not accept $h"; done
ok "final source network/rpc-runtime.mjs PINNED_BUILDS accepts helios 8250f08a, listener 9ca75047, witness 4fe0cd3b"
pin $OUT/repo/test/fixtures/reth-dev-8453-genesis.json cc045d9d317d08dc6971e923b3939365acdfd58d5484c65afc1f5e450ee5b5af
# ---- private RUNTIME_BIN_DIR: regular files under the names the helper uses ------------------------------------------------
cp --reflink=auto $HELIOS $B/helios-eeffcc9 && cp --reflink=auto $F/bin-release/witness-check $B/witness-check && cp --reflink=auto $F/bin-release/enclave-base-head-listener $B/enclave-base-head-listener && chmod 0555 $B/* || setup "runtime bin dir"
pin $B/helios-eeffcc9 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378; pin $B/witness-check 4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411
pin $B/enclave-base-head-listener 9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3
(cd $B && sha256sum helios-eeffcc9 witness-check enclave-base-head-listener > $OUT/RUNTIME-BIN.sha256); ok "RUNTIME_BIN_DIR $B: helios-eeffcc9 8250f08a, witness-check 4fe0cd3b, listener 9ca75047"
# ---- dependency closures in-tree (r12 B rule) ----------------------------------------------------------------------------------
for d in . network relay; do src=$E/node_modules dst=$OUT/repo/node_modules; [ $d != . ] && src=$E/$d/node_modules dst=$OUT/repo/$d/node_modules
  [ ! -e $dst ] && cp -a --reflink=auto $src $dst || setup "copy $d/node_modules"
  o=$(python3 -I $R12/tools/deps-identity.py $G $C $d $dst) || setup "deps $d: $o"
  th=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['treehash'])" "$o"); grep -qx "$d $th" $R12/DEPS.txt || setup "$d closure $th is not r12 DEPS.txt"; done
[ -z "$(find $OUT/repo -type l -print | while read l; do case "$(realpath -m "$l")" in $OUT/repo/*) ;; *) echo "$l";; esac; done)" ] || setup "a symlink leaves the exported tree"
ok "root/network/relay closures == the commit's lockfiles and r12 DEPS.txt"
# ---- forge artifacts reused only for the identical contract closure --------------------------------------------------------
[ "$(git --git-dir=$G ls-tree -r --format='%(objectmode) %(objectname) 0%x09%(path)' "$C" -- foundry.toml contracts | sha256sum | cut -c1-64)" = $CLOSURE ] \
  || setup "contract closure of $C != ${CLOSURE:0:12}: the reused forge artifacts do not apply (rebuild needed; not done here)"
cmp -s <(cd $ART/trees/final/contracts/foundry && find out -type f | LC_ALL=C sort | xargs -r sha256sum) $ART/ARTIFACTS-after-final.sha256 || setup "reused forge out/ != its recorded manifest"
mkdir -p $OUT/repo/contracts/foundry && cp -a $ART/trees/final/contracts/foundry/out $ART/trees/final/contracts/foundry/cache $OUT/repo/contracts/foundry/ || setup "copy forge artifacts"
[ -s $OUT/repo/contracts/foundry/out/EnclaveDeployments.multicallValue.t.sol/MockFeed.json ] || setup "MockFeed artifact missing"
# ---- the ignored network runtime: the commit's own relay/build-network.mjs over the checked closures (as r12 B2) -------------
(cd $OUT/repo && timeout 600 node relay/build-network.mjs) > $OUT/network-runtime.out 2>&1 || setup "relay/build-network.mjs (see network-runtime.out)"
[ -s $OUT/repo/relay/network-runtime.bundle.mjs ] && [ -s $OUT/repo/relay/network-runtime.bundle.mjs.manifest.json ] || setup "network runtime bundle/manifest missing"
sha256sum $OUT/repo/relay/network-runtime.bundle.mjs $OUT/repo/relay/network-runtime.bundle.mjs.manifest.json | sed "s| $OUT/repo/| |" > $OUT/NETWORK-RUNTIME.sha256
command -v anvil >/dev/null && command -v openssl >/dev/null && [ -x /usr/bin/flock ] || setup "anvil/openssl/flock missing (the rigs would skip)"
ok "repo $C ready: genesis cc045d9d, forge closure ${CLOSURE:0:12}, network runtime $(cut -c1-12 $OUT/NETWORK-RUNTIME.sha256 | head -1)"
# The rig itself puts the reth datadir at fs.mkdtempSync(path.join("/tmp", "rig-reth-")) (test/helpers/cli-independent-rig.mjs:85): host /tmp, not TMPDIR.
export RIG_CHAIN_NODE=reth RIG_RETH_BIN=$F/bin/reth-v2.8.0 RIG_RETH_GENESIS=$OUT/repo/test/fixtures/reth-dev-8453-genesis.json RIG_RETH_BLOCK_TIME=2s \
  HELIOS_BASE_BIN=$HELIOS WITNESS_CHECK_BIN=$B/witness-check RUNTIME_BIN_DIR=$B TEST_TMP=$OUT/tmp TMPDIR=$OUT/tmp
rc=0
for t in $TESTS; do
  tap=$OUT/$(basename $t .test.mjs).tap
  (cd $OUT/repo && timeout -k 10 1800 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=900000 $t) < /dev/null > $tap 2>&1; nrc=$?
  python3 -I - $tap $nrc <<'PY'; v=$?
import re, sys
g = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', open(sys.argv[1], errors='replace').read(), re.M)}
print(f"  {sys.argv[1].rsplit('/', 1)[-1]}: rc {sys.argv[2]} {g}")
if len(g) < 6: sys.exit(3)
if g['fail'] or sys.argv[2] != '0': sys.exit(1)
sys.exit(3 if g['skipped'] or g['todo'] or g['cancelled'] or g['tests'] == 0 or g['pass'] != g['tests'] else 0)
PY
  case $v in 0) ;; 3) [ $rc = 0 ] && rc=30;; *) rc=1;; esac
done
ls -d /tmp/rig-reth-* 2>/dev/null | sed 's/^/  leftover rig datadir (rig cleanup did not remove it): /'
(cd $OUT && sha256sum *.tap RUNTIME-BIN.sha256 NETWORK-RUNTIME.sha256 network-runtime.out > RECEIPTS.sha256); echo "## outputs $OUT"
case $rc in 0) echo "RESULT: PASS (local reth rig, final source + canonical helios 8250f08a; NOT mainnet/SNP/production proof)";; 30) echo "RESULT: INCOMPLETE (skip/count; never a pass)";; *) echo "RESULT: FAIL";; esac
exit $rc
