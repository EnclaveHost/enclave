from pathlib import Path
import json,hashlib,os,subprocess,time
p=Path(__file__).resolve().parent;u=p.parent;s=u.parent/'source';spec=json.loads((u/'rpc-linux-direct-preparation-r1/SPEC.json').read_text());spec.update(json.loads((u/'rpc-linux-direct-qualification-r3/NEW-ATTEMPT.json').read_text()));root=Path(spec['root'])
def digest(path):
 with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
with (p/'INTENT.json').open('x') as f:json.dump({'at':time.time(),'vmStarted':False},f)
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],timeout=2));assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
assert json.loads((u/'rpc-linux-direct-seed-r2/RESULT.json').read_text())['nativeQualificationPass']
for n,h in json.loads((u/'rpc-linux-direct-qualification-r3/PINS.json').read_text()).items():assert digest(s/n)==h
cfg={'root':str(root),'unit':'enclave-rpc-linux-direct-'+spec['nonce']+'.service','instance':'rpc-owned-'+spec['nonce'],'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'resourceConfig':str(u/'rpc-export-current-admission-read-r2/CONFIG.json'),'sshPort':22496,'chains':{},'pins':{}}
old=json.loads((u/'rpc-production-storage-input-read-r1/RESULT.json').read_text())['roles']
for role in ['l1','base']:
 chain={'virtualBytes':4000000000000,'originals':[]}
 for name,expected in old[role]['originals']:
  path=Path(name);st=path.lstat();actual=[st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns];assert actual==expected
  with path.open('rb') as f:header=hashlib.sha256(f.read(104)).hexdigest()
  row={'path':name,'metadata':actual,'headerSha256':header}
  if 'rpc-control-l1-client-r6/' in name:
   receipt=json.loads((u/'rpc-el-r6-frozen-backing-read-r1/RESULT.json').read_text());assert header==receipt['header104Sha256'];row['sha256']=receipt['sha256']
  chain['originals'].append(row)
 cfg['chains'][role]=chain
paths=[s/'rpc/linux_direct.py',s/'rpc/server/volume_export.py',s/'rpc/server/observe_resources.mjs',Path(cfg['resourceConfig']),Path('/usr/bin/node'),Path('/usr/bin/qemu-img'),Path('/usr/sbin/qemu-system-x86_64'),Path('/usr/bin/bwrap'),Path('/usr/bin/ssh'),root/'boot.vhdx',root/'direct-seed/seed.iso']
cfg['pins']={str(path):digest(path) for path in paths};assert cfg['pins'][str(root/'boot.vhdx')]==spec['sha256'];assert cfg['pins'][str(root/'direct-seed/seed.iso')]==json.loads((u/'rpc-linux-direct-seed-r2/RESULT.json').read_text())['seed']['seedSha256']
with (root/'CONTRACT.json').open('x') as f:json.dump(cfg,f,indent=2);f.flush();os.fsync(f.fileno())
(root/'CONTRACT.json').chmod(0o600)
(p/'PUBLIC-CONTRACT.json').write_text(json.dumps(cfg,indent=2)+'\n');(p/'RESULT.json').write_text(json.dumps({'contractSha256':digest(root/'CONTRACT.json'),'vmStarted':False,'originalIdentityMatched':True})+'\n')
