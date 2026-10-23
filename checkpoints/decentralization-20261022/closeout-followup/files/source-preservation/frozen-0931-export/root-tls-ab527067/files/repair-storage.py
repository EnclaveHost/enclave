"""Run on enclave-storage as root. Default: read-only preflight. --apply: bounded tunnel retry repair."""
import subprocess,pathlib,json,hashlib,sys,time,os
REGIONS=('us-west','ca-east','eu-central','ap-southeast')
FAILED=('ca-east','eu-central','ap-southeast')
PINS={'us-west': 'db1e8ba21e9032dbee639a1355c15645374855e0dd7762919de0251ab8c6faad', 'ca-east': '5137d27cbabb3016a9e479d61c2e7d519e4526da949091c26082b372fbb1df72', 'eu-central': '3b44e1fcebab4cdee62f66c2c5087d58dcd0ead497a5a2ab012c4d903820c056', 'ap-southeast': '188956b7bf0023c8b4d1165f7a8651ef158202de9640106bb86630b36ddfaaab'}
DROP='[Service]\n# Keep failed reverse-tunnel attempts outside the ingress SSH rate-limit window.\nRestartSec=60s\n'
def command(*args):return subprocess.check_output(args,text=True,timeout=15)
def inspect(region):
 u='enclave-storage-tunnel-'+region+'.service'
 raw=command('systemctl','show',u,'-p','ActiveState','-p','SubState','-p','MainPID','-p','NRestarts','-p','RestartUSec','-p','FragmentPath')
 d=dict(l.split('=',1)for l in raw.splitlines()if '='in l)
 path=pathlib.Path(d['FragmentPath']);data=path.read_bytes()
 assert '--apply' not in sys.argv or hashlib.sha256(data).hexdigest()==PINS[region],(u,'unit changed since reviewed preflight')
 assert b'RestartSec=10' in data and b'ExitOnForwardFailure=yes' in data,(u,'unexpected unit template')
 drop=pathlib.Path('/etc/systemd/system')/(u+'.d')/'60-tunnel-retry.conf'
 assert not drop.exists() or drop.read_text()==DROP,(u,'conflicting drop-in')
 d.update(unit=u,unitSha256=hashlib.sha256(data).hexdigest(),dropIn=str(drop),alreadyApplied=drop.exists())
 return d
before={r:inspect(r)for r in REGIONS}
print(json.dumps({'phase':'preflight','before':before}),flush=True)
if '--apply' not in sys.argv:raise SystemExit(0)
for r in FAILED:
 d=before[r]
 assert d['ActiveState']in ('activating','failed','inactive') and d['MainPID']=='0',(r,'tunnel is now active; inspect before changing it')
for r,d in before.items():
 p=pathlib.Path(d['dropIn']);p.parent.mkdir(mode=0o755,exist_ok=True)
 if not p.exists():
  fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
  with os.fdopen(fd,'w')as f:f.write(DROP);f.flush();os.fsync(f.fileno())
command('systemctl','daemon-reload')
for r in REGIONS:assert command('systemctl','show','enclave-storage-tunnel-'+r,'-p','RestartUSec','--value').strip()=='1min'
stopped=[]
try:
 for r in FAILED:
  command('systemctl','stop','enclave-storage-tunnel-'+r);stopped.append(r)
 print(json.dumps({'phase':'cooldown','seconds':35,'stopped':stopped,'healthyTunnelsUnchanged':True}),flush=True)
 time.sleep(35)
finally:
 for r in stopped:command('systemctl','start','enclave-storage-tunnel-'+r)
time.sleep(3)
print(json.dumps({'phase':'after','after':{r:inspect(r)for r in REGIONS}}),flush=True)
