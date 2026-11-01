from pathlib import Path
import json,hashlib,subprocess,time,os
p=Path(__file__).resolve().parent;s=p.parent.parent/'source/rpc/controller';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time()},f)
r=subprocess.run(['/usr/bin/node',str(s.parent/'server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
base=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--cap-add','CAP_NET_ADMIN','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'frozen'),str(p/'frozen'),'--bind',str(p/'target'),str(p/'target'),'--bind',str(p/'output'),str(p/'output'),'--chdir',str(p/'frozen')]
env={'PATH':'/home/steven/.cargo/bin:/usr/bin:/bin','HOME':'/home/steven','CARGO_HOME':'/home/steven/.cargo','RUSTUP_HOME':'/home/steven/.rustup','RUSTUP_TOOLCHAIN':'nightly-x86_64-unknown-linux-gnu','CARGO_TARGET_DIR':str(p/'target'),'CARGO_NET_OFFLINE':'true'}
start=time.monotonic()
def run(label,args):
 with (p/(label+'.log')).open('x') as log:
  r=subprocess.run(base+args,env=env,stdout=log,stderr=log,timeout=max(.1,120-(time.monotonic()-start)))
 assert r.returncode==0,label

run('build',['/home/steven/.cargo/bin/cargo','build','--release','--locked','--offline','--target','wasm32-wasip2','-j1'])
wasm=p/'target/wasm32-wasip2/release/rpc-native-controller.wasm'
run('validate',['/home/steven/.cargo/bin/wasm-tools','validate',str(wasm)])
run('test',['/usr/bin/python3','-B','-c',"import subprocess,os;subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True);os.execv('/home/steven/.cargo/bin/cargo',['cargo','test','--locked','--offline','-j1','--','--test-threads=1'])"])
run('wasm-http',['/usr/bin/python3','-B',str(p/'check.py'),str(wasm),str(p/'output')])
verify()
result={'compileValidatePass':True,'nativeTestsPass':True,'elapsed':time.monotonic()-start,'bytes':wasm.stat().st_size,'sha256':hashlib.sha256(wasm.read_bytes()).hexdigest(),'pinsUnchanged':True,'rpcReady':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))
