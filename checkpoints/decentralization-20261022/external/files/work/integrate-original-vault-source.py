from pathlib import Path
import hashlib, re, subprocess, json, datetime
root=Path('work/enclave').resolve(); candidate=Path('work/existing-custody-audit/candidate').resolve()
paths={
'contracts/EnclaveSecretVaultV2.sol','contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol','contracts/variants/README.md',
'contracts/foundry/test/EnclaveSecretVaultV2.t.sol','contracts/foundry/test/EnclaveSecretVaultV2Original.t.sol',
'scripts/deploy-secret-vault-v2.mjs','scripts/independent-authorities.mjs',
' test/custody-v2-e2e.test.mjs'.strip(),'test/custody-v2-independent-lifecycle.test.mjs','test/helpers/independent-custody-rig.mjs',
 'test/custody-cli-independent.test.mjs','test/helpers/owner-read-rig.mjs','test/cli-combined-custody.test.mjs'}
base={}
for name in ['existing-vault-client.BASE.txt','root-owned-rigs.BASE.txt']:
 for l in (candidate/name).read_text().splitlines():
  m=re.match(r'^([a-f0-9]{64})  (\S+)',l)
  if m:base[m[2]]=m[1]
h=lambda b:hashlib.sha256(b).hexdigest()
chunks=[]
for name in ['existing-vault-client.patch','root-owned-rigs.patch']:
 s=(candidate/name).read_text(); starts=[m.start() for m in re.finditer(r'^--- ',s,re.M)]+[len(s)]
 for a,b in zip(starts,starts[1:]):
  c=s[a:b]; line=c.splitlines()[1]; path=line.removeprefix('+++ b/').split('\t')[0]
  if path in paths:chunks.append(c)
assert len(chunks)==len(paths),(len(chunks),len(paths))
receipt=[]
for p in sorted(paths):
 file=root/p
 if p in base:assert file.is_file() and h(file.read_bytes())==base[p],('base drift',p)
 else:assert not file.exists(),('new already exists',p)
 receipt.append({'path':p,'baseSha256':h(file.read_bytes()) if file.exists() else None})
original=subprocess.check_output(['git','show','7a385bbc'],cwd=root)
assert h(original)=='2c7692ec13db18f567b3fa469db5931cfc4451540092259a0d28b651468a4469'
assert (candidate/'tree/contracts/EnclaveSecretVaultV2.sol').read_bytes()==original
patch=Path('work/original-vault-source-integration.patch').resolve();patch.write_text(''.join(chunks))
subprocess.run(['git','apply','--check',str(patch)],cwd=root,check=True)
subprocess.run(['git','apply',str(patch)],cwd=root,check=True)
for r in receipt:
 p=r['path'];r['newSha256']=h((root/p).read_bytes())
 if (candidate/'tree'/p).exists():assert (root/p).read_bytes()==(candidate/'tree'/p).read_bytes(),('candidate differs',p)
# An extra compile consumer missed in the candidate inventory also exercises the optional variant.
p=root/'test/custody-independent-genesis.test.mjs';before=p.read_text();needle="root+'contracts/EnclaveSecretVaultV2.sol'";assert before.count(needle)==1
p.write_text(before.replace(needle,"root+'contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol'"))
receipt.append({'path':str(p.relative_to(root)),'baseSha256':h(before.encode()),'newSha256':h(p.read_bytes()),'reason':'Existing independent-genesis fixture has three-argument variant constructor and createIndependentCommittee; preserve its exact compiled source.'})
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceIntegrated':True,'productionChanged':False,'canonicalSha256':h(original),'variantSha256':h((root/'contracts/variants/EnclaveSecretVaultV2PinnedAuthorities.sol').read_bytes()),'files':receipt,'priorExactCandidateEvidence':{'originalFoundry':25,'variantFoundry':34,'sourceRuntimeMatch':'outputs/storage-independent-policy-original-source-evidence pending copy; original-source-verification at52850658 full-match'},'remaining':['Main integration source/build checks','Custody clients and actual host-policy enforcement still in separately owned candidate','No deployment or on-chain change made']}
Path('outputs/contract-change-audit/original-vault-source-integration.json').write_text(json.dumps(out,indent=2)+'\n')
print('Canonical original restored; optional variant preserved; 14 source/fixture paths integrated.')
