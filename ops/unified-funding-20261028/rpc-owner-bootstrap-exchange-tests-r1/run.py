from pathlib import Path
import json,subprocess,hashlib,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for n,h in pins.items():
  assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h
  assert hashlib.sha256((p/'frozen'/n).read_bytes()).hexdigest()==h
verify()
a=json.loads(subprocess.check_output(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],text=True,timeout=3));assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'ATTEMPT.json').open('x') as f:json.dump({'once':True,'at':time.time()},f)
cmd=['/usr/bin/bwrap','--unshare-all','--die-with-parent','--new-session','--clearenv','--uid','0','--gid','0','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'openssl.cnf'),'/etc/ssl/openssl.cnf','--ro-bind',str(p/'frozen'),'/src','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--tmpfs','/run','--chdir','/src','--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp','/usr/bin/python3','-B','/src/test/rpc-server/test_owner_bootstrap_exchange.py']
(p/'TEST-COMMAND.json').write_text(json.dumps(cmd)+'\n');start=time.monotonic()
with (p/'test.log').open('x') as log:r=subprocess.run(cmd,stdout=log,stderr=log,timeout=90)
verify();result={'exit':r.returncode,'elapsed':time.monotonic()-start,'pins':len(pins),'pinsUnchanged':True,'resourceAndServiceEnvelopes':'mocked','nodeAttestationAndIssuer':'notExecuted','actualProtectedPreparationAndPipes':True,'ownerServiceAndSignedOffer':'mocked','production':False};(p/'RESULT.json').write_text(json.dumps(result)+'\n');print(json.dumps(result));assert r.returncode==0
