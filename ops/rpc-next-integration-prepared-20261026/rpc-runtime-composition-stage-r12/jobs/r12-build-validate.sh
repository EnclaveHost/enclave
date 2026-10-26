#!/usr/bin/env bash
# r12 = r11 (FROZEN; jobs/r11-build-validate.sh, root-composition-r11-pre-0305 exit 9) on the SAME immutable candidate
#   2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 (r11's private src.git, read only; no new candidate, no product change). ONLY:
#   B2's artifact copy (r11 line 123 copied the first out/ entry AS the missing out/ - PaymentRouter.sol flattened - with find
#   -exec hiding cp's status and 2>/dev/null hiding errors) -> tools/copy-artifacts.py (out/ created BEFORE any copy, exact
#   reviewed manifest paths, every byte hash-checked, any deviation exits); the artifact manifests check their own status; the
#   raw build-info hashes of every forge build are RECORDED (BUILDINFO-<tree>.sha256; not compared: they hold build ids/paths -
#   the reuse rule still compares the contract artifacts, unchanged); the stack-test and receipt copies check their status.
#   Phase A also runs tools/test_copy_artifacts.py (exactly 12, no skip). Every r11 guard is otherwise unchanged.
# r11 = r10 (frozen) runner on the r11 candidate 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 (r10 + the reviewed composition-baseline-fixes-stage test patch
#   654b3f17) with: B2 test fixtures in EVERY tree (the ignored network runtime; the pinned OFFLINE forge subset of the rigs' art()
#   closure, two independent builds per contract closure compared EXCLUDING out/build-info (per-build bookkeeping ids), copies
#   verified), the baseline-fix test overlay on the component trees, shared EXACT test receipts (tree commit + test file sha256 +
#   setup hash: dependency closures, artifacts, network runtime) so E/E2 reuse one result instead of rerunning the same test on the same
#   tree, and --preflight (stops after A + B + B2, before the long suite).
# r10 text follows. r10 = r9 (frozen) runner on the r10 candidate 7371ee06766a4c297d68adbd77a40a7af33f605e (r9 + consumer credit 12b41d459 + the provider-authority fix) with the six
#   root-triage corrections (r9-root-build-triage.txt): bounded in-tree symlink resolution and runtimeFiles/sidecars source mapping in
#   the auditor (with its own fixture tests), the exact public-rpc/service-tls package paths, custody vendor REGENERATED twice
#   deterministically, exact checked git staging (no add warning, no dependency file), cancelled/expected-failure counts.
# r9 text follows. r9 = r7 (frozen) runner on the r9 candidate 82ec7d455cc6e9957c1500f6e58ffde557093392: one Windows chain authority (consumer e4f507d6b + owner CLI b6ac5d657, root
#   receipts 70d39eaa/3e4502a0) composed with route's verified per-block reads (R9-RESOLUTIONS.json). Adds the owner-CLI component
#   (aebf..b6ac: e4f 12 + owner 8 tests), a regression phase (REGRESSIONS.txt: every test touching the changed modules, each
#   against its baseline head), explicit INTENTIONAL-CHANGES markers, the recomputed dependency graph. All r7 gates kept.
# r7 text follows. r7 = r6 (frozen) on the r7 candidate c154f05c (parent c4de37a3: restores the route-unique lines the r2 route-first-base merge lost,
#   R7-RESOLUTIONS.json) + static bundle-entry link gates before and after regeneration + the Windows chain-reader regression test.
#   Private r7/src.git (objects via alternates to the frozen r3/src.git). Every r6 guard, pin, order, native input and no-skip rule kept.
# r6 text follows. r6 = r5 (frozen) + ONLY the generator dependency ORDER, computed by the static import-to-bundle graph tools/depgraph.py (DEPGRAPH.json):
#   host-admission -> network-runtime -> {host-service-packages, platform-api}; host-admission -> mcp; metal-lease-gas -> platform-api;
#   windows-lease-runtime and the vendors depend on no generated artifact. r5 ran network-runtime first (root-composition-r5-0202: the stale
#   Windows host-admission bundle lacked chainVerifierFromEnv/verifiedStateReader). Every r5 guard, pin, native input and no-skip rule kept.
# r5 text follows. r5 = r4 (frozen) + ONLY the generated-closure corrections found by closure-review (logs/root-composition-r4-0154: build-host-service-packages
#   could not resolve relay/network-runtime.bundle.mjs because the runner never ran relay/build-network.mjs; the Windows lease runtime,
#   stale for 4 composed inputs, and the site/relay vendor bundles were omitted; "nothing else touched" was a suffix filter, not an
#   exact list; native chain-verifier overlay tests skipped). No product, test or guard change.
# r4 text follows. r4: SAME candidate as r3 (refs/r3/candidate c4de37a3, private r3/src.git, read-only) with corrected build provenance:
#   * every private checkout gets the checked dependency closures (root, network/, relay/ node_modules) COPIED INSIDE it
#     (cp -a --reflink=auto; ext4 here = real copy, ~246 MB/tree), identity-checked against each tree's lockfiles before and
#     after; no out-of-tree dependency input, lockedInputs and symlink handling untouched;
#   * build-attested-guest-verify gets its REQUIRED argv: two independent `git archive` exports of the pinned image commit
#     0235e7d9659f1ccbf9f258bd03593d26f32f3f3a (outside the checkouts), check-only (the bundle is pinned to that commit);
#   * root's r3 inventory fix kept: exact SHAs resolved in src.git, nonempty per-component inventory, iterated from file.
# ROOT-LAUNCHED, FOREGROUND, offline, from work/rpc-production-final-20261025 (shared queue, 2560):
#   ./jobs/q-exit-status.sh rpc-runtime-composition-r4-N 2560 unshare -rn bash rpc-runtime-composition-stage/r4/jobs/r4-build-validate.sh [--precheck-only]
# --precheck-only: phase A only (reads and hashes; no clone, copy, build or test). Result: PASS | INCOMPLETE | FAIL (never inflated).
set -uo pipefail
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/rpc-runtime-composition-stage; R3=$S/r3; R4=$S/r12; G=$S/r11/src.git
CVI=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs   # root 0104 native inputs (read only)
E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave          # the checked dependency closures (read only)
IMG=0235e7d9659f1ccbf9f258bd03593d26f32f3f3a; DEPDIRS=". network relay"
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: FAIL (precheck)"; exit 9; fi; }
sha() { git --git-dir=$G rev-parse --verify -q "$1^{commit}"; }
echo "== A. static precheck (nothing cloned, copied, built or tested)"
ip link set lo up 2>/dev/null || true
need "offline namespace (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "user namespace root (unshare -r)" [ "$(id -u)" = 0 ]
need "r12 files == SHA256SUMS" bash -c "cd $R4 && sha256sum -c --quiet SHA256SUMS"
need "r11 stage files unchanged (frozen; its src.git is read only here)" bash -c "cd $S/r11 && sha256sum -c --quiet SHA256SUMS"
need "r3 frozen inputs == R3-PINS.sha256" bash -c "cd $R3 && sha256sum -c --quiet $R4/R3-PINS.sha256"
need "r4 stage unchanged (frozen)" bash -c "cd $S/r4 && sha256sum -c --quiet SHA256SUMS"
need "r5 stage unchanged (frozen; its runner is the base of this one)" bash -c "cd $S/r5 && sha256sum -c --quiet SHA256SUMS"
need "r3 private refs == r3/REFS.txt (frozen)" bash -c "diff <(git --git-dir=$R3/src.git for-each-ref --format='%(objectname) %(refname)') $R3/REFS.txt"
need "r11 private refs == r11/REFS.txt" bash -c "diff <(git --git-dir=$G for-each-ref --format='%(objectname) %(refname)') $R4/REFS.txt"
need "r6 stage unchanged (frozen)" bash -c "cd $S/r6 && sha256sum -c --quiet SHA256SUMS"
need "r7 stage unchanged (frozen; its runner is the base of this one)" bash -c "cd $S/r7 && sha256sum -c --quiet SHA256SUMS"
need "r8 stage unchanged (frozen)" bash -c "cd $S/r8 && sha256sum -c --quiet SHA256SUMS"
need "r9 stage files unchanged (frozen; its run dir is not read)" bash -c "cd $S/r9 && sha256sum -c --quiet SHA256SUMS"
need "r10 stage files unchanged (frozen)" bash -c "cd $S/r10 && sha256sum -c --quiet SHA256SUMS"
need "baseline-fix stage pinned (its patch is the candidate's test change)" bash -c "cd $S/../composition-baseline-fixes-stage && sha256sum -c --quiet $R4/BASELINE-FIX-PINS.sha256 && sha256sum -c --quiet SHA256SUMS && cmp patches/native-relay-remote-verifier-refusal.patch $R4/tools/native-relay-remote-verifier-refusal.patch"
need "credit root receipts are the pinned passes (0228/0230/0232)" bash -c "cd $S/../logs && sha256sum -c --quiet $R4/CREDIT-RECEIPTS.sha256"
need "auditor fixture tests (symlinks bounded in-tree, runtimeFiles/sidecars by source)" python3 -I $R4/tools/test_manifest_staleness.py
need "artifact-copy regression (r11 line-123 shape reproduced; exact helper shape; exactly 12, no skip)" bash -c "o=\$(python3 -I -B $R4/tools/test_copy_artifacts.py -v 2>&1); r=\$?; echo \"\$o\" | grep -qx 'Ran 12 tests in [0-9.]*s' && [ \"\$(echo \"\$o\" | tail -1)\" = OK ] && ! echo \"\$o\" | grep -q '\.\.\. skipped' && [ \$r = 0 ]"
declare -A REF=([consumers]=refs/src/consumers [leaseRelay]=refs/src/leaseRelay [verifier]=refs/src/verifier [route]=refs/src/route [seam]=refs/src/consumers-seam [ownercli]=refs/src/consumers-ownercli [final]=refs/r11/candidate)
declare -A BASE=([consumers]=9fa02e1bc6 [leaseRelay]=9fa02e1bc6 [verifier]=9fa02e1bc6 [route]=9a4880464 [seam]=81ba66853 [ownercli]=aebf4c932)
declare -A SHA; for k in "${!REF[@]}"; do SHA[$k]=$(sha ${REF[$k]}) || { echo "[FAIL] ref $k"; echo "RESULT: FAIL (precheck)"; exit 9; }; done
need "candidate is r11 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 (parent r10 7371ee06; exactly the native-relay test patch)" bash -c "[ ${SHA[final]} = 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 ] && [ \"\$(git --git-dir=$G log -1 --format=%P ${SHA[final]})\" = 7371ee06766a4c297d68adbd77a40a7af33f605e ] && [ \"\$(git --git-dir=$G diff --name-only 7371ee06766a4c297d68adbd77a40a7af33f605e ${SHA[final]})\" = test/native-relay-chain-authority.test.mjs ]"
need "r10 parent message pins R10-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]}^ | grep -qx \"R10-Resolutions-Sha256: \$(sha256sum < $S/r10/R10-RESOLUTIONS.json | cut -c1-64)\""
need "r11 message pins the applied patch" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \"Applied-Patch-Sha256: \$(sha256sum < $R4/tools/native-relay-remote-verifier-refusal.patch | cut -c1-64)\""
need "both consumer root receipts are the pinned passes" bash -c "cd $S/../logs && echo '70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48  windows-authority-e4f507d6b-root-receipt.out
3e4502a098fb8c9942dd95695b57dfca0a26c9a1e123b48e6167615119448d40  windows-owner-cli-b6ac5d657-root-receipt.out' | sha256sum -c --quiet"
need "every regression test exists in the candidate" bash -c "while read t; do git --git-dir=$G cat-file -e ${SHA[final]}:\$t || exit 1; done < $R4/REGRESSIONS.txt"
need "static: every bundle importer names only exports of the bundle's SOURCE entry" python3 -I $R4/tools/bundle-entry-links.py $G ${SHA[final]}
need "pinned image commit $IMG present" [ "$(sha $IMG)" = $IMG ]
need "generator scripts are the pinned blobs" bash -c "while read b f; do [ \"\$(git --git-dir=$G rev-parse ${SHA[final]}:\$f)\" = \$b ] || exit 1; done < $R4/GENERATORS.txt"
need "build-attested-guest-verify argv contract: <image tree> <image commit> [--check]" bash -c "git --git-dir=$G show ${SHA[final]}:scripts/build-attested-guest-verify.mjs | grep -qF 'usage: build-attested-guest-verify.mjs <image tree> <image commit> [--check]'"
need "both guest-verify manifests pin image commit $IMG" bash -c "for m in network/attested-guest-verify.bundle.mjs.manifest.json test/fixtures/attested-guest-image.bundle.mjs.manifest.json; do git --git-dir=$G show ${SHA[final]}:\$m | grep -q '\"imageCommit\": \"$IMG\"' || exit 1; done"
need "node v22.23.3" [ "$(node --version)" = v22.23.3 ]
need "anvil present (attested-route-composition needs it; a skip is never clean)" command -v anvil
need "esbuild 0.28.1 in the closure" [ "$(python3 -c "import json;print(json.load(open('$E/node_modules/esbuild/package.json'))['version'])")" = 0.28.1 ]
declare -A TH
for k in "${!REF[@]}"; do for d in $DEPDIRS; do nm=$E/node_modules; [ $d != . ] && nm=$E/$d/node_modules
  o=$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$k]} $d $nm) || { echo "[FAIL] deps $k $d: $o"; echo "RESULT: FAIL (precheck)"; exit 9; }
  th=$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['treehash'])" "$o"); [ -z "${TH[$d]:-}" ] || [ "${TH[$d]}" = "$th" ] || { echo "[FAIL] closure $d changed during precheck"; exit 9; }; TH[$d]=$th
