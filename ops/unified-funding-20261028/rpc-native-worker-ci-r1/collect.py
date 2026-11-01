from pathlib import Path
import subprocess,json,hashlib,zipfile
p=Path(__file__).resolve().parent;s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'COLLECT-ADMISSION.json').write_text(json.dumps(a)+'\n')
def gh(args):return subprocess.check_output(['/usr/sbin/gh']+args,text=True,timeout=30)
r=json.loads(gh(['run','view','41323670407','--repo','EnclaveHost/enclave','--json','databaseId,headSha,status,conclusion,jobs,url']));assert r['status']=='completed' and r['conclusion']=='success' and r['headSha']=='075886126485adee705f54e9baf44ee864dca067';(p/'CI-RUN.json').write_text(json.dumps(r,indent=2)+'\n')
a=json.loads(gh(['api','repos/EnclaveHost/enclave/actions/runs/41323670407/artifacts']));(p/'ARTIFACTS.json').write_text(json.dumps(a,indent=2)+'\n')
xs=[x for x in a['artifacts'] if x['name']=='rpc-native-worker-results'];assert len(xs)==1;x=xs[0];assert not x['expired'] and 0<x['size_in_bytes']<=1048576
z=p/'result.zip'
with z.open('xb') as f:subprocess.run(['/usr/sbin/gh','api','repos/EnclaveHost/enclave/actions/artifacts/'+str(x['id'])+'/zip'],stdout=f,stderr=subprocess.PIPE,check=True,timeout=30)
assert z.stat().st_size<=1048576
(p/'ARTIFACT-ZIP-SHA256.json').write_text(json.dumps({'bytes':z.stat().st_size,'sha256':hashlib.sha256(z.read_bytes()).hexdigest()})+'\n')
allowed={'harness-compile.out','harness-compile.err','worker-harness.out','worker-harness.err','worker-compile.out','worker-compile.err','process-results.json','pins.json','artifact.json','worker-artifact.json','owned-entry.exe','native-worker.exe'}
with zipfile.ZipFile(z) as archive:
 infos=archive.infolist();assert set(i.filename for i in infos)==allowed and len(infos)==12 and sum(i.file_size for i in infos)<=1048576
 for i in infos:assert i.file_size<=(262144 if i.filename in ['owned-entry.exe','native-worker.exe'] else 65536)
 out=p/'artifact';out.mkdir()
 for i in infos:(out/i.filename).write_bytes(archive.read(i))
art=json.loads((out/'artifact.json').read_text(encoding='utf-8-sig'));data=(out/'owned-entry.exe').read_bytes();assert art['sha256']==hashlib.sha256(data).hexdigest() and art['bytes']==len(data)
pins=json.loads((p/'SOURCE-PINS.json').read_text());rows=json.loads((out/'pins.json').read_text(encoding='utf-8-sig'));verified=[]
for row in rows:
 path=row['Path'].replace('\\','/');matches=[n for n in pins if path.endswith('/'+n)]
 if matches:
  assert len(matches)==1;n=matches[0];assert row['Hash'].lower()==pins[n] and hashlib.sha256((s/n).read_bytes()).hexdigest()==pins[n];verified.append(n)
assert len(verified)==14
output=(out/'worker-harness.out').read_text(encoding='utf-8-sig');assert len([l for l in output.splitlines() if l.startswith('PASS ')])==9 and 'TOTAL 9 PASS' in output
(p/'VERIFIED.json').write_text(json.dumps({'run':r['databaseId'],'head':r['headSha'],'compiledPins':verified,'executable':art,'distinctPass':9,'providerMocked':True,'targetAdmission':False},indent=2)+'\n')

worker=json.loads((out/'worker-artifact.json').read_text(encoding='utf-8-sig'));data=(out/'native-worker.exe').read_bytes();assert worker['sha256']==hashlib.sha256(data).hexdigest() and worker['bytes']==len(data) and worker['workerExecuted']==False
(p/'WORKER-VERIFIED.json').write_text(json.dumps(worker,indent=2)+'\n')
