from pathlib import Path
import subprocess,json,hashlib,zipfile
p=Path(__file__).resolve().parent;s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'COLLECT-ADMISSION.json').write_text(json.dumps(a)+'\n')
def gh(args):return subprocess.check_output(['/usr/sbin/gh']+args,text=True,timeout=30)
r=json.loads(gh(['run','view','41328193864','--repo','EnclaveHost/enclave','--json','databaseId,headSha,status,conclusion,jobs,url']));assert r['status']=='completed' and r['headSha']=='2907cb5e5493bec8d94fd7113f323828c61d934a';(p/'CI-RUN.json').write_text(json.dumps(r,indent=2)+'\n')
a=json.loads(gh(['api','repos/EnclaveHost/enclave/actions/runs/41328193864/artifacts']));(p/'ARTIFACTS.json').write_text(json.dumps(a,indent=2)+'\n')
xs=[x for x in a['artifacts'] if x['name']=='rpc-native-manager-process-results'];assert len(xs)==1;x=xs[0];assert not x['expired'] and 0<x['size_in_bytes']<=1048576
z=p/'result.zip'
with z.open('xb') as f:subprocess.run(['/usr/sbin/gh','api','repos/EnclaveHost/enclave/actions/artifacts/'+str(x['id'])+'/zip'],stdout=f,stderr=subprocess.PIPE,check=True,timeout=30)
assert z.stat().st_size<=1048576
(p/'ARTIFACT-ZIP-SHA256.json').write_text(json.dumps({'bytes':z.stat().st_size,'sha256':hashlib.sha256(z.read_bytes()).hexdigest()})+'\n')
allowed={'harness-compile.out','harness-compile.err','process-composition.out','process-composition.err','process-results.json','pins.json','source-pins.json','artifact.json','owned-entry.exe'}
with zipfile.ZipFile(z) as archive:
 infos=archive.infolist();assert set(i.filename for i in infos)<=allowed and len(set(i.filename for i in infos))==len(infos) and sum(i.file_size for i in infos)<=1048576
 for i in infos:assert i.file_size<=(262144 if i.filename=='owned-entry.exe' else 65536)
 out=p/'artifact';out.mkdir()
 for i in infos:(out/i.filename).write_bytes(archive.read(i))
if r['conclusion']!='success':
 (p/'FAILED.json').write_text(json.dumps({'run':r['databaseId'],'head':r['headSha'],'conclusion':r['conclusion'],'files':[i.filename for i in infos]},indent=2)+'\n');raise SystemExit(0)
assert set(i.filename for i in infos)==allowed
art=json.loads((out/'artifact.json').read_text(encoding='utf-8-sig'));data=(out/'owned-entry.exe').read_bytes();assert art['sha256']==hashlib.sha256(data).hexdigest() and art['bytes']==len(data)
assert art['candidateSha256']=='22e033958a4bbd695342b74248079ddf90b2788f1efe8f83def023710c4deb6f' and art['candidateRun']==41327394900 and art['nativeProviderExecuted']==False
pins=json.loads((p/'SOURCE-PINS.json').read_text());used=json.loads((out/'source-pins.json').read_text(encoding='utf-8-sig'));assert used['head']==r['headSha'] and used['files']==pins and len(pins)==44
for n,h in pins.items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
rows=json.loads((out/'pins.json').read_text(encoding='utf-8-sig'));verified=[]
for row in rows:
 path=row['Path'].replace('\\','/');matches=[n for n in pins if path.endswith('/'+n)]
 if matches:
  assert len(matches)==1;n=matches[0];assert row['Hash'].lower()==pins[n];verified.append(n)
assert len(verified)==2
output=(out/'process-composition.out').read_text(encoding='utf-8-sig');assert len([l for l in output.splitlines() if l.startswith('PASS ')])==5 and 'TOTAL 5 PASS' in output
held=[json.loads(l[5:]) for l in output.splitlines() if l.startswith('HELD ')];exact=[json.loads(l[6:]) for l in output.splitlines() if l.startswith('EXACT ')];assert len(held)==len(exact)==1
assert held[0]['pid']==exact[0]['blockedPid'] and held[0]['creation']==exact[0]['blockedCreation'] and exact[0]['blockedExit']==125 and exact[0]['nodeExit']==0 and exact[0]['jobBytes']==268435456 and exact[0]['member'] and exact[0]['limits']
(p/'VERIFIED.json').write_text(json.dumps({'run':r['databaseId'],'head':r['headSha'],'compiledPins':verified,'sourcePins':len(pins),'fixture':art,'distinctComposedPass':5,'held':held[0],'exact':exact[0],'targetAdmission':False},indent=2)+'\n')
