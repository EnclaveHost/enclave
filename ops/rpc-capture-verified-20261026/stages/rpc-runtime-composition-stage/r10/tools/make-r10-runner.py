import re
p='jobs/r10-build-validate.sh'; s=open(p).read()
def rep(a,b,n=1):
    global s; assert s.count(a)==n,(a[:90],s.count(a)); s=s.replace(a,b)
rep('# r9 = r7 (frozen) runner','# r10 = r9 (frozen) runner on the r10 candidate 7371ee06766a4c297d68adbd77a40a7af33f605e (r9 + consumer credit 12b41d459 + the provider-authority fix) with the six\n#   root-triage corrections (r9-root-build-triage.txt): bounded in-tree symlink resolution and runtimeFiles/sidecars source mapping in\n#   the auditor (with its own fixture tests), the exact public-rpc/service-tls package paths, custody vendor REGENERATED twice\n#   deterministically, exact checked git staging (no add warning, no dependency file), cancelled/expected-failure counts.\n# r9 text follows. r9 = r7 (frozen) runner')
rep('R3=$S/r3; R4=$S/r9; G=$R4/src.git','R3=$S/r3; R4=$S/r10; G=$R4/src.git')
rep('need "r9 files == SHA256SUMS"','need "r10 files == SHA256SUMS"')
rep('need "r9 private refs == r9/REFS.txt"','need "r10 private refs == r10/REFS.txt"')
rep('need "r8 stage unchanged (frozen)" bash -c "cd $S/r8 && sha256sum -c --quiet SHA256SUMS"','need "r8 stage unchanged (frozen)" bash -c "cd $S/r8 && sha256sum -c --quiet SHA256SUMS"\nneed "r9 stage files unchanged (frozen; its run dir is not read)" bash -c "cd $S/r9 && sha256sum -c --quiet SHA256SUMS"\nneed "credit root receipts are the pinned passes (0228/0230/0232)" bash -c "cd $S/../logs && sha256sum -c --quiet $R4/CREDIT-RECEIPTS.sha256"\nneed "auditor fixture tests (symlinks bounded in-tree, runtimeFiles/sidecars by source)" python3 -I $R4/tools/test_manifest_staleness.py')
rep('[final]=refs/r9/candidate)','[final]=refs/r10/candidate)')
s=re.sub(r'need "candidate is r9 [^\n]*\n','need "candidate is r10 7371ee06766a4c297d68adbd77a40a7af33f605e (parents: r9 82ec7d45 + consumer credit 12b41d459)" bash -c "[ ${SHA[final]} = 7371ee06766a4c297d68adbd77a40a7af33f605e ] && [ \\"\\$(git --git-dir=$G log -1 --format=%P ${SHA[final]})\\" = \'82ec7d455cc6e9957c1500f6e58ffde557093392 12b41d4592f4a8d216c827b1bccc8f4d79b51c07\' ]"\n',s,count=1)
rep('R9-Resolutions-Sha256: \\$(sha256sum < $R4/R9-RESOLUTIONS.json','R10-Resolutions-Sha256: \\$(sha256sum < $R4/R10-RESOLUTIONS.json')
rep('need "r9 commit message pins R9-RESOLUTIONS.json"','need "r10 commit message pins R10-RESOLUTIONS.json"')
rep('build-mcp-guest-bundle build-platform','build-mcp-guest-bundle build-custody-vendor build-platform')
rep('VENDOR="build-host-policy-vendor build-management-vendor build-aa-vendor build-custody-vendor build-credit-vault-vendor build-host-capacity-vendor"   # check-only','VENDOR="build-host-policy-vendor build-management-vendor build-aa-vendor build-credit-vault-vendor build-host-capacity-vendor"   # check-only; custody is REGENERATED in SEQ (its sources are composed)')
STAGE='''stage_exact() { # stage EXACTLY the regenerated paths (each in GENERATED.txt); refuse an add warning, an extra staged path or a dependency file
  local list extra; list=$(git -C $F status --porcelain=v1 -z --untracked-files=all -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules' | tr '\\0' '\\n' | sed -n 's/^...//p' | LC_ALL=C sort -u)
  [ -n "$list" ] || { echo "[FAIL] nothing regenerated ($1)"; return 1; }
  extra=$(grep -vxF -f <(grep -v '^#' $R4/GENERATED.txt) <<<"$list" || true); [ -z "$extra" ] || { echo "[FAIL] non-generated path would be staged ($1): $(echo $extra | head -c 300)"; return 1; }
  printf '%s\\n' "$list" | git -C $F add --pathspec-from-file=- 2> $X/logs/git-add-$1.err || { echo "[FAIL] git add ($1)"; return 1; }
  [ ! -s $X/logs/git-add-$1.err ] || { echo "[FAIL] git add warned ($1): $(head -c 300 $X/logs/git-add-$1.err)"; return 1; }
  [ "$(git -C $F diff --cached --name-only | LC_ALL=C sort -u)" = "$list" ] || { echo "[FAIL] staged set != regenerated set ($1)"; return 1; }
  ! git -C $F diff --cached --name-only | grep -q 'node_modules/' || { echo "[FAIL] a dependency file was staged ($1)"; return 1; }
}
'''
rep('for pass in 1 2; do for g in $SEQ; do', STAGE + 'for pass in 1 2; do for g in $SEQ; do')
rep("  git -C $F add -A -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules'; git -C $F diff --cached --binary > $X/gen-pass-$pass.diff; git -C $F reset -q",
    "  stage_exact pass$pass || fail=1; git -C $F diff --cached --binary > $X/gen-pass-$pass.diff; git -C $F reset -q")
