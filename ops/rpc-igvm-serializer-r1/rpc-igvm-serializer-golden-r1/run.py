from pathlib import Path
import json,hashlib,subprocess,time,shutil
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text());mounts=json.loads((p/'MOUNTS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'offlineAssemblyOnly':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);assert shutil.disk_usage(p).free>=18<<30;(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')

cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str(p/'entry.py'),'/entry.py','--ro-bind',str(p/'SPEC.json'),'/spec.json','--bind',str(p/'output'),'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp']
for dest,source in mounts.items():cmd+=['--ro-bind',source,dest]
cmd+=['--chdir','/src','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp','/usr/bin/python3','-B','/entry.py']
(p/'BUILD-COMMAND.json').write_text(json.dumps(cmd,indent=2)+'\n');start=time.monotonic()
with (p/'qualification.log').open('x') as f:r=subprocess.run(cmd,stdout=f,stderr=f,timeout=120)
verify();result={'exit':r.returncode,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'deployed':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0
