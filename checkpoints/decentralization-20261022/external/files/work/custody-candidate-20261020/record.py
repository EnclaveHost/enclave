from pathlib import Path
import hashlib,json,datetime,subprocess,re
W=Path('/home/steven/Documents/Codex/2026-10-18/wo');src=W/'work/custody-candidate-source-20261020';a=W/'work/custodian-shield-ee8beb38';b=W/'work/custodian-shield-ee8beb38-repro'
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
 return h.hexdigest()
m=json.loads((a/'manifest.json').read_text());prov=json.loads((W/'work/custody-candidate-20261020/claude-provenance-prebuild.json').read_text())
assert m['commit']=='ee8beb38a0adb5dba5fcee15b39f54b9015296cb'
assert not subprocess.check_output(['git','status','--porcelain'],cwd=src).strip()
assert prov['buildSourceCheck']['clean'] and prov['nodeModules']['allMatchLock'] and prov['measured']['equalsPreflight']
assert m['files']['/opt/custodian/custodian.mjs']==prov['bundles']['daemonSha256'] and m['files']['/opt/metal/gsup.mjs']==prov['bundles']['gsupSha256']
for f in prov['bundleInputs']['files']:assert sha(src/f['path'])==f['sha256'],f['path']
files={}
for n in ('vmlinuz','initramfs.cpio.gz','cmdline','manifest.json'):
 h1,h2=sha(a/n),sha(b/n);assert h1==h2,n
 files[n]={'sha256':h1,'bytes':(a/n).stat().st_size,'equalAcrossBuilds':True}
assert files['initramfs.cpio.gz']['sha256']==m['initramfs']['sha256']
stats=[]
for label in ('coordinator-b1','coordinator-b2'):
 p=W/f'work/custody-candidate-20261020/claude-build-{label}.log';t=p.read_text()
 assert re.search(r'exit=0 .*stopped=no',t) and 'oom_kill 0' in t
 stats.append({'label':label,'logSHA256':sha(p),'peakBytes':int(re.search(r'peak_bytes=(\d+)',t)[1]),'minimumMemAvailableKiB':int(re.search(r'minMemAvailable_kB=(\d+)',t)[1]),'memoryLimitMiB':2048,'swapLimitBytes':0,'oomKills':0,'exit':0})
compat1=W/'work/custody-candidate-20261020/snp-compat.log';compat2=W/'work/custody-candidate-20261020/independent-lifecycle-768.log'
assert 'ok 1 - custody v2 end to end:' in compat1.read_text()
assert '# pass 1' in compat2.read_text() and '[memory-guard] exit=0' in compat2.read_text()
limits=['One builder and toolchain; no independent third-party reproduction.','SNP lifecycle tests use real local contracts and cryptography with simulated hardware attestation.','No hardware activation, owner code approval, committee formation or production secret migration.','Trusted proxy 10.0.2.2 is measured but still requires observation on the actual guest transport.','AMD TPM root selection and T0-hv host trust are explicit; owners must admit Shield rules.','Outstanding CLI/editor feature work is separate; this artifact does not prove complete feature parity.']
j={'format':'enclave-custodian-shield-candidate/1','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':m['commit'],'buildDirectories':[str(a.relative_to(W)),str(b.relative_to(W))],'files':files,'manifest':m,'reproducible':True,'resources':stats,'provenance':prov,'compatibility':{'snpExistingLifecycle':'passed','independentLifecycle':'passed','logs':[{'file':str(p.relative_to(W)),'sha256':sha(p)}for p in (compat1,compat2)],'resourceNote':'Combined 512MiB run passed the SNP test, then stopped at527MiB during Rust compilation for the second test. Only the unfinished lifecycle test reran at768MiB and passed at572MiB peak.'},'hardwareActivated':False,'limits':limits}
(W/'outputs/custodian-shield-candidate.json').write_text(json.dumps(j,indent=2)+'\n')
slim={k:v for k,v in j.items() if k not in ('buildDirectories','provenance','compatibility')};slim['provenance']={'rootLockSHA256':prov['lock']['sha256'],'bundleInputCount':len(prov['bundleInputs']['files']),'nodePackagesMatchLock':True,'buildSourceClean':True,'recordSHA256':sha(W/'outputs/custodian-shield-candidate.json')};slim['compatibility']={'snpExistingLifecycle':'passed','independentLifecycle':'passed','hardwareAttestation':'simulated'}
p=W/'work/enclave/custody/v2/candidates/shield-ee8beb38.json';p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(slim,indent=2)+'\n')
print(json.dumps({'image':files['initramfs.cpio.gz'],'measurement':m['measurement'],'repeatable':True,'compatibility':'2 lifecycle tests passed','hardwareActivated':False}))
