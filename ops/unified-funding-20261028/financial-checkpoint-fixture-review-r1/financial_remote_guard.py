"""SOURCE ONLY. Independent owned-unit guard. Never controls production services."""
from pathlib import Path
import os,json,time,hashlib,subprocess,datetime
SOURCE=Path('/var/tmp/enclave-financial-fixture-source-20261029-r1')
OUT=Path('/var/tmp/enclave-financial-fixture-control-20261029-r1')
UNIT='enclave-financial-fixture-20261029-r1.service'
PINS={'/opt/nan-relay/api-relay.js':'481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d','/opt/nan-relay/sessions.mjs':'457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d','/opt/nan-relay/store.js':'12157d8ccf8b1ec4ffd4d0af9b5b846650ec20aac748bcc51ad087e119922dcd'}
def digest(p):
 h=hashlib.sha256()
 with Path(p).open('rb') as f:
  for b in iter(lambda:f.read(65536),b''):h.update(b)
 return h.hexdigest()
def write(name,obj):
 p=OUT/name
 with p.open('x') as f:json.dump(obj,f,indent=2);f.flush();os.fsync(f.fileno())
 fd=os.open(OUT,os.O_DIRECTORY);os.fsync(fd);os.close(fd)
def show(unit):
 s=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','-p','LoadState','-p','ActiveState','-p','SubState','-p','InvocationID','-p','ControlGroup','-p','ExecStart'],text=True,timeout=3)
 return dict(l.split('=',1) for l in s.splitlines() if '=' in l)
def prod():
 d=show('enclave-api-relay.service');pid=int(d['MainPID']);assert pid==228946
 p=Path('/proc')/str(pid);s=(p/'stat').read_text();assert s[s.rfind(')')+2:].split()[19]=='43738495'
 assert digest(p/'exe')=='93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068'
 assert all(digest(f)==h for f,h in PINS.items())
 return {'pid':pid,'startTicks':'43738495','sourcePins':PINS}
def available():return next(int(l.split()[1])//1024 for l in Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
assert os.geteuid()==0
assert 'enclave-financial-fixture-guard-20261029-r1.service' in Path('/proc/self/cgroup').read_text()
OUT.mkdir(mode=0o700) # exclusive: do not rerun this operation
before=prod();assert available()>=4480,'launch memory floor'
assert show(UNIT)['LoadState']=='not-found','unit exists'
assert not Path('/var/tmp/enclave-financial-fixture-20261029-r1').exists(),'output exists'
assert not subprocess.check_output(['systemctl','list-jobs','--no-legend','--no-pager'],text=True,timeout=3).strip(),'pending jobs'
raw=subprocess.check_output(['systemctl','list-units','--type=service','--state=running','--no-legend','--plain','--no-pager'],text=True,timeout=3)
names=[l.split()[0] for l in raw.splitlines()]
raw=subprocess.check_output(['systemctl','show',*names,'-p','MemoryCurrent','-p','MemoryMax'],text=True,timeout=3)
headroom=0
for block in raw.strip().split('\n\n'):
 d=dict(l.split('=',1) for l in block.splitlines() if '=' in l)
 if d.get('MemoryMax','').isdigit() and d.get('MemoryCurrent','').isdigit():headroom+=max(0,int(d['MemoryMax'])-int(d['MemoryCurrent']))
assert headroom/1048576+1024<=4096,'commitments exceed runtime reserve'
write('preflight.json',{'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'production':before,'availableMiB':available(),'finiteServiceHeadroomMiB':headroom/1048576})
cmd=['systemd-run','--unit='+UNIT,'--collect','--service-type=exec','--property=MemoryMax=256M','--property=MemorySwapMax=0','--property=TasksMax=64','--property=CPUQuota=50%','--property=RuntimeMaxSec=120','--property=TimeoutStopSec=3','--property=KillMode=control-group','--property=UMask=0077','/usr/bin/unshare','--net','--','/usr/bin/python3',str(SOURCE/'financial_namespace_launcher.py')]
write('launch-intent.json',{'unit':UNIT,'atUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'resendAllowed':False})
launch='unknown'
try:
 r=subprocess.run(cmd,capture_output=True,timeout=8);launch='acknowledged' if r.returncode==0 else 'refused-or-unknown'
except subprocess.TimeoutExpired:pass
write('launch-result.json',{'status':launch,'noAutomaticRetry':True})
deadline=time.monotonic()+128;minimum=available();invocation=None;stopped=False
while time.monotonic()<deadline:
 s=show(UNIT);mem=available();minimum=min(minimum,mem)
 if s['LoadState']=='not-found' or s['ActiveState'] in ('inactive','failed'):break
 if str(SOURCE/'financial_namespace_launcher.py') not in s['ExecStart']:raise RuntimeError('unit identity mismatch; no stop authority')
 if invocation is None:invocation=s['InvocationID']
 assert s['InvocationID']==invocation,'unit invocation changed'
 if mem<4096:
  write('floor-stop-intent.json',{'availableMiB':mem,'unit':UNIT,'invocation':invocation})
  subprocess.run(['systemctl','stop',UNIT],timeout=6,check=True);stopped=True;break
 time.sleep(.25)
else:
 s=show(UNIT)
 if s.get('InvocationID')==invocation and str(SOURCE/'financial_namespace_launcher.py') in s.get('ExecStart',''):
  write('deadline-stop-intent.json',{'unit':UNIT,'invocation':invocation})
  subprocess.run(['systemctl','stop',UNIT],timeout=6,check=True);stopped=True
final=show(UNIT);cg=Path('/sys/fs/cgroup/system.slice')/UNIT
residual=[]
if cg.exists():
 for f in cg.rglob('cgroup.procs'):residual.extend(f.read_text().split())
write('guard-result.json',{'launch':launch,'minimumAvailableMiB':minimum,'guardStoppedOwnedUnit':stopped,'unit':{k:v for k,v in final.items() if k!='ExecStart'},'residualOwnedPids':residual,'production':prod(),'productionAcceptance':False})
assert not residual and int(final.get('MainPID','0'))==0,'owned cleanup incomplete'
