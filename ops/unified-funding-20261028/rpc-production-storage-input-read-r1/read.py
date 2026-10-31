from pathlib import Path
import json,subprocess,importlib.util,os,hashlib,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source'
pins=json.loads((p/'PINS.json').read_text())
for n,h in pins.items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
spec=importlib.util.spec_from_file_location('volume',s/'rpc/server/volume_export.py');v=importlib.util.module_from_spec(spec);spec.loader.exec_module(v);v.tool_pins()
roles={'l1':['/vm/enclave-volumes/rpc-control-l1-client-r6/overlay.qcow2','/vm/enclave-volumes/rpc-production/l1-origin.qcow2'],'base':['/mnt/usb/enclave-rpc-production/base-origin.qcow2']};result={}
with (p/'INTENT.json').open('x') as f:json.dump({'at':time.time(),'roles':roles,'readOnly':True},f);f.flush();os.fsync(f.fileno())
for role,paths in roles.items():
 before=[]
 for name in paths:v.directory(Path(name).parent);before.append([name,v.metadata(name)])
 r=subprocess.run(['/usr/bin/qemu-img','info','--output=json','--backing-chain',paths[0]],capture_output=True,text=True,timeout=5)
 assert len(r.stdout)+len(r.stderr)<=65536
 (p/(role+'-QEMU.json')).write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout,'stderr':r.stderr})+'\n');assert r.returncode==0
 rows=json.loads(r.stdout);v.validate_chain(rows,[Path(x) for x in paths],4000000000000)
 assert before==[[name,v.metadata(name)] for name in paths]
 fs=os.statvfs(Path(paths[0]).parent);result[role]={'originals':before,'chainValidated':True,'freeBytes':fs.f_bavail*fs.f_frsize}
(p/'RESULT.json').write_text(json.dumps({'at':time.time(),'roles':result,'readOnly':True},indent=2)+'\n')
