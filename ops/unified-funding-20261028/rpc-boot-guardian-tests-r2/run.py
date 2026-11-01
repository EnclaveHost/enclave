from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'privatePIDNamespaceOnly':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
compile=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--symlink','usr/bin','/bin','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str(p/'compile.py'),'/compile.py','--bind',str(p/'output'),'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--setenv','PATH','/usr/bin:/bin','/usr/bin/python3','-B','/compile.py']
commands=[('compile',compile),('guardian',['/usr/bin/python3','-B',str(p/'frozen/test/rpc-server/qualify_boot_guardian.py'),str(p/'output/guardian-fixture'),str(p/'output/ACTUAL-GUARDIAN.jsonl')])]
start=time.monotonic();rows=[]
for label,cmd in commands:
 (p/(label+'-COMMAND.json')).write_text(json.dumps(cmd)+'\n')
 with (p/(label+'.log')).open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=max(.01,110-(time.monotonic()-start)))
 rows.append({'phase':label,'exit':r.returncode})
 if r.returncode:break
verify();artifacts={str(x.relative_to(p/'output')):{'bytes':x.stat().st_size,'sha256':hashlib.sha256(x.read_bytes()).hexdigest()} for x in (p/'output').rglob('*') if x.is_file()}
result={'phases':rows,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'artifacts':artifacts,'booted':False,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert all(x['exit']==0 for x in rows)
