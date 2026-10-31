from pathlib import Path
import os,sys,json,hashlib,base64,time
from capture_local import capture
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
phase=sys.argv[1];assert phase in ('create','stage','verify')
import subprocess,datetime
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source')
ad=json.loads((p.parent/'rpc-clock-target-admission-r3/storage-RESULT.json').read_text());assert ad['rc']==0 and ad['failure'] is None and time.time()-ad['at']<300
o=ad['observation'];assert o['before']==o['after'] and o['nodeExit']==0 and o['manager']['completeTransport'] and not o['manager']['errors'] and o['bootNative']=='1a04e76600e411f1a395e342df676a80'
assert o['physicalAfter']['freeBytes']>=62709039104 and len(o['physicalAfter']['vms'])==4 and not o['clockStage']['contractExists'] and not o['clockStage']['intentExists']
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/(phase+'-LOCAL-ADMISSION.json')).write_text(json.dumps(a)+'\n')
for name,digest in json.loads((p/'PINS.json').read_text()).items():
 assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest,name
spec=json.loads((p/'SPEC.json').read_text())
prior={'stage':'create','verify':'stage'}
if phase in prior:assert json.loads((p/(prior[phase]+'-RESULT.json')).read_text())['success'] is True
with(p/(phase+'-INTENT.json')).open('x')as f:json.dump({'at':time.time(),'phase':phase,'noRetry':True,'vmChanged':False},f);f.flush();os.fsync(f.fileno())
options=['-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none']
if phase=='stage':
 argv=['/usr/bin/scp',*options,*[str(p/'bundle'/n) for n in json.loads((p/'FILES.json').read_text())],'minipc:'+spec['root']+'/']
else:
 body=(p/(phase+'.ps1')).read_text()
 command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(body.encode('utf-16le')).decode();assert len(command)<30000
 argv=['/usr/bin/ssh','-T',*options,'minipc',command]
r=capture(argv,40,limit=16384)
(p/(phase+'.stdout')).write_text(r.pop('stdout'));(p/(phase+'.stderr')).write_text(r.pop('stderr'))
r.update({'at':time.time(),'phase':phase,'success':False,'noRetry':True,'vmChanged':False})
if r['rc']==0 and r['reason'] is None:
 if phase=='stage':r['success']=True
 else:
  try:
   v=json.loads((p/(phase+'.stdout')).read_text().lstrip('\ufeff'));r['observation']=v
   assert v['root'].replace('\\','/').lower()==spec['root'].lower() and v['nativeAttempted'] is False
   if phase=='create':assert v['prepared'] is True
   else:
    assert v['verified'] is True and v['executed'] is False
    expected=json.loads((p/'ARTIFACTS.json').read_text());assert sorted(v['files'],key=lambda x:x['name'])==expected
   r['success']=True
  except Exception:r['reason']='invalid-or-mismatched-receipt'
(p/(phase+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'phase':phase,'success':r['success'],'rc':r['rc'],'reason':r['reason']}));sys.exit(0 if r['success'] else 1)
