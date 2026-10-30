import re
p='jobs/r11-build-validate.sh'; s=open(p).read()
def rep(a,b,n=1):
    global s; assert s.count(a)==n,(a[:90],s.count(a)); s=s.replace(a,b)
rep('# r10 = r9 (frozen) runner','# r11 = r10 (frozen) runner on the r11 candidate 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 (r10 + the reviewed composition-baseline-fixes-stage test patch\n#   654b3f17) with: B2 test fixtures in EVERY tree (the ignored network runtime; the pinned OFFLINE forge subset of the rigs\' art()\n#   closure, two independent builds per contract closure compared EXCLUDING out/build-info (per-build bookkeeping ids), copies\n#   verified), the baseline-fix test overlay on the component trees, shared EXACT test receipts (tree commit + test file sha256 +\n#   setup hash: dependency closures, artifacts, network runtime) so E/E2 reuse one result instead of rerunning the same test on the same\n#   tree, and --preflight (stops after A + B + B2, before the long suite).\n# r10 text follows. r10 = r9 (frozen) runner')
rep('R3=$S/r3; R4=$S/r10; G=$R4/src.git','R3=$S/r3; R4=$S/r11; G=$R4/src.git')
rep('need "r10 files == SHA256SUMS"','need "r11 files == SHA256SUMS"')
rep('need "r10 private refs == r10/REFS.txt"','need "r11 private refs == r11/REFS.txt"')
rep('need "r9 stage files unchanged (frozen; its run dir is not read)" bash -c "cd $S/r9 && sha256sum -c --quiet SHA256SUMS"',
    'need "r9 stage files unchanged (frozen; its run dir is not read)" bash -c "cd $S/r9 && sha256sum -c --quiet SHA256SUMS"\nneed "r10 stage files unchanged (frozen)" bash -c "cd $S/r10 && sha256sum -c --quiet SHA256SUMS"\nneed "baseline-fix stage pinned (its patch is the candidate\'s test change)" bash -c "cd $S/../composition-baseline-fixes-stage && sha256sum -c --quiet $R4/BASELINE-FIX-PINS.sha256 && sha256sum -c --quiet SHA256SUMS && cmp patches/native-relay-remote-verifier-refusal.patch $R4/tools/native-relay-remote-verifier-refusal.patch"')
rep('[final]=refs/r10/candidate)','[final]=refs/r11/candidate)')
s=re.sub(r'need "candidate is r10 [^\n]*\n','need "candidate is r11 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 (parent r10 7371ee06; exactly the native-relay test patch)" bash -c "[ ${SHA[final]} = 2d56a4b193a8f3e0be1b343a1e06970fc193d9f9 ] && [ \\"\\$(git --git-dir=$G log -1 --format=%P ${SHA[final]})\\" = 7371ee06766a4c297d68adbd77a40a7af33f605e ] && [ \\"\\$(git --git-dir=$G diff --name-only 7371ee06766a4c297d68adbd77a40a7af33f605e ${SHA[final]})\\" = test/native-relay-chain-authority.test.mjs ]"\n',s,count=1)
rep('need "r10 commit message pins R10-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \\"R10-Resolutions-Sha256: \\$(sha256sum < $R4/R10-RESOLUTIONS.json | cut -c1-64)\\""',
    'need "r10 parent message pins R10-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]}^ | grep -qx \\"R10-Resolutions-Sha256: \\$(sha256sum < $S/r10/R10-RESOLUTIONS.json | cut -c1-64)\\""\nneed "r11 message pins the applied patch" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \\"Applied-Patch-Sha256: \\$(sha256sum < $R4/tools/native-relay-remote-verifier-refusal.patch | cut -c1-64)\\""')
