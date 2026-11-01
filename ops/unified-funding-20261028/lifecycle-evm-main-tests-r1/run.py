from pathlib import Path
import subprocess,json,hashlib,time
p=Path(__file__).resolve().parent;s=p.parent.parent/'source';pins=json.loads((p/'PINS.json').read_text())
def verify():
 for row in pins:
  for base in (s,p/'frozen'):assert hashlib.sha256((base/row['path']).read_bytes()).hexdigest()==row['sha256'],row['path']
verify()
tools=json.loads((p/'TOOLS.json').read_text());assert hashlib.sha256(Path(tools['anvil']).read_bytes()).hexdigest()==tools['sha256']
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True)
a=json.loads(r.stdout);assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
args=['/usr/sbin/bwrap','--unshare-all','--uid','0','--gid','0','--cap-add','CAP_NET_ADMIN','--die-with-parent','--new-session','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--ro-bind',str(p/'frozen'),'/src','--ro-bind',str((s/'node_modules').resolve()),'/src/node_modules','--ro-bind',tools['anvil'],'/anvil','--setenv','ANVIL','/anvil','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C','--chdir','/src','/usr/bin/sh','-c','/usr/sbin/ip link set lo up && exec /usr/bin/node --test --test-concurrency=1 test/lifecycle-evm-integration.test.mjs']
with (p/'ATTEMPT.json').open('x') as f:json.dump({'startedAt':time.time(),'networkNamespace':'private','localEVM':True,'productionChain':False,'liveMigration':False},f)
began=time.monotonic()
with (p/'TEST.tap').open('x') as f:r=subprocess.run(args,stdout=f,stderr=subprocess.STDOUT,timeout=90)
verify();(p/'RESULT.json').write_text(json.dumps({'rc':r.returncode,'seconds':time.monotonic()-began,'pinsUnchanged':len(pins),'localEVM':True,'productionChain':False,'liveMigration':False})+'\n');assert r.returncode==0
import re
t=(p/'TEST.tap').read_text();counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|skipped|cancelled) (\d+)$',t,re.M)}
assert counts['tests']==counts['pass'] and counts['fail']==counts['skipped']==counts['cancelled']==0,counts
verify()
