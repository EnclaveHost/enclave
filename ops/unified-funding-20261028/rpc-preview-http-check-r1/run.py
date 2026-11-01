from pathlib import Path
import subprocess,json,os,hashlib,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
for n,h in pins.items(): assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time()},f)
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
wasm=p.parent/'rpc-preview-publish-r2/target/wasm32-wasip2/release/enclave_rpc_preview.wasm'
assert hashlib.sha256(wasm.read_bytes()).hexdigest()=='e5a1c1621a8f6f6b9ccbbf026c54aa0b79dddcc953f7d6698d8afd771b27558a'
cmd=['/usr/bin/bwrap','--die-with-parent','--unshare-user','--unshare-net','--ro-bind','/','/','--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',str(p),str(p),'/usr/bin/python3','-B',str(p/'check.py'),str(wasm),str(p)]
r=subprocess.run(cmd,capture_output=True,text=True,timeout=25)
(p/'CHECK.log').write_text(r.stdout+r.stderr);assert r.returncode==0
(p/'RESULT.json').write_text(r.stdout)