B2='''echo "== B2. test fixtures in EVERY tree: the ignored network runtime + the pinned OFFLINE forge subset (CONTRACT-ARTIFACTS.txt)"
FORGE=/home/steven/.foundry/bin/forge SOLC=/home/steven/.local/share/svm/0.8.35/solc-0.8.35
[ "$(sha256sum < $FORGE | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && $FORGE --version | grep -q 4072e48705af9d93e3c0f6e29e93b5e9a40caed8 || { echo "[FAIL] forge is not the pinned 1.7.1"; exit 9; }
[ "$(sha256sum < $SOLC | cut -c1-64)" = fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4 ] && $SOLC --version | grep -q '0.8.35+commit.47b9dedd' || { echo "[FAIL] solc is not the pinned 0.8.35"; exit 9; }
command -v anvil >/dev/null && command -v openssl >/dev/null || { echo "[FAIL] anvil/openssl missing: the rigs would skip"; exit 9; }
SOURCES=$(sed -n 's/^source //p' $R4/CONTRACT-ARTIFACTS.txt); ARTS=$(sed -n 's/^artifact //p' $R4/CONTRACT-ARTIFACTS.txt)
declare -A CLS FIRST NB SETUP
amanifest() { (cd $X/trees/$1/contracts/foundry && find out -type f -name '*.json' -not -path 'out/build-info/*' | LC_ALL=C sort | xargs -r sha256sum) > $X/ARTIFACTS-$1.sha256; }
build_tree() { local T=$X/trees/$1 src; for src in $SOURCES; do [ -e $T/$src ] || { echo "[note] $1 has no $src (older head)"; continue; }
    (cd $T && FOUNDRY_OFFLINE=true timeout -k 10 1200 $FORGE build --offline -j 1 --use $SOLC "$src") > $X/logs/forge-$1-$(basename $src .sol).log 2>&1 || { echo "[FAIL] forge build $src ($1)"; return 1; }; done; amanifest $1; }
for t in consumers leaseRelay verifier route seam ownercli final; do T=$X/trees/$t
  grep -qx 'solc = "0.8.35"' $T/foundry.toml && git -C $T diff --quiet -- foundry.toml contracts && [ -z "$(git -C $T ls-files --others --exclude-standard -- contracts foundry.toml)" ] || { echo "[FAIL] $t: contract inputs modified or solc not pinned"; exit 9; }
  CLS[$t]=$(git -C $T ls-files -s -- foundry.toml contracts | sha256sum | cut -c1-64); c=${CLS[$t]}
  if [ -z "${FIRST[$c]:-}" ]; then build_tree $t || exit 9; FIRST[$c]=$t; NB[$c]=1
  elif [ "${NB[$c]}" = 1 ]; then build_tree $t || exit 9; NB[$c]=2
    cmp -s $X/ARTIFACTS-$t.sha256 $X/ARTIFACTS-${FIRST[$c]}.sha256 || { echo "[FAIL] two independent forge builds of closure ${c:0:12} differ in contract artifacts"; exit 9; }
  else (cd $X/trees/${FIRST[$c]}/contracts/foundry && find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {} $T/contracts/foundry/out/ \\; ) 2>/dev/null || { mkdir -p $T/contracts/foundry/out && (cd $X/trees/${FIRST[$c]}/contracts/foundry && find out -mindepth 1 -maxdepth 1 -not -name build-info -exec cp -a {} $T/contracts/foundry/out/ \\; ); }
    amanifest $t; cmp -s $X/ARTIFACTS-$t.sha256 $X/ARTIFACTS-${FIRST[$c]}.sha256 || { echo "[FAIL] $t: copied artifacts differ from closure ${c:0:12}"; exit 9; }; fi
  for a in $ARTS; do src=$(sed -n "s|^source \\(.*/${a%%/*}\\)$|\\1|p" $R4/CONTRACT-ARTIFACTS.txt); [ -e $T/$src ] || continue
    python3 -I -c "import json,sys; b=json.load(open(sys.argv[1]))['bytecode']['object']; assert b.startswith('0x') and len(b)>2" $T/contracts/foundry/out/$a || { echo "[FAIL] $t: artifact $a missing or without bytecode"; exit 9; }; done
  NR=none; if [ $t != final ] && [ -e $T/relay/build-network.mjs ]; then (cd $T && timeout 600 node relay/build-network.mjs) > $X/logs/network-runtime-$t.out 2>&1 || { echo "[FAIL] $t: relay/build-network.mjs"; exit 9; }; NR=$(sha256sum < $T/relay/network-runtime.bundle.mjs | cut -c1-64); fi
  SETUP[$t]=$(printf '%s %s %s %s %s' "${TH[.]}" "${TH[network]}" "${TH[relay]}" "$(sha256sum < $X/ARTIFACTS-$t.sha256 | cut -c1-64)" "$NR" | sha256sum | cut -c1-64)
  echo "[ok] $t: closure ${c:0:12}, $(wc -l < $X/ARTIFACTS-$t.sha256) contract artifacts (build ${FIRST[$c]}), network runtime ${NR:0:12}"
done
echo "== B3. the reviewed baseline-fix TEST overlay on component trees whose test is the patch's exact pre-image (product untouched)"
for t in consumers leaseRelay verifier route seam ownercli; do (cd $X/trees/$t && git apply --check $R4/tools/native-relay-remote-verifier-refusal.patch 2>/dev/null && git apply $R4/tools/native-relay-remote-verifier-refusal.patch && echo "$t" >> $X/OVERLAYS.txt && echo "[ok] $t: native-relay test overlay applied (test-only)"); done
mkdir -p $X/receipts
if [ "${1:-}" = --preflight ]; then echo "## preflight rc=0 (A + B + B2 + B3 done; no generator, no test run)"; exit 0; fi
'''
rep('echo "== C. the pinned image tree, twice', B2 + 'echo "== C. the pinned image tree, twice')
rep("printf '%s\\n' relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json)", "printf '%s\\n' relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json contracts/foundry/out/ contracts/foundry/cache/)")
rep('FINAL=$(git -C $F rev-parse HEAD)\n', 'FINAL=$(git -C $F rev-parse HEAD)\nSETUP[final]=$(printf \'%s %s %s %s %s\' "${TH[.]}" "${TH[network]}" "${TH[relay]}" "$(sha256sum < $X/ARTIFACTS-final.sha256 | cut -c1-64)" "$(cut -c1-64 $X/gen-pass-2.ignored.sha256 | tr \'\\n\' \' \')" | sha256sum | cut -c1-64)\n')
rep('''run1() { local tree=$1 test=$2 log=$X/logs/$3.out''','''run1() { local tree=$1 test=$2 log=$X/logs/$3.out key tb rc
  # the EXACT receipt: tree commit + test path + test file sha256 (overlays and stack copies included) + setup hash. The same key
  # (E and E2 on the same tree and file) reuses one result; a different tree NEVER shares (a baseline is never borrowed).
  tb=$(sha256sum < $X/trees/$tree/$test 2>/dev/null | cut -c1-64); [ -n "$tb" ] || { echo "1 pass=0 fail=1 skip=0 todo=0 cancelled=1"; return; }
  key=$(printf '%s %s %s %s %s' "$(git -C $X/trees/$tree rev-parse HEAD)" "$test" "$tb" "${SETUP[$tree]:?no setup hash for $tree}" "$(cat $X/OVERLAYS.txt 2>/dev/null | tr '\\n' ,)" | sha256sum | cut -c1-64)
  if [ -s $X/receipts/$key.rc ]; then cp $X/receipts/$key.out $log; echo "$tree $test $key" >> $X/receipts/REUSED.tsv; echo "$(cat $X/receipts/$key.rc) $(summ $log)"; return; fi''')
rep('''  echo "$? $(summ $log)"; }''','''  rc=$?; cp $log $X/receipts/$key.out; echo $rc > $X/receipts/$key.rc
  printf '%s\\t%s\\t%s\\t%s\\t%s\\n' $key $tree $test $tb $(sha256sum < $log | cut -c1-64) >> $X/receipts/RECEIPTS.tsv; echo "$rc $(summ $log)"; }''')
open(p,'w').write(s)
