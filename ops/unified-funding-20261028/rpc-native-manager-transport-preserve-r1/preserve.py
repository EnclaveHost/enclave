from pathlib import Path
import subprocess,json,hashlib
s=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source');p=Path(__file__).resolve().parent
paths=json.loads((p/'PATHS.json').read_text())
for n,h in json.loads((p/'SOURCE-FREEZE.json').read_text()).items():assert hashlib.sha256((s/n).read_bytes()).hexdigest()==h,n
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(s.parent/'unified-funding-20261028/rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-384>=max(27648,a['floorMiB'])
(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
with (p/'PUSH.log').open('x') as log:
 def run(args):return subprocess.run(args,cwd=s,stdout=log,stderr=log,check=True,timeout=120)

 # Reconcile frozen public source against exact baseline blobs; retain all changes
 # including the failed packaging/protocol versions. Never private runtime files.
 base='7959215405d8b603c2e0ba77b8218cc6c9e5e5a2'
 run(['git','fetch','origin','main'])
 assert subprocess.check_output(['git','rev-parse','origin/main'],cwd=s,text=True).strip()==base
 for name,inv in [('rpc-native-client-tests-r1','5ac4c760a0104537848179e14b5f1de1'),('rpc-native-client-tests-r2','089963a953fc457db25e4e4c421bf71b'),('rpc-native-client-tests-r3','cc409db5d40a4ca9b81f747e8379d725')]:
  q=p.parent/name;out=s/'ops/unified-funding-20261028'/name;out.mkdir(parents=True,exist_ok=True)
  props=subprocess.check_output(['systemctl','--user','show','enclave-'+name,'-p','MainPID','-p','ExecMainStatus','-p','ActiveState'],text=True)
  assert 'MainPID=0' in props and 'ActiveState=active' not in props
  journal=subprocess.check_output(['journalctl','--user','_SYSTEMD_INVOCATION_ID='+inv,'--no-pager','-n','40','-o','short-iso'],text=True)
  (q/'PROCESS-RECEIPT.json').write_text(json.dumps({'invocation':inv,'properties':props,'journal':journal},indent=2)+'\n')
  pins=json.loads((q/'PINS.json').read_text());unchanged=[];changed=[]
  proc=subprocess.Popen(['git','cat-file','--batch'],cwd=s,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
  try:
   for n,h in pins.items():
    data=(q/'frozen'/n).read_bytes();assert hashlib.sha256(data).hexdigest()==h,n
    proc.stdin.write((base+':'+n+'\n').encode());proc.stdin.flush();line=proc.stdout.readline().decode().strip()
    if line.endswith(' missing'):old=None
    else:
     size=int(line.split()[-1]);old=proc.stdout.read(size);assert proc.stdout.read(1)==b'\n'
    if old==data:unchanged.append(n)
    else:
     changed.append(n);dst=out/'frozen'/n;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(data)
  finally:proc.stdin.close();assert proc.wait(timeout=5)==0
  (q/'FROZEN-BASE.json').write_text(json.dumps({'base':base,'unchangedVerifiedBlobs':unchanged,'preservedChangedSource':changed},indent=2)+'\n')
  for f in q.iterdir():
   if f.is_file() and f.suffix in ['.json','.md','.py']:(out/f.name).write_bytes(f.read_bytes())
   elif f.is_file() and f.suffix in ['.log','.jsonl']:(out/(f.name+'.json')).write_text(json.dumps({'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'text':f.read_text()},indent=2)+'\n')
 for name in [p.name,'rpc-native-manager-transport-ci-r1']:
  q=p.parent/name;out=s/'ops/unified-funding-20261028'/name;out.mkdir(parents=True,exist_ok=True)
  for f in q.iterdir():
   if f.is_file() and f.suffix in ['.json','.md','.py']:(out/f.name).write_bytes(f.read_bytes())
 run(['git','add','--']+paths)
 run(['git','diff','--cached','--check'])
 run(['git','commit','-m','Connect RPC app manager to durable native controller transport'])
 run(['git','push','origin','HEAD:main'])
 head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=s,text=True).strip()
 remote=subprocess.check_output(['git','ls-remote','origin','refs/heads/main'],cwd=s,text=True,timeout=30).split()[0]
 (p/'PUSH-RESULT.json').write_text(json.dumps({'head':head,'remote':remote,'match':head==remote})+'\n')
 assert head==remote
