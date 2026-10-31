from pathlib import Path
import os,sys,json,hashlib,base64,time
from capture_local import capture
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
phase=sys.argv[1];assert phase in ('create','stage','verify')
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
   if phase=='create':assert v['created'] is True
   else:
    assert v['verified'] is True and v['executed'] is False
    expected=json.loads((p/'ARTIFACTS.json').read_text());assert sorted(v['files'],key=lambda x:x['name'])==expected
   r['success']=True
  except Exception:r['reason']='invalid-or-mismatched-receipt'
(p/(phase+'-RESULT.json')).write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'phase':phase,'success':r['success'],'rc':r['rc'],'reason':r['reason']}));sys.exit(0 if r['success'] else 1)
