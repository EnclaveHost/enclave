import re
p='jobs/r9-build-validate.sh'; s=open(p).read()
def rep(a,b,n=1):
    global s; assert s.count(a)==n,(a[:90],s.count(a)); s=s.replace(a,b)
rep('# r7 = r6 (frozen)','# r9 = r7 (frozen) runner on the r9 candidate 82ec7d455cc6e9957c1500f6e58ffde557093392: one Windows chain authority (consumer e4f507d6b + owner CLI b6ac5d657, root\n#   receipts 70d39eaa/3e4502a0) composed with route\'s verified per-block reads (R9-RESOLUTIONS.json). Adds the owner-CLI component\n#   (aebf..b6ac: e4f 12 + owner 8 tests), a regression phase (REGRESSIONS.txt: every test touching the changed modules, each\n#   against its baseline head), explicit INTENTIONAL-CHANGES markers, the recomputed dependency graph. All r7 gates kept.\n# r7 text follows. r7 = r6 (frozen)')
rep('R3=$S/r3; R4=$S/r7; G=$R4/src.git','R3=$S/r3; R4=$S/r9; G=$R4/src.git')
rep('need "r7 files == SHA256SUMS"','need "r9 files == SHA256SUMS"')
rep('need "r7 private refs == r7/REFS.txt"','need "r9 private refs == r9/REFS.txt"')
rep('need "r6 stage unchanged (frozen; its runner is the base of this one)" bash -c "cd $S/r6 && sha256sum -c --quiet SHA256SUMS"',
    'need "r6 stage unchanged (frozen)" bash -c "cd $S/r6 && sha256sum -c --quiet SHA256SUMS"\nneed "r7 stage unchanged (frozen; its runner is the base of this one)" bash -c "cd $S/r7 && sha256sum -c --quiet SHA256SUMS"\nneed "r8 stage unchanged (frozen)" bash -c "cd $S/r8 && sha256sum -c --quiet SHA256SUMS"')
rep('[seam]=refs/src/consumers-seam [final]=refs/r7/candidate)','[seam]=refs/src/consumers-seam [ownercli]=refs/src/consumers-ownercli [final]=refs/r9/candidate)')
rep('[seam]=81ba66853)','[seam]=81ba66853 [ownercli]=aebf4c932)')
s=re.sub(r'need "candidate is r7 c154f05c[^\n]*\n','need "candidate is r9 82ec7d455cc6e9957c1500f6e58ffde557093392 (parents: r8 partial 8fdf00d0 + owner CLI b6ac5d657)" bash -c "[ ${SHA[final]} = 82ec7d455cc6e9957c1500f6e58ffde557093392 ] && [ \\"\\$(git --git-dir=$G log -1 --format=%P ${SHA[final]})\\" = \'8fdf00d001c593602c3639dca79d3ec4bcf2e559 b6ac5d657deee3a9e05c7038ae6ffe96c4d7a604\' ]"\n',s,count=1)
rep('need "r7 commit message pins R7-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \\"R7-Resolutions-Sha256: \\$(sha256sum < $R4/R7-RESOLUTIONS.json | cut -c1-64)\\""',
    'need "r9 commit message pins R9-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \\"R9-Resolutions-Sha256: \\$(sha256sum < $R4/R9-RESOLUTIONS.json | cut -c1-64)\\""\nneed "both consumer root receipts are the pinned passes" bash -c "cd $S/../logs && echo \'70d39eaa4bd3b84edd8aa2566cb458087fef30814200e547bed754a98fe2ce48  windows-authority-e4f507d6b-root-receipt.out\n3e4502a098fb8c9942dd95695b57dfca0a26c9a1e123b48e6167615119448d40  windows-owner-cli-b6ac5d657-root-receipt.out\' | sha256sum -c --quiet"\nneed "every regression test exists in the candidate" bash -c "while read t; do git --git-dir=$G cat-file -e ${SHA[final]}:\\$t || exit 1; done < $R4/REGRESSIONS.txt"')
rep('for k in consumers leaseRelay verifier route seam; do','for k in consumers leaseRelay verifier route seam ownercli; do',2)
rep('for t in consumers leaseRelay verifier route seam final; do','for t in consumers leaseRelay verifier route seam ownercli final; do',2)
rep('''  printf '%s\\t%s\\tcomponent: %s\\tfinal: %s\\t%s\\n' $k $t "$a" "$b" $v | tee -a $X/RESULTS.tsv; done < $X/$k-tests.txt; done''',
    '''  grep -qxF "$t" $R4/INTENTIONAL-CHANGES.txt && ! cmp -s $X/trees/$k/$t $F/$t && v="$v (ADAPTED in the candidate: intentional API change, INTENTIONAL-CHANGES.txt; both versions must pass)"
  printf '%s\\t%s\\tcomponent: %s\\tfinal: %s\\t%s\\n' $k $t "$a" "$b" "$v" | tee -a $X/RESULTS.tsv; done < $X/$k-tests.txt; done
echo "== E2. regressions (REGRESSIONS.txt: every test touching the changed modules; baseline = the owner-CLI head, else route, else none)"
while IFS= read -r t; do bt=; for k in ownercli route; do [ -e $X/trees/$k/$t ] && { bt=$k; break; }; done
  b=$(run1 final $t "regress--final--$(echo $t | tr / _)")
  if [ -n "$bt" ]; then a=$(run1 $bt $t "regress--$bt--$(echo $t | tr / _)"); else a="(no baseline: new in the composition)"; fi
  if clean "$b"; then v=ok; elif [ -n "$bt" ] && ! clean "$a"; then v=BASELINE-NOT-CLEAN; incomplete=1; else v=REGRESSION; fail=1; fi
  printf 'REGRESS\\t%s\\tbaseline(%s): %s\\tfinal: %s\\t%s\\n' $t "${bt:-none}" "$a" "$b" $v | tee -a $X/RESULTS.tsv; done < $R4/REGRESSIONS.txt''')
open(p,'w').write(s)
