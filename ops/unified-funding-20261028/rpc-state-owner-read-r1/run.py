from pathlib import Path
import subprocess,json,hashlib,time
p=Path(__file__).resolve().parent
pins=json.loads((p/'PINS.json').read_text());manifest=json.loads((p/'MANIFEST.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((p/n).read_bytes()).hexdigest()==h
verify()
for unit in ['enclave-rpc-production-vm.service','enclave-rpc-production-guard.service']:
 r=subprocess.run(['systemctl','--user','show',unit,'-p','MainPID','-p','ActiveState'],capture_output=True,text=True,check=True,timeout=3);assert 'MainPID=0' in r.stdout and 'ActiveState=inactive' in r.stdout
cmd=['/usr/bin/bwrap','--unshare-all','--uid','0','--gid','0','--die-with-parent','--new-session','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev','--dev-bind','/dev/fuse','/dev/fuse','--tmpfs','/tmp','--ro-bind',str(p),'/job','--clearenv','--setenv','PATH','/usr/bin:/usr/sbin:/bin','--setenv','HOME','/tmp']
for row in manifest['inputs']:cmd+=['--ro-bind',row['path'],row['path']]
cmd+=['/usr/bin/python3','-I','-B','/job/read_owners.py','/job/MANIFEST.json']
start=time.monotonic()
with (p/'stdout.txt').open('x') as out,(p/'stderr.txt').open('x') as err:r=subprocess.run(cmd,stdout=out,stderr=err,timeout=100)
verify();result={'exit':r.returncode,'seconds':time.monotonic()-start,'pinsUnchanged':True}
if r.returncode==0:result['observation']=json.loads((p/'stdout.txt').read_text())
(p/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');raise SystemExit(r.returncode)
