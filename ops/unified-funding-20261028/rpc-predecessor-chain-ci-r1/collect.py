from pathlib import Path
import json,subprocess,hashlib
p=Path(__file__).resolve().parent
s=p.parent.parent/'source'
def gh(*args):
 return subprocess.check_output(['/usr/sbin/gh',*args],text=True,timeout=30)
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3))
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'COLLECT-ADMISSION.json').write_text(json.dumps(a)+'\n')

for label,run,name in [('startup','41256957688','rpc-startup-controller-results'),('definition','41256960182','rpc-owned-definition-results')]:
 r=json.loads(gh('run','view',run,'--repo','EnclaveHost/enclave','--json','status,conclusion,headSha,jobs'))
 assert r['status']=='completed' and r['conclusion']=='success' and r['headSha']=='83f6793fd202e95520e453746923cf4ccde6f1b2'
 (p/(label+'-RUN.json')).write_text(json.dumps(r,indent=2)+'\n')
 art=json.loads(gh('api','repos/EnclaveHost/enclave/actions/runs/'+run+'/artifacts'))
 rows=[x for x in art['artifacts'] if x['name']==name]
 assert len(rows)==1 and not rows[0]['expired'] and 0<rows[0]['size_in_bytes']<=1048576
 (p/(label+'-ARTIFACT.json')).write_text(json.dumps(rows[0],indent=2)+'\n')
 dest=p/(label+'-download');assert not dest.exists()
 gh('run','download',run,'--repo','EnclaveHost/enclave','--name',name,'--dir',str(dest))
 files=list(dest.iterdir());assert all(x.is_file() and not x.is_symlink() for x in files)
 assert sum(x.stat().st_size for x in files)<=1048576
 print(json.dumps({'label':label,'conclusion':r['conclusion'],'files':[x.name for x in files]}))
