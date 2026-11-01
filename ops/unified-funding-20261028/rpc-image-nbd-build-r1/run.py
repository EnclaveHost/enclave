from pathlib import Path
import json,hashlib,subprocess,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';k=Path('/home/steven/Documents/Codex/2026-10-23/it/work/nucbox-desktop-v2/kernel-src');pins=json.loads((p/'KERNEL-PINS.json').read_text())
def verify():
 for n,h in pins.items():assert hashlib.sha256((k/n).read_bytes()).hexdigest()==h,n
 assert hashlib.sha256((p/'output/module/nbd.c').read_bytes()).hexdigest()==pins['drivers/block/nbd.c']
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'compileOnly':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(k),'/kernel','--ro-bind',str(k/'vmlinux.symvers'),'/kernel/Module.symvers','--bind',str(p/'output'),'/output','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','ARCH','x86_64','--setenv','KBUILD_BUILD_TIMESTAMP','1970-01-01T00:00:00Z','--setenv','KBUILD_BUILD_USER','rpc','--setenv','KBUILD_BUILD_HOST','builder','--setenv','KBUILD_BUILD_VERSION','1','--setenv','KCFLAGS','-ffile-prefix-map=/kernel=/kernel -ffile-prefix-map=/output/module=/module','/usr/bin/make','-j1','-C','/kernel','M=/output/module','modules']
(p/'BUILD-COMMAND.json').write_text(json.dumps(cmd,indent=2)+'\n');start=time.monotonic()
with (p/'build.log').open('x') as f:r=subprocess.run(cmd,stdout=f,stderr=f,timeout=90)
verify();module=p/'output/module/nbd.ko';result={'exit':r.returncode,'elapsed':time.monotonic()-start,'sourcePins':len(pins),'pinsUnchanged':True,'loaded':False}
if module.exists():result['module']={'sha256':hashlib.sha256(module.read_bytes()).hexdigest(),'bytes':module.stat().st_size}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0
