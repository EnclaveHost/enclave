from pathlib import Path
import json,subprocess,hashlib
p=Path(__file__).resolve().parent
s=p.parent.parent/'source'
def gh(*args):
 return subprocess.check_output(['/usr/sbin/gh',*args],text=True,timeout=30)
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-128>=max(27648,a['floorMiB'])
(p/'COLLECT-ADMISSION.json').write_text(json.dumps(a)+'\n')
r=json.loads(gh('run','view','41244651758','--repo','EnclaveHost/enclave','--json','status,conclusion,headSha,jobs'))
assert r['status']=='completed' and r['headSha']=='1a35d90681211bc591bbd1b8705099b0d5dfb00e'
(p/'RUN.json').write_text(json.dumps(r,indent=2)+'\n')
art=json.loads(gh('api','repos/EnclaveHost/enclave/actions/runs/41244651758/artifacts'))
rows=[x for x in art['artifacts'] if x['name']=='rpc-file-fixture-results']
assert len(rows)==1 and not rows[0]['expired'] and 0<rows[0]['size_in_bytes']<=1048576
(p/'ARTIFACT.json').write_text(json.dumps(rows[0],indent=2)+'\n')
assert not (p/'download').exists()
gh('run','download','41244651758','--repo','EnclaveHost/enclave','--name','rpc-file-fixture-results','--dir',str(p/'download'))
files=list((p/'download').iterdir());assert all(x.is_file() and not x.is_symlink() for x in files)
assert sum(x.stat().st_size for x in files)<=1048576
print(json.dumps({'conclusion':r['conclusion'],'files':[x.name for x in files]}))
