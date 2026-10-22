from pathlib import Path
import json,hashlib,shutil,re
r=Path(__file__).resolve().parent;w=r.parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
g4=w/'challenge-host-tls-20261021/g4';old=g4/'upgrade-bundle-g4';src=w/'g4-config-independent-review-20261021/revision2'
evidence=json.loads((w/'challenge-prerequisites-20261022/native-final/result.json').read_text())
assert evidence['ok'] is True
new={
 'bin/host-services-runner.mjs':src/'root-txt-runner/artifacts/host-services-runner.mjs',
 'bin/stage-tool.mjs':src/'root-txt-runner/artifacts/stage-tool.mjs',
 'packages/route-dns.mjs':src/'root-txt-merge/artifacts/route-dns.mjs',
 'packages/route-dns.package.json':src/'root-txt-merge/artifacts/route-dns.package.json'}
for name,p in new.items():
 key=name.removeprefix('bin/').replace('/','\\')
 assert sha(p)==evidence['upload'][key],name
oldmanifest=json.loads((old/'upgrade-manifest.json').read_text())
post=json.loads((g4/'root-g4/result-upgrade-20261021T223430Z.json').read_text())['post']['facts']
oldmap={x['path']:x['new'] for x in oldmanifest['replace']};oldmap.update({x['path']:x['sha'] for x in oldmanifest['unchanged']})
assert all(post['files'][k]==v for k,v in oldmap.items())
b=r/'bundle'
for name,p in new.items():
 dest=b/'files'/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,dest)
text=(old/'files/STAGE-SHA256SUMS').read_text();assert sha(old/'files/STAGE-SHA256SUMS')==oldmap['STAGE-SHA256SUMS']
for name,p in new.items():
 needle=oldmap[name]+'  '+name;assert text.count(needle)==1;text=text.replace(needle,sha(p)+'  '+name)
(b/'files/STAGE-SHA256SUMS').write_text(text)
config=w/'challenge-declaration-native-20261022/config/host-services.parallel-txt.draft.json'
assert sha(config)==evidence['upload']['config.json']
(b/'config').mkdir(exist_ok=True);shutil.copy2(config,b/'config/host-services.json')
changed=['STAGE-SHA256SUMS',*new]
manifest={'format':'enclave-hs2-upgrade/v1','label':'hs2','id':'hs2-parallel-txt-'+sha(b/'files/STAGE-SHA256SUMS')[:8],'scripts':oldmanifest['scripts'],
 'replace':[{'path':name,'old':oldmap[name],'new':sha(b/'files'/name)} for name in changed], 'add':[],
 'unchanged':[{'path':name,'sha':h} for name,h in oldmap.items() if name not in changed],
 'config':{'old':post['config'],'new':sha(config),'changedPins':{'sha256:'+oldmap['packages/route-dns.package.json']:'sha256:'+sha(new['packages/route-dns.package.json'])},'challengeAdded':False},'receipt':{'old':post['receipt']}}
(b/'upgrade-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
# Retain the reviewed driver's staging/CAS/rollback logic, replacing package paths and exact pins only.
orig=(g4/'root-hs2-g4.py').read_text()
start=orig.index('import argparse,');s=orig[start:]
s=s.replace('WORK = HERE.parent.parent          # g4 -> challenge-host-tls-20261021 -> work','WORK = HERE.parent')
s=s.replace('BUNDLE = WORK / "challenge-host-tls-20261021/g4/upgrade-bundle-g4"','BUNDLE = HERE / "bundle"')
a=s.index('MSHA = ');z=s.index('OPT = ',a)
files={str(p.relative_to(b)):sha(p) for p in sorted(b.rglob('*')) if p.is_file()}
s=s[:a]+'MSHA = '+repr(sha(b/'upgrade-manifest.json'))+'\nBUNDLE_FILES = '+repr(files)+'\n'+s[z:]
s=s.replace('OUT = HERE / "root-g4"','OUT = HERE / "runs"').replace('hs2up-g4-','hs2up-txt-')
header='''#!/usr/bin/env python3
"""Root-only staged hs2 parallel TXT upgrade. PREPARED, NOT ACTIVATED.
Uses unchanged reviewed G4 driver logic, hs2-upgrade helper b17360b2 and transport c50aac8e.
Replaces runner, validation tool, route-DNS runtime/manifest and stage checksum list.
Config is the exact native-validated paired config 5f75562c; ACME orders remain held.
Default read-only preflight; --selfcheck is local. Staging/execution/revert remain root-only.
Before activation: review package, current preflight/CAS, complete node/control/privacy
prerequisites and verify challenge declaration. This package alone is NOT provider independence.
"""
'''
(r/'root-hs2-parallel.py').write_text(header+s)
inventory={'status':'prepared; not activated','sourceNativeEvidence':str(w/'challenge-prerequisites-20261022/native-final/result.json'),'manifestSha256':sha(b/'upgrade-manifest.json'),'driverSha256':sha(r/'root-hs2-parallel.py'),'files':files,'baselineEvidence':str(g4/'root-g4/result-upgrade-20261021T223430Z.json'),'prerequisites':['Fresh read-only preflight, no active upgrade lock, exact old pins/receipt; no auto retry of attempts.','Reviewed control package and privacy challenge support active before enabling hosted challenge config.','Installed challenge release/profile/declaration ACL must remain verified.','Orders remain held; no CA requests, contracts, or wallet operations.'],'limitations':['Shield policy only; no new SNP measurements or TCB pins fabricated.','No new public endpoints, provider outage or cold-recovery proof from this package.']}
(r/'inventory.json').write_text(json.dumps(inventory,indent=2)+'\n');print(json.dumps({'manifest':inventory['manifestSha256'],'driver':inventory['driverSha256'],'files':len(files)}))
