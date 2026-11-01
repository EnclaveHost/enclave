from pathlib import Path
import json,hashlib,subprocess,time,shutil,os
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'SOURCE-PINS.json').read_text());patch=json.loads((p/'PATCH-PIN.json').read_text())
def verify():
 assert hashlib.file_digest((p/'output/protoc').open('rb'),'sha256').hexdigest()=='507a3f321ae7df61982468712aa78531842ea88e3a3f6934bb9dcbd47881b921'
 assert hashlib.sha256((s/patch['path']).read_bytes()).hexdigest()==patch['sha256']
 for n,h in pins.items():assert hashlib.file_digest((p/'frozen'/n).open('rb'),'sha256').hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time(),'compilerOnly':True},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-1664>=max(27648,a['floorMiB']);assert shutil.disk_usage(p).free>=20<<30;(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
(p/'output/build').mkdir()
registry=p/'output/registry-src';registry.mkdir()
original=Path('/home/steven/.cargo/registry/src')
for index in original.iterdir():
 if index.is_dir():
  target=registry/index.name;target.mkdir()
  for package in index.iterdir():
   if package.is_dir():(target/package.name).symlink_to('/registry-source/'+index.name+'/'+package.name)

cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/sbin','/sbin','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/frozen','--ro-bind',str(p/'entry.py'),'/entry.py','--ro-bind',str(p/'SOURCE-PINS.json'),'/pins.json','--ro-bind',str(p/'PATCH-PIN.json'),'/patch-pin.json','--ro-bind',str(s/patch['path']),'/current.patch','--bind',str(p/'output'),'/output','--bind',str(p/'output/build'),'/build','--ro-bind','/home/steven/.rustup/toolchains/1.96.0-x86_64-unknown-linux-gnu','/tools','--ro-bind','/home/steven/.cargo/registry/cache','/cargo/registry/cache','--ro-bind','/home/steven/.cargo/registry/index','/cargo/registry/index','--ro-bind','/home/steven/.cargo/registry/src','/registry-source','--bind',str(p/'output/registry-src'),'/cargo/registry/src','--ro-bind','/home/steven/.cargo/git','/cargo/git','--ro-bind',str(p/'output/protoc'),'/protoc','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--chdir','/build']
env={'PROTOC':'/protoc','PATH':'/tools/bin:/usr/bin:/bin','HOME':'/tmp','CARGO_HOME':'/cargo','CARGO_TARGET_DIR':'/output/target','RUSTC':'/tools/bin/rustc','RUSTDOC':'/tools/bin/rustdoc','CARGO_NET_OFFLINE':'true','CARGO_BUILD_JOBS':'1','CARGO_PROFILE_TEST_DEBUG':'0','CARGO_PROFILE_TEST_OPT_LEVEL':'0','CARGO_PROFILE_TEST_INCREMENTAL':'false','LC_ALL':'C'}
for k,v in env.items():cmd+=['--setenv',k,v]
cmd+=['/usr/bin/python3','-B','/entry.py'];(p/'BUILD-COMMAND.json').write_text(json.dumps(cmd,indent=2)+'\n');started=time.monotonic()
with (p/'qualification.log').open('x') as log:
 os.dup2(log.fileno(),1);os.dup2(log.fileno(),2)
 os.execv(cmd[0],cmd)
