"""Pure local assembly. No SSH, COW/image reads, admission or native launch."""
from pathlib import Path
import json,hashlib,shutil,ast
p=Path(__file__).resolve().parent;s=p/'source';dest=p/'runtime'
sha=lambda q:hashlib.sha256(q.read_bytes()).hexdigest()
assert not dest.exists(),'immutable-output-exists'
for name,h in json.loads((p/'SOURCE-PINS.json').read_text()).items():assert sha(p/name)==h,'source-pin-drift:'+name
for q in s.glob('*.py'):ast.parse(q.read_text(),filename=str(q))
dest.mkdir(mode=0o700)
for q in s.iterdir():
 if q.is_file():shutil.copy2(q,dest/q.name)
m=json.loads((dest/'MANIFEST.json').read_text())
remote=('capture-remote.py','transport-helpers.py','client-operations.py','recovery-progress.py','client-main.py')
local=('capture-local.py','backing-policy.py','run-body.py')
(dest/'remote-program.py').write_text('\n'.join((dest/n).read_text() for n in remote))
(dest/'run.py').write_text('\n'.join((dest/n).read_text() for n in local))
m['programSha256']=sha(dest/'remote-program.py')
for key,name in [('manifest.json','payload-manifest.json'),('chain_service.py','trial-chain-service.py'),('disks.json','disks.json')]:
 m['payloadFiles'][key].update(localSource=str(dest/name),sha256=sha(dest/name),bytes=(dest/name).stat().st_size)
(dest/'MANIFEST.json').write_text(json.dumps(m,indent=2)+'\n')
for q in dest.glob('*.py'):ast.parse(q.read_text(),filename=str(q))
assert (dest/'remote-program.py').stat().st_size<=131072,'remote-program-cap'
(dest/'PINS.json').write_text(json.dumps({q.name:sha(q) for q in sorted(dest.iterdir()) if q.is_file()},indent=2)+'\n')
print(json.dumps({'assembledOnly':True,'runtime':str(dest),'pinsSha256':sha(dest/'PINS.json'),'nativeAdmitted':False}))
