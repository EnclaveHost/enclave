from pathlib import Path
import subprocess,json,os,hashlib,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
for n,h in pins.items(): assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time()},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
base=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p/'frozen'),str(p/'frozen'),'--bind',str(p/'target'),str(p/'target'),'--chdir',str(p/'frozen')]
env=dict(os.environ,CARGO_TARGET_DIR=str(p/'target'),CARGO_NET_OFFLINE='true',RUSTUP_TOOLCHAIN='nightly-x86_64-unknown-linux-gnu')
start=time.monotonic()
r=subprocess.run(base+['/home/steven/.cargo/bin/cargo','build','--release','--target','wasm32-wasip2','--offline','-j1'],env=env,timeout=90,stdout=(p/'BUILD.log').open('x'),stderr=subprocess.STDOUT)
assert r.returncode==0
wasm=p/'target/wasm32-wasip2/release/enclave_rpc_preview.wasm'
r=subprocess.run(base+['/home/steven/.cargo/bin/wasm-tools','validate',str(wasm)],timeout=10);assert r.returncode==0
for n,h in pins.items(): assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h
result={'compileValidatePass':True,'bytes':wasm.stat().st_size,'sha256':hashlib.sha256(wasm.read_bytes()).hexdigest(),'elapsed':time.monotonic()-start,'rpcReady':False}
(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result))
