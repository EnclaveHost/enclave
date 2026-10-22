from pathlib import Path
import subprocess,os,json,hashlib,tempfile,shutil,datetime
W=Path.cwd();H=W/'work/claude-resumed-20261022/control-package/storage-closeout';O=W/'work/root-storage-preflight-20261022'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(H/'activation/gate-preflight.mjs')=='6792c5a59f15a56288fbf6aed53366567365fcb3469bea9aeb092e195b1d8b94'
assert sha(H/'host-software/MANIFEST.sha256')=='658e5a443480c65db79dbb2dc9ba74f76f53b299d759eed28e44470e52c5bf98'
files=0
for l in (H/'host-software/MANIFEST.sha256').read_text().splitlines():
 h,n=l.split('  ',1);p=H/'host-software/tree'/n;assert p.resolve().is_relative_to((H/'host-software/tree').resolve());assert sha(p)==h,n;files+=1
# Helper's process.exit bypasses its finally. Confine public policy scratch here and clean our own directory explicitly.
tmp=tempfile.mkdtemp(prefix='gate-public-',dir=O);env=dict(os.environ,TMPDIR=tmp)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'filesVerified':files,'roleSha':sha(H/'host-software/tree/network/host-services/storage-indexer-host.mjs')}
try:
 r=subprocess.run(['node',str(H/'activation/gate-preflight.mjs'),'--host-software',str(H/'host-software/tree'),'--endpoint','https://api.enclave.host/t/metal0'],env=env,capture_output=True,text=True,timeout=85)
 out.update(exit=r.returncode,stdout=r.stdout,stderr=r.stderr)
except subprocess.TimeoutExpired as e:out.update(exit=124,error='bounded read timed out')
finally:shutil.rmtree(tmp);out['ownScratchRemoved']=not Path(tmp).exists()
with (O/'gate-result.json').open('x') as f:json.dump(out,f,indent=2)
print(json.dumps(out,indent=2))
raise SystemExit(out['exit'])
