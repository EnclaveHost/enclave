"""SOURCE ONLY. Explicit one-run reviewed staging/guard/collection; never retries."""
from pathlib import Path
import sys,os,json,hashlib,base64,shlex,subprocess
if sys.argv[1:]!=['--execute-reviewed-one-run']:raise SystemExit('reviewed one-run flag required')
HERE=Path(__file__).resolve().parent
OUT=HERE/'financial-r1-local-evidence'
os.umask(0o077);OUT.mkdir(mode=0o700)
SSH=['ssh','-o','ConnectTimeout=8','-o','BatchMode=yes','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
names=['financial_fixture_parent.mjs','financial_fixture_child.mjs','financial-fixture-profile-PROPOSED.json','financial_namespace_launcher.py','financial_remote_guard.py']
files={n:{'sha256':hashlib.sha256((HERE/n).read_bytes()).hexdigest(),'base64':base64.b64encode((HERE/n).read_bytes()).decode()} for n in names}
(OUT/'source-manifest.json').write_text(json.dumps({n:v['sha256'] for n,v in files.items()},indent=2)+'\n')
STAGE=r'''
from pathlib import Path
import sys,json,hashlib,base64,os,subprocess
p=json.load(sys.stdin);root=Path('/var/tmp/enclave-financial-fixture-source-20261029-r1')
assert set(p)=={'financial_fixture_parent.mjs','financial_fixture_child.mjs','financial-fixture-profile-PROPOSED.json','financial_namespace_launcher.py','financial_remote_guard.py'}
assert os.geteuid()==0
for unit in ['enclave-financial-fixture-20261029-r1.service','enclave-financial-fixture-guard-20261029-r1.service']:
 assert subprocess.check_output(['systemctl','show',unit,'-p','LoadState','--value'],text=True,timeout=3).strip()=='not-found'
assert not Path('/var/tmp/enclave-financial-fixture-20261029-r1').exists()
assert not Path('/var/tmp/enclave-financial-fixture-control-20261029-r1').exists()
assert int(subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','--value'],text=True,timeout=3))==228946
assert next(int(s.split()[1])//1024 for s in Path('/proc/meminfo').read_text().splitlines() if s.startswith('MemAvailable:'))>=4480
root.mkdir(mode=0o700);pins={}
for name,v in p.items():
 b=base64.b64decode(v['base64']);assert hashlib.sha256(b).hexdigest()==v['sha256'];f=root/name
 with f.open('xb') as h:h.write(b);h.flush();os.fsync(h.fileno())
 os.chmod(f,0o600);pins[name]=hashlib.sha256(f.read_bytes()).hexdigest();assert pins[name]==v['sha256']
for folder in [root,root.parent]:
 fd=os.open(folder,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
print(json.dumps({'stagedOnly':True,'sourcePins':pins}))
'''
def remote(code,input=None,timeout=20):
 return subprocess.run(SSH+['sudo -n /usr/bin/python3 -c '+shlex.quote(code)],input=input,capture_output=True,timeout=timeout)
r=remote(STAGE,json.dumps(files).encode(),30)
(OUT/'stage.stdout').write_bytes(r.stdout);(OUT/'stage.stderr').write_bytes(r.stderr)
if r.returncode:raise SystemExit('stage failed; preserved evidence, no launch/retry')
(OUT/'launch-intent.json').write_text(json.dumps({'unit':'enclave-financial-fixture-guard-20261029-r1.service','retryAllowed':False})+'\n')
cmd=['sudo','-n','systemd-run','--unit=enclave-financial-fixture-guard-20261029-r1.service','--wait','--pipe','--collect','--service-type=exec','--property=MemoryMax=64M','--property=MemorySwapMax=0','--property=TasksMax=32','--property=CPUQuota=15%','--property=RuntimeMaxSec=150','--property=TimeoutStopSec=3','--property=KillMode=control-group','--property=UMask=0077','/usr/bin/python3','/var/tmp/enclave-financial-fixture-source-20261029-r1/financial_remote_guard.py']
status='UNKNOWN'
try:
 r=subprocess.run(SSH+[shlex.join(cmd)],capture_output=True,timeout=165)
 (OUT/'launch.stdout').write_bytes(r.stdout);(OUT/'launch.stderr').write_bytes(r.stderr)
 status='completed' if r.returncode==0 else 'failed-or-unknown'
except subprocess.TimeoutExpired as e:
 (OUT/'launch.stdout').write_bytes(e.stdout or b'');(OUT/'launch.stderr').write_bytes(e.stderr or b'')
(OUT/'launch-result.json').write_text(json.dumps({'status':status,'retryAllowed':False})+'\n')
COLLECT=r'''
from pathlib import Path
import subprocess,json,base64,hashlib,datetime
out={};roots={'control':Path('/var/tmp/enclave-financial-fixture-control-20261029-r1'),'suite':Path('/var/tmp/enclave-financial-fixture-20261029-r1')}
for kind,root in roots.items():
 names=['report.json'] if kind=='suite' else ['preflight.json','launch-intent.json','launch-result.json','floor-stop-intent.json','deadline-stop-intent.json','guard-result.json']
 for n in names:
  f=root/n
  if f.is_file() and not f.is_symlink():
   assert f.stat().st_size<1048576;b=f.read_bytes();out[kind+'/'+n]={'sha256':hashlib.sha256(b).hexdigest(),'base64':base64.b64encode(b).decode()}
units={};residual={}
for unit in ['enclave-financial-fixture-20261029-r1.service','enclave-financial-fixture-guard-20261029-r1.service']:
 s=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','-p','ActiveState','-p','SubState','-p','LoadState'],text=True,timeout=3);units[unit]=dict(l.split('=',1) for l in s.splitlines() if '=' in l)
 cg=Path('/sys/fs/cgroup/system.slice')/unit;residual[unit]=[]
 if cg.exists():
  for f in cg.rglob('cgroup.procs'):residual[unit]+=f.read_text().split()
pid=int(subprocess.check_output(['systemctl','show','enclave-api-relay.service','-p','MainPID','--value'],text=True,timeout=3))
assert pid==228946
st=Path(f'/proc/{pid}/stat').read_text();ticks=st[st.rfind(')')+2:].split()[19];assert ticks=='43738495'
pins={}
for name in ['api-relay.js','sessions.mjs','store.js']:
 pins[name]=hashlib.sha256((Path('/opt/nan-relay')/name).read_bytes()).hexdigest()
assert pins=={'api-relay.js':'481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d','sessions.mjs':'457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d','store.js':'12157d8ccf8b1ec4ffd4d0af9b5b846650ec20aac748bcc51ad087e119922dcd'}
print(json.dumps({'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'files':out,'units':units,'residualOwnedPids':residual,'productionRelayPid':pid,'productionStartTicks':ticks,'productionSourcePins':pins,'productionAcceptance':False}))
'''
r=remote(COLLECT,timeout=20)
(OUT/'collect.stderr').write_bytes(r.stderr)
if r.returncode:raise SystemExit('collection failed; no automatic retry or state mutation')
d=json.loads(r.stdout)
for name,v in d.pop('files').items():
 f=OUT/name;f.parent.mkdir(mode=0o700,parents=True,exist_ok=True);f.write_bytes(base64.b64decode(v['base64']))
(OUT/'cleanup.json').write_text(json.dumps(d,indent=2)+'\n')
print(json.dumps({'launch':status,'cleanup':d,'productionAcceptance':False}))