done; done; echo "[ok] dependency closures match every tree's lockfiles: root ${TH[.]:0:12} network ${TH[network]:0:12} relay ${TH[relay]:0:12}"
need "closures equal the recorded identities (DEPS.txt)" bash -c "[ \"$(printf '%s %s\n' . ${TH[.]} network ${TH[network]} relay ${TH[relay]})\" = \"\$(cat $R4/DEPS.txt)\" ]"
X=$R4/run/r4-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/logs $X/tmp $X/trees; export TEST_TMP=$X/tmp TMPDIR=$X/tmp
for k in consumers leaseRelay verifier route seam ownercli; do
  git --git-dir=$G diff --name-only --diff-filter=AM ${BASE[$k]} ${SHA[$k]} -- 'test/*.test.mjs' 'test/*.test.py' > $X/$k-tests.all || { echo "RESULT: FAIL (inventory $k)"; exit 9; }
  grep -v e2e $X/$k-tests.all > $X/$k-tests.txt || true; [ -s $X/$k-tests.txt ] || { echo "[FAIL] empty inventory $k"; echo "RESULT: FAIL (precheck)"; exit 9; }
  while IFS= read -r t; do git --git-dir=$G cat-file -e ${SHA[$k]}:$t || { echo "[FAIL] $k inventory names a missing $t"; exit 9; }; done < $X/$k-tests.txt
  echo "[ok] inventory $k: $(wc -l < $X/$k-tests.txt) tests"; done
