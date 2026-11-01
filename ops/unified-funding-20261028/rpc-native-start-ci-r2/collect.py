from pathlib import Path
import subprocess,json,hashlib,zipfile
p=Path(__file__).resolve().parent;s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'COLLECT-ADMISSION.json').write_text(json.dumps(a)+'\n')
def gh(args):return subprocess.check_output(['/usr/sbin/gh']+args,text=True,timeout=30)
r=json.loads(gh(['run','view','41336671277','--repo','EnclaveHost/enclave','--json','databaseId,headSha,status,conclusion,jobs,url']));assert r['status']=='completed' and r['headSha']=='a553e30e7b0f8dce517592fb12a4b46dd7fae578';(p/'CI-RUN.json').write_text(json.dumps(r,indent=2)+'\n')
a=json.loads(gh(['api','repos/EnclaveHost/enclave/actions/runs/41336671277/artifacts']));(p/'ARTIFACTS.json').write_text(json.dumps(a,indent=2)+'\n')
xs=[x for x in a['artifacts'] if x['name']=='rpc-native-start-results'];assert len(xs)==1;x=xs[0];assert not x['expired'] and 0<x['size_in_bytes']<=1048576
z=p/'result.zip'
with z.open('xb') as f:subprocess.run(['/usr/sbin/gh','api','repos/EnclaveHost/enclave/actions/artifacts/'+str(x['id'])+'/zip'],stdout=f,stderr=subprocess.PIPE,check=True,timeout=30)
assert z.stat().st_size<=1048576
(p/'ARTIFACT-ZIP-SHA256.json').write_text(json.dumps({'bytes':z.stat().st_size,'sha256':hashlib.sha256(z.read_bytes()).hexdigest()})+'\n')
allowed={'toolchain-preflight.json','toolchain.json','harness-compile.out','harness-compile.err','worker-harness.out','worker-harness.err','worker-compile.out','worker-compile.err','process-results.json','pins.json','artifact.json','worker-artifact.json','owned-entry.exe','native-worker.exe','artifact-bound-failure.json','system-worker.exe','system-worker-compile.out','system-worker-compile.err','system-worker-artifact.json'}
with zipfile.ZipFile(z) as archive:
 infos=archive.infolist();assert set(i.filename for i in infos)<=allowed and sum(i.file_size for i in infos)<=1048576
 for i in infos:assert i.file_size<=(262144 if i.filename in ['owned-entry.exe','native-worker.exe','system-worker.exe'] else 65536)
 out=p/'artifact';out.mkdir()
 for i in infos:(out/i.filename).write_bytes(archive.read(i))
