import pathlib,subprocess,json,re
P=pathlib.Path(__file__).resolve().parent;R=P/'repo';OUT=P.parents[1]/'outputs/product-claims-20261021'
def git(*args):return subprocess.check_output(['git','-C',str(R),*args],text=True)
assert set(git('diff','--name-only').splitlines())=={'PRODUCT.md','README.md'}
subprocess.run(['git','-C',str(R),'diff','--check'],check=True)
p=(R/'PRODUCT.md').read_text();r=(R/'README.md').read_text()
for banned in ['full target architecture as the product, in direct present tense','no roadmap, status or readiness framing','No readiness taxonomy','No readiness labels','never appear in market copy','with deployment facts in the evidence contexts above']:
 assert banned not in p,banned
assert '## Public Claims Policy' in p and 'PRODUCT.md#public-claims-policy' in r
for f in ['docs/shielded-inference.md','docs/site-claims-2026-09-23.md','docs/security/nucbox-custom-vm-verifier.md','windows/vbslike/README.md']:
 subprocess.run(['git','-C',str(R),'cat-file','-e','HEAD:'+f],check=True)
assert 'host_excluded: no' in r and 'No external audit' in r
assert '**Per-app CPU isolation that keeps the host OS out.** *Live on Windows*' not in r
base=git('rev-parse','HEAD').strip();remote=git('ls-remote','origin','refs/heads/main').split()[0];assert remote==base,'Main advanced; reconcile before publishing'
result={'status':'PASS','base':base,'changedFiles':['PRODUCT.md','README.md'],'diffCheck':'PASS','evidenceSourcesExist':True,'contradictoryMarketingInstructionsRemoved':True,'datedDeploymentScope':True,'runtimeChanges':False,'applicationTests':'Not run: documentation-only edit. Existing runtime compatibility issues from the separately requested history replacement are outside this change.'}
(OUT/'verification.json').write_text(json.dumps(result,indent=2)+'\n');(OUT/'documentation.patch').write_text(git('diff'));print(json.dumps(result))