NATIVE="test/metal-control-overlay.test.py"
STACK="test/stack-windows-chain-reader.test.mjs test/stack-provider-authority.test.mjs test/stack-chain-authority-boundary.test.mjs test/stack-custody-v2-refused.test.mjs test/stack-admin-controls.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs test/lease-pinned-relay-config.test.mjs test/metal-measured-control.test.mjs"
for t in $STACK; do [ -e $R4/stack-tests/$(basename $t) ] || git --git-dir=$G cat-file -e ${SHA[final]}:$t || { echo "[FAIL] stack test $t missing"; exit 9; }; done; echo "[ok] stack inventory: $(echo $STACK | wc -w) tests present"
need "native chain-verifier inputs: PINS verify and equal the candidate image record (no skipped native test)" bash -c "cd $CVI && sha256sum -c --quiet PINS.sha256 && git --git-dir=$G show ${SHA[final]}:metal/chain-verifier-image.json | python3 -I -c \"import json,sys,hashlib,os;j=json.load(sys.stdin);d='$CVI';h=lambda f:hashlib.sha256(open(os.path.join(d,f),'rb').read()).hexdigest();assert all(h(os.path.basename(b['path']))==b['sha256'] for b in j['binaries'].values()) and all(h(n)==x for n,x in j['glibcRuntime']['files'].items())\""
need "disk: >= 4 GiB free for 6 trees + closures" [ "$(df -Pk $R4 | awk 'NR==2{print $4}')" -ge 4194304 ]
if [ "${1:-}" = --precheck-only ]; then rm -rf $X; echo "## precheck rc=0 (nothing cloned, copied, built or tested)"; exit 0; fi
echo "== B. exact checkouts with the dependency closures INSIDE each"
for t in consumers leaseRelay verifier route seam ownercli final; do T=$X/trees/$t
  git clone -q --shared --no-checkout $G $T 2>/dev/null && git -C $T -c advice.detachedHead=false checkout -q --detach ${SHA[$t]} || { echo "RESULT: FAIL (checkout $t)"; exit 9; }
  for d in $DEPDIRS; do src=$E/node_modules dst=$T/node_modules; [ $d != . ] && src=$E/$d/node_modules dst=$T/$d/node_modules
    [ ! -e $dst ] || { echo "[FAIL] $t: $d/node_modules already in the tree"; exit 9; }; cp -a --reflink=auto $src $dst || { echo "RESULT: FAIL (copy)"; exit 9; }
    o=$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$t]} $d $dst) && [ "$(python3 -c "import json,sys;print(json.loads(sys.argv[1])['treehash'])" "$o")" = "${TH[$d]}" ] || { echo "[FAIL] $t $d copy identity"; exit 9; }
  done
  [ -z "$(find $T -path $T/.git -prune -o -type l -print | while read l; do case "$(realpath -m "$l")" in $T/*) ;; *) echo "$l";; esac; done)" ] || { echo "[FAIL] $t has a symlink leaving the tree"; exit 9; }
  echo "[ok] $t ${SHA[$t]:0:12} + closures in-tree"; done