rep("[ -z \"$bad\" ] || { echo \"[FAIL] regeneration touched non-generated files: $bad\"; fail=1; }\ngit -C $F add -A -- . ':!node_modules' ':!network/node_modules' ':!relay/node_modules'",
    "[ -z \"$bad\" ] || { echo \"[FAIL] regeneration touched non-generated files: $bad\"; fail=1; }\nmiss=$(grep -v '^#' $R4/GENERATED.txt | while read -r p; do [ -e $F/$p ] || echo $p; done); [ -z \"$miss\" ] || { echo \"[FAIL] a listed generated path was not produced: $miss\"; fail=1; }\npk=$(cd $F/network/host-services/packages && ls | sed 's|^|network/host-services/packages/|' | LC_ALL=C sort); [ \"$pk\" = \"$(grep '^network/host-services/packages/' $R4/GENERATED.txt | LC_ALL=C sort)\" ] || { echo \"[FAIL] the generator's package set != the exact GENERATED package entries\"; fail=1; }\nstage_exact final || { echo \"RESULT: FAIL (staging)\"; exit 1; }")
rep('''    print(f"pass={n if ok else 0} fail={0 if ok else 1} skip={sk} todo=0")
else: print(f"pass={g('pass')} fail={g('fail')} skip={g('skipped')} todo={g('todo')}")''',
'''    xf = sum(int(x) for x in re.findall(r"expected failures=(\\d+)", s)); us = sum(int(x) for x in re.findall(r"unexpected successes=(\\d+)", s))
    print(f"pass={n if ok else 0} fail={(0 if ok else 1) + xf + us} skip={sk} todo=0 cancelled=0")
else:
    summary = all(re.search(rf"^# {k} \\d+$", s, re.M) for k in ("tests", "pass", "fail", "cancelled", "skipped", "todo"))
    print(f"pass={g('pass') if summary else 0} fail={g('fail') if summary else 1} skip={g('skipped')} todo={g('todo')} cancelled={g('cancelled') if summary else 1}")''')
rep('clean() { case "$1" in "0 pass=0 "*) return 1;; "0 "*"fail=0 skip=0 todo=0") return 0;; *) return 1;; esac; }',
    'clean() { case "$1" in "0 pass=0 "*) return 1;; "0 "*"fail=0 skip=0 todo=0 cancelled=0") return 0;; *) return 1;; esac; }')
rep('Regenerated-From: ${SHA[final]}','Regenerated-From: ${SHA[final]} (r10 job)')
assert 'todo=0)' not in s.replace('todo=0 cancelled=0")','')
open(p,'w').write(s)
