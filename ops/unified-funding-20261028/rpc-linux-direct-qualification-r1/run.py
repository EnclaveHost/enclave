from pathlib import Path
import json,hashlib,subprocess,importlib.util,time
p=Path(__file__).resolve().parent;u=p.parent;s=u.parent/'source';root=Path(json.loads((u/'rpc-linux-direct-preparation-r1/SPEC.json').read_text())['root'])
pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h,n
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
verify()
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'productionVm':False},f)
r=subprocess.run(['/usr/bin/node',str(p/'frozen/rpc/server/observe_resources.mjs'),str(u/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=2,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and a['unreadUnits']==0 and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'TEST.log').open('xb') as log:r=subprocess.run(['/usr/bin/python3','-B',str(p/'frozen/test/rpc-guest/test_linux_direct.py')],stdout=log,stderr=log,timeout=25)
assert r.returncode==0,'native qualification failed; retained TEST.log'
verify()
spec=importlib.util.spec_from_file_location('seed',p/'frozen/rpc/guest/prepare_direct_seed.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
r=m.build(root,'rpc-owned-'+json.loads((u/'rpc-linux-direct-preparation-r1/SPEC.json').read_text())['nonce'],{'/opt/enclave-rpc/manifest.json':'8bc81c93fde18234fec42792a15cf854dfc09df22f31ec2825733fce97f24441','/opt/enclave-rpc/chain_service.py':'75c879ec9c5728688beac8cc98ecf1410c38f29c144b27fabd8b42ea60cfbc92'})
verify();(p/'RESULT.json').write_text(json.dumps({'nativeQualificationPass':True,'seed':r,'rpcReady':False})+'\n')