F=$X/trees/final
echo "== B2. test fixtures in EVERY tree: the ignored network runtime + the pinned OFFLINE forge subset (CONTRACT-ARTIFACTS.txt)"
FORGE=/home/steven/.foundry/bin/forge SOLC=/home/steven/.local/share/svm/0.8.35/solc-0.8.35
[ "$(sha256sum < $FORGE | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && $FORGE --version | grep -q 4072e48705af9d93e3c0f6e29e93b5e9a40caed8 || { echo "[FAIL] forge is not the pinned 1.7.1"; exit 9; }
[ "$(sha256sum < $SOLC | cut -c1-64)" = fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4 ] && $SOLC --version | grep -q '0.8.35+commit.47b9dedd' || { echo "[FAIL] solc is not the pinned 0.8.35"; exit 9; }
command -v anvil >/dev/null && command -v openssl >/dev/null || { echo "[FAIL] anvil/openssl missing: the rigs would skip"; exit 9; }
SOURCES=$(sed -n 's/^source //p' $R4/CONTRACT-ARTIFACTS.txt); ARTS=$(sed -n 's/^artifact //p' $R4/CONTRACT-ARTIFACTS.txt)
declare -A CLS FIRST NB SETUP
amanifest() { (cd $X/trees/$1/contracts/foundry && find out -type f -name '*.json' -not -path 'out/build-info/*' | LC_ALL=C sort | xargs -r sha256sum) > $X/ARTIFACTS-$1.sha256 && [ -s $X/ARTIFACTS-$1.sha256 ] || { echo "[FAIL] manifest $1: artifact hashing failed or empty"; exit 9; }; }
binfo() { (cd $X/trees/$1/contracts/foundry && find out/build-info -type f -name '*.json' | LC_ALL=C sort | xargs -r sha256sum) > $X/BUILDINFO-$1.sha256 && [ -s $X/BUILDINFO-$1.sha256 ] || { echo "[FAIL] manifest $1: raw build-info hashing failed or empty"; exit 9; }; }   # recorded, not compared
build_tree() { local T=$X/trees/$1 src; for src in $SOURCES; do [ -e $T/$src ] || { echo "[note] $1 has no $src (older head)"; continue; }
    (cd $T && FOUNDRY_OFFLINE=true timeout -k 10 1200 $FORGE build --offline -j 1 --use $SOLC "$src") > $X/logs/forge-$1-$(basename $src .sol).log 2>&1 || { echo "[FAIL] forge build $src ($1)"; return 1; }; done; amanifest $1; binfo $1; }
for t in consumers leaseRelay verifier route seam ownercli final; do T=$X/trees/$t
  grep -qx 'solc = "0.8.35"' $T/foundry.toml && git -C $T diff --quiet -- foundry.toml contracts && [ -z "$(git -C $T ls-files --others --exclude-standard -- contracts foundry.toml)" ] || { echo "[FAIL] $t: contract inputs modified or solc not pinned"; exit 9; }
  CLS[$t]=$(git -C $T ls-files -s -- foundry.toml contracts | sha256sum | cut -c1-64); c=${CLS[$t]}
  if [ -z "${FIRST[$c]:-}" ]; then build_tree $t || exit 9; FIRST[$c]=$t; NB[$c]=1
  elif [ "${NB[$c]}" = 1 ]; then build_tree $t || exit 9; NB[$c]=2
    cmp -s $X/ARTIFACTS-$t.sha256 $X/ARTIFACTS-${FIRST[$c]}.sha256 || { echo "[FAIL] two independent forge builds of closure ${c:0:12} differ in contract artifacts"; exit 9; }
  else python3 -I -B $R4/tools/copy-artifacts.py $X/trees/${FIRST[$c]}/contracts/foundry $T/contracts/foundry $X/ARTIFACTS-${FIRST[$c]}.sha256 > $X/logs/copy-artifacts-$t.out 2>&1 \
      || { echo "[FAIL] $t: artifact copy refused: $(tail -1 $X/logs/copy-artifacts-$t.out)"; exit 9; }
    echo "$t copied from ${FIRST[$c]} (no build-info: reuse excludes bookkeeping; ${FIRST[$c]}'s raw build-info is BUILDINFO-${FIRST[$c]}.sha256)" >> $X/ARTIFACT-REUSE.txt
    amanifest $t; cmp -s $X/ARTIFACTS-$t.sha256 $X/ARTIFACTS-${FIRST[$c]}.sha256 || { echo "[FAIL] $t: copied artifacts differ from closure ${c:0:12}"; exit 9; }; fi
  for a in $ARTS; do src=$(sed -n "s|^source \(.*/${a%%/*}\)$|\1|p" $R4/CONTRACT-ARTIFACTS.txt); [ -e $T/$src ] || continue
    python3 -I -c "import json,sys; b=json.load(open(sys.argv[1]))['bytecode']['object']; assert b.startswith('0x') and len(b)>2" $T/contracts/foundry/out/$a || { echo "[FAIL] $t: artifact $a missing or without bytecode"; exit 9; }; done
  NR=none; if [ $t != final ] && [ -e $T/relay/build-network.mjs ]; then (cd $T && timeout 600 node relay/build-network.mjs) > $X/logs/network-runtime-$t.out 2>&1 || { echo "[FAIL] $t: relay/build-network.mjs"; exit 9; }; NR=$(sha256sum < $T/relay/network-runtime.bundle.mjs | cut -c1-64); fi
  SETUP[$t]=$(printf '%s %s %s %s %s' "${TH[.]}" "${TH[network]}" "${TH[relay]}" "$(sha256sum < $X/ARTIFACTS-$t.sha256 | cut -c1-64)" "$NR" | sha256sum | cut -c1-64)
  echo "[ok] $t: closure ${c:0:12}, $(wc -l < $X/ARTIFACTS-$t.sha256) contract artifacts (build ${FIRST[$c]}), network runtime ${NR:0:12}"
done
echo "== B3. the reviewed baseline-fix TEST overlay on component trees whose test is the patch's exact pre-image (product untouched)"
for t in consumers leaseRelay verifier route seam ownercli; do (cd $X/trees/$t && git apply --check $R4/tools/native-relay-remote-verifier-refusal.patch 2>/dev/null && git apply $R4/tools/native-relay-remote-verifier-refusal.patch && echo "$t" >> $X/OVERLAYS.txt && echo "[ok] $t: native-relay test overlay applied (test-only)"); done
mkdir -p $X/receipts
if [ "${1:-}" = --preflight ]; then echo "## preflight rc=0 (A + B + B2 + B3 done; no generator, no test run)"; exit 0; fi
echo "== C. the pinned image tree, twice (independent git-archive exports, outside the checkouts)"
for i in a b; do mkdir $X/image-$i && git --git-dir=$G archive $IMG | tar -x -C $X/image-$i || { echo "RESULT: FAIL (image export)"; exit 9; }; done
echo "== D. generated bundles in dependency order"
SEQ="build-host-admission build-windows-lease-runtime build-metal-lease-gas network-runtime build-host-service-packages build-mcp-guest-bundle build-custody-vendor build-platform-api-guest-bundle"   # the executed order
GENS=$(echo $SEQ | tr " " "\n" | grep -vx network-runtime | tr "\n" " ")
# the executed order must satisfy EVERY edge of the static graph recomputed now from the candidate (not a guess)
python3 -I $R4/tools/depgraph.py $G ${SHA[final]} > $X/depgraph.json; dg=$?; [ $dg = 0 ] || { echo "[FAIL] dependency graph (cycle or error, rc $dg)"; echo "RESULT: FAIL (precheck)"; exit 9; }
cmp -s <(python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('staticEdges','manifestEdges','unresolved','cycle')},sort_keys=True))" $X/depgraph.json) <(python3 -I -c "import json,sys;d=json.load(open(sys.argv[1]));print(json.dumps({k:d[k] for k in ('staticEdges','manifestEdges','unresolved','cycle')},sort_keys=True))" $R4/DEPGRAPH.json) || { echo "[FAIL] the dependency graph differs from the reviewed DEPGRAPH.json"; echo "RESULT: FAIL (precheck)"; exit 9; }
python3 -I - $X/depgraph.json "$SEQ" <<'PY' || { echo "RESULT: FAIL (precheck: order)"; exit 9; }
import json, re, sys
d = json.load(open(sys.argv[1])); seq = sys.argv[2].split()
name = {"host-admission": "build-host-admission", "network-runtime": "network-runtime", "windows-lease-runtime": "build-windows-lease-runtime", "metal-lease-gas": "build-metal-lease-gas",
        "host-service-packages": "build-host-service-packages", "mcp-guest": "build-mcp-guest-bundle", "platform-api-guest": "build-platform-api-guest-bundle"}
bad = []
for e in d["staticEdges"] + d["manifestEdges"]:
    a, b = re.match(r"(\S+) -> (\S+)", e).groups()
    if a in name and b in name and seq.index(name[a]) >= seq.index(name[b]): bad.append(e)
    if (a in name) != (b in name): bad.append("edge to a check-only/unknown generator: " + e)
for e in bad: print("[FAIL] executed order violates", e)
print(f"[{'ok' if not bad else 'FAIL'}] executed order satisfies all {len(d['staticEdges'])} static + {len(d['manifestEdges'])} manifest edges; no cycle"); sys.exit(1 if bad else 0)
PY
VENDOR="build-host-policy-vendor build-management-vendor build-aa-vendor build-credit-vault-vendor build-host-capacity-vendor"   # check-only; custody is REGENERATED in SEQ (its sources are composed) (sources outside the composition)
netrt() { (cd $F && timeout 600 node relay/build-network.mjs) > $X/logs/network-runtime-$1.out 2>&1 || { echo "[FAIL] relay/build-network.mjs ($1)"; echo "RESULT: FAIL (bundle)"; exit 1; }; }
for g in $GENS; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-precheck-$g.out 2>&1; echo "[pre] $g --check rc $? (stale before regeneration is expected)"; done
fail=0; incomplete=0
for i in a b; do (cd $F && timeout 600 node scripts/build-attested-guest-verify.mjs $X/image-$i $IMG --check) > $X/logs/guest-verify-check-$i.out 2>&1 || { echo "[FAIL] pinned guest-verify bundles do not reproduce from image export $i"; fail=1; }; done
stage_exact() { # stage EXACTLY the regenerated paths (each in GENERATED.txt); refuse an add warning, an extra staged path or a dependency file
  local list extra; list=$(git -C $F status --porcelain=v1 -z --untracked-files=all -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules' | tr '\0' '\n' | sed -n 's/^...//p' | LC_ALL=C sort -u)
  [ -n "$list" ] || { echo "[FAIL] nothing regenerated ($1)"; return 1; }
  extra=$(grep -vxF -f <(grep -v '^#' $R4/GENERATED.txt) <<<"$list" || true); [ -z "$extra" ] || { echo "[FAIL] non-generated path would be staged ($1): $(echo $extra | head -c 300)"; return 1; }
  printf '%s\n' "$list" | git -C $F add --pathspec-from-file=- 2> $X/logs/git-add-$1.err || { echo "[FAIL] git add ($1)"; return 1; }
  [ ! -s $X/logs/git-add-$1.err ] || { echo "[FAIL] git add warned ($1): $(head -c 300 $X/logs/git-add-$1.err)"; return 1; }
  [ "$(git -C $F diff --cached --name-only | LC_ALL=C sort -u)" = "$list" ] || { echo "[FAIL] staged set != regenerated set ($1)"; return 1; }
  ! git -C $F diff --cached --name-only | grep -q 'node_modules/' || { echo "[FAIL] a dependency file was staged ($1)"; return 1; }
}
for pass in 1 2; do for g in $SEQ; do [ $g = network-runtime ] && { netrt $pass; continue; }; (cd $F && timeout 900 node scripts/$g.mjs) > $X/logs/gen-$pass-$g.out 2>&1 || { echo "[FAIL] regenerate $g (pass $pass): $(grep -m1 Error $X/logs/gen-$pass-$g.out)"; echo "RESULT: FAIL (bundle)"; exit 1; }; done
  stage_exact pass$pass || fail=1; git -C $F diff --cached --binary > $X/gen-pass-$pass.diff; git -C $F reset -q
  sha256sum $F/relay/network-runtime.bundle.mjs $F/relay/network-runtime.bundle.mjs.manifest.json | cut -c1-64 > $X/gen-pass-$pass.ignored.sha256; done
cmp -s $X/gen-pass-1.diff $X/gen-pass-2.diff && cmp -s $X/gen-pass-1.ignored.sha256 $X/gen-pass-2.ignored.sha256 || { echo "[FAIL] regeneration is not deterministic"; fail=1; }
for g in $GENS; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/gen-postcheck-$g.out 2>&1 || { echo "[FAIL] $g --check after regeneration"; fail=1; }; done
for i in a b; do (cd $F && timeout 600 node scripts/build-attested-guest-verify.mjs $X/image-$i $IMG --check) > $X/logs/guest-verify-postcheck-$i.out 2>&1 || { echo "[FAIL] guest-verify check after regeneration ($i)"; fail=1; }; done
for g in $VENDOR; do (cd $F && timeout 600 node scripts/$g.mjs --check) > $X/logs/vendor-check-$g.out 2>&1 || { echo "[FAIL] check-only $g is stale in the candidate (its sources are outside the composition: root decision)"; fail=1; }; done
cmp -s $F/relay/vendor/enclave-verifier-node.mjs $F/verifier/dist/enclave-verifier-node.mjs || { echo "[FAIL] relay/vendor/enclave-verifier-node.mjs is not its copiedFrom verifier/dist file"; fail=1; }
bad=$(git -C $F status --porcelain=v1 --untracked-files=all --ignored -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules' | sed 's/^...//' | grep -vxF -f <(grep -v '^#' $R4/GENERATED.txt; printf '%s\n' relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json contracts/foundry/out/ contracts/foundry/cache/) || true)
[ -z "$bad" ] || { echo "[FAIL] regeneration touched non-generated files: $bad"; fail=1; }
miss=$(grep -v '^#' $R4/GENERATED.txt | while read -r p; do [ -e $F/$p ] || echo $p; done); [ -z "$miss" ] || { echo "[FAIL] a listed generated path was not produced: $miss"; fail=1; }
pk=$(cd $F/network/host-services/packages && ls | sed 's|^|network/host-services/packages/|' | LC_ALL=C sort); [ "$pk" = "$(grep '^network/host-services/packages/' $R4/GENERATED.txt | LC_ALL=C sort)" ] || { echo "[FAIL] the generator's package set != the exact GENERATED package entries"; fail=1; }
stage_exact final || { echo "RESULT: FAIL (staging)"; exit 1; }
GIT_AUTHOR_NAME=SteveDeFacto GIT_COMMITTER_NAME=SteveDeFacto GIT_AUTHOR_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_COMMITTER_EMAIL=5148995+SteveDeFacto@users.noreply.github.com GIT_AUTHOR_DATE=2026-10-26T00:00:00Z GIT_COMMITTER_DATE=2026-10-26T00:00:00Z \
  git -C $F -c commit.gpgsign=false -c core.hooksPath=/dev/null commit -q --allow-empty -m "compose: regenerate generated bundles from the composed sources (r4 job, private)

Regenerated-From: ${SHA[final]} (r10 job)
Generators: $GENS; build-attested-guest-verify check-only against git-archive exports of $IMG
Dependency-Closures: root ${TH[.]} network ${TH[network]} relay ${TH[relay]}" || { echo "RESULT: FAIL (regen commit)"; exit 1; }
FINAL=$(git -C $F rev-parse HEAD)
SETUP[final]=$(printf '%s %s %s %s %s' "${TH[.]}" "${TH[network]}" "${TH[relay]}" "$(sha256sum < $X/ARTIFACTS-final.sha256 | cut -c1-64)" "$(cut -c1-64 $X/gen-pass-2.ignored.sha256 | tr '\n' ' ')" | sha256sum | cut -c1-64)
python3 -I $R4/tools/link-check.py $F/.git HEAD > $X/link-after.json || true
python3 -I - $X/link-after.json $R4/LINK-BASELINE.json <<'PY' || fail=1
import json, sys
key = lambda x: (x["importer"], x["target"], tuple(x["missing"]))
base = {key(x) for x in json.load(open(sys.argv[2]))}; new = [x for x in json.load(open(sys.argv[1])) if key(x) not in base]
for x in new: print("[FAIL] regenerated tree: import not satisfied:", x)
print(f"[{'ok' if not new else 'FAIL'}] regenerated tree: no import/export link beyond the heads' baseline"); sys.exit(1 if new else 0)
PY
echo "[ok] regenerated candidate $FINAL ($(git -C $F diff --stat ${SHA[final]} HEAD | tail -1))"
git -C $F diff --name-only ${SHA[final]} HEAD > $X/regenerated.paths
python3 -I $R4/tools/manifest-staleness.py $F/.git HEAD > $X/staleness-after.json
python3 -I - $X/staleness-after.json <<'PY' || fail=1
import json, sys
r = json.load(open(sys.argv[1])); bad = []
for m, v in r.items():
    e = v["HEAD"]
    if m.endswith(("attested-guest-verify.bundle.mjs.manifest.json", "attested-guest-image.bundle.mjs.manifest.json")): continue   # inputs are the IMAGE commit's (checked against both exports)
    absent = [a for a in e["absent"] if not a.startswith("node_modules/") and "/node_modules/" not in a and a not in ("relay/network-runtime.bundle.mjs",)]
    if e["stale"] or absent: bad.append((m, e["stale"][:5], absent[:5]))
for b in bad: print("[FAIL] manifest still stale after regeneration:", b)
print(f"[{'ok' if not bad else 'FAIL'}] every committed generated-artifact manifest ({len(r)}) pins the current tree"); sys.exit(1 if bad else 0)
PY
cp $R4/stack-tests/*.mjs $F/test/ || { echo "[FAIL] stack tests copy"; echo "RESULT: FAIL (setup)"; exit 9; }
summ() { python3 -I - "$1" <<'PY'
import re, sys
s = open(sys.argv[1], errors="replace").read(); g = lambda k: sum(int(x) for x in re.findall(rf"^# {k} (\d+)$", s, re.M))
if re.search(r"^Ran \d+ tests?", s, re.M):
    n = int(re.search(r"^Ran (\d+) tests?", s, re.M).group(1)); sk = sum(int(x) for x in re.findall(r"skipped=(\d+)", s)); ok = bool(re.search(r"^OK", s, re.M))
    xf = sum(int(x) for x in re.findall(r"expected failures=(\d+)", s)); us = sum(int(x) for x in re.findall(r"unexpected successes=(\d+)", s))
    print(f"pass={n if ok else 0} fail={(0 if ok else 1) + xf + us} skip={sk} todo=0 cancelled=0")
else:
    summary = all(re.search(rf"^# {k} \d+$", s, re.M) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo"))
    print(f"pass={g('pass') if summary else 0} fail={g('fail') if summary else 1} skip={g('skipped')} todo={g('todo')} cancelled={g('cancelled') if summary else 1}")
PY
}
run1() { local tree=$1 test=$2 log=$X/logs/$3.out key tb rc
  # the EXACT receipt: tree commit + test path + test file sha256 (overlays and stack copies included) + setup hash. The same key
  # (E and E2 on the same tree and file) reuses one result; a different tree NEVER shares (a baseline is never borrowed).
  tb=$(sha256sum < $X/trees/$tree/$test 2>/dev/null | cut -c1-64); [ -n "$tb" ] || { echo "1 pass=0 fail=1 skip=0 todo=0 cancelled=1"; return; }
  key=$(printf '%s %s %s %s %s' "$(git -C $X/trees/$tree rev-parse HEAD)" "$test" "$tb" "${SETUP[$tree]:?no setup hash for $tree}" "$(cat $X/OVERLAYS.txt 2>/dev/null | tr '\n' ,)" | sha256sum | cut -c1-64)
  if [ -s $X/receipts/$key.rc ]; then cp $X/receipts/$key.out $log || { echo "1 pass=0 fail=1 skip=0 todo=0 cancelled=1"; return; }; echo "$tree $test $key" >> $X/receipts/REUSED.tsv; echo "$(cat $X/receipts/$key.rc) $(summ $log)"; return; fi
  case $test in *.py) (cd $X/trees/$tree && timeout -k 10 600 python3 "$test" -v) > $log 2>&1;; *) (cd $X/trees/$tree && timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 "$test") > $log 2>&1;; esac
  rc=$?; cp $log $X/receipts/$key.out || { echo "1 pass=0 fail=1 skip=0 todo=0 cancelled=1"; return; }; echo $rc > $X/receipts/$key.rc
  printf '%s\t%s\t%s\t%s\t%s\n' $key $tree $test $tb $(sha256sum < $log | cut -c1-64) >> $X/receipts/RECEIPTS.tsv; echo "$rc $(summ $log)"; }
clean() { case "$1" in "0 pass=0 "*) return 1;; "0 "*"fail=0 skip=0 todo=0 cancelled=0") return 0;; *) return 1;; esac; }
echo "== E. component tests (component tree vs regenerated candidate)"; : > $X/RESULTS.tsv
for k in consumers leaseRelay verifier route seam ownercli; do while IFS= read -r t; do
  a=$(run1 $k $t "$k--$(echo $t | tr / _)"); if [ -e $F/$t ]; then b=$(run1 final $t "final--$k--$(echo $t | tr / _)"); else b=MISSING; fi
  if clean "$a"; then if clean "$b"; then v=ok; else v=REGRESSION; fail=1; fi; else v=BASELINE-NOT-CLEAN; incomplete=1; fi
  grep -qxF "$t" $R4/INTENTIONAL-CHANGES.txt && ! cmp -s $X/trees/$k/$t $F/$t && v="$v (ADAPTED in the candidate: intentional API change, INTENTIONAL-CHANGES.txt; both versions must pass)"
  printf '%s\t%s\tcomponent: %s\tfinal: %s\t%s\n' $k $t "$a" "$b" "$v" | tee -a $X/RESULTS.tsv; done < $X/$k-tests.txt; done
echo "== E2. regressions (REGRESSIONS.txt: every test touching the changed modules; baseline = the owner-CLI head, else route, else none)"
while IFS= read -r t; do bt=; for k in ownercli route; do [ -e $X/trees/$k/$t ] && { bt=$k; break; }; done
  b=$(run1 final $t "regress--final--$(echo $t | tr / _)")
  if [ -n "$bt" ]; then a=$(run1 $bt $t "regress--$bt--$(echo $t | tr / _)"); else a="(no baseline: new in the composition)"; fi
  if clean "$b"; then v=ok; elif [ -n "$bt" ] && ! clean "$a"; then v=BASELINE-NOT-CLEAN; incomplete=1; else v=REGRESSION; fail=1; fi
  printf 'REGRESS\t%s\tbaseline(%s): %s\tfinal: %s\t%s\n' $t "${bt:-none}" "$a" "$b" $v | tee -a $X/RESULTS.tsv; done < $R4/REGRESSIONS.txt
echo "== F. composed-stack tests"
for t in $STACK; do b=$(run1 final $t "stack--$(basename $t)"); if clean "$b"; then echo "[ok] $t $b"; else echo "[FAIL] $t $b"; fail=1; fi; printf 'STACK\t%s\tfinal: %s\n' $t "$b" >> $X/RESULTS.tsv; done
echo "== F2. native-input tests (CHAIN_VERIFIER_INPUTS = root 0104 inputs; a skip fails)"
for t in $NATIVE; do log=$X/logs/native--$(basename $t).out; (cd $F && CHAIN_VERIFIER_INPUTS=$CVI timeout -k 10 600 python3 $t -v) > $log 2>&1; rc=$?
  if [ $rc = 0 ] && tail -1 $log | grep -qx OK && ! grep -q 'skipped' $log; then echo "[ok] native $t"; else echo "[FAIL] native $t rc $rc: $(tail -1 $log)"; fail=1; fi; printf 'NATIVE\t%s\trc %s %s\n' $t $rc "$(tail -1 $log)" >> $X/RESULTS.tsv; done
echo "== G. dependency closures unchanged after builds and tests"
for t in consumers leaseRelay verifier route seam ownercli final; do for d in $DEPDIRS; do dst=$X/trees/$t/node_modules; [ $d != . ] && dst=$X/trees/$t/$d/node_modules
  [ "$(python3 -I $R4/tools/deps-identity.py $G ${SHA[$t]} $d $dst | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')" = "${TH[$d]}" ] || { echo "[FAIL] $t $d closure changed during the run"; fail=1; }; done; done
for d in $DEPDIRS; do nm=$E/node_modules; [ $d != . ] && nm=$E/$d/node_modules; [ "$(python3 -I $R4/tools/deps-identity.py $G ${SHA[final]} $d $nm | python3 -c 'import json,sys;print(json.load(sys.stdin)["treehash"])')" = "${TH[$d]}" ] || { echo "[FAIL] source closure $d changed"; fail=1; }; done
(cd $X && sha256sum RESULTS.tsv gen-pass-* logs/*.out > RECEIPTS.sha256)
echo "## summary: regenerated $FINAL; component tests $(grep -vc '^STACK' $X/RESULTS.tsv), regressions $(grep -c REGRESSION $X/RESULTS.tsv), baseline-not-clean $(grep -c BASELINE $X/RESULTS.tsv); stack $(grep -c '^STACK' $X/RESULTS.tsv)"
[ $fail = 0 ] || { echo "RESULT: FAIL"; exit 1; }
[ $incomplete = 0 ] || { echo "RESULT: INCOMPLETE (no regression; NOT a production pass)"; exit 3; }
echo "## rc=0 PASS (regenerated composed candidate $FINAL: bundles reproducible, component parity, composed-stack tests; private, not pushed, not imaged)"
