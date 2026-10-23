"""Run on enclave-control as root. Default: read-only preflight. --apply: bounded tunnel retry repair."""
import subprocess,pathlib,json,hashlib,sys,time,os
REGIONS=('us-west','ca-east','eu-central','ap-southeast')
FAILED=('eu-central','ap-southeast')
PINS={'us-west':'c02fe731dabe47e417016262e7919114545f24b702b6adef64afbb1482c6941c','ca-east':'c07098f6a9a2d71ce4c8d1c50f6688c4fddf4e2493e092b3a47a2e087a1b5f50','eu-central':'2095dace308ae25e1a9aa68028a1422dc5f67c9892a75d9300859d84d94040c3','ap-southeast':'6670e5150ada0a2463e34a55862d318f3274f501241dfcd2644b7fc8ddd207e7'}
DROP='[Service]\n# Keep failed reverse-tunnel attempts outside the ingress SSH rate-limit window.\nRestartSec=60s\n'
def command(*args):return subprocess.check_output(args,text=True,timeout=15)
def inspect(region):
 u='enclave-control-tunnel-'+region+'.service'
 raw=command('systemctl','show',u,'-p','ActiveState','-p','SubState','-p','MainPID','-p','NRestarts','-p','RestartUSec','-p','FragmentPath')
 d=dict(l.split('=',1)for l in raw.splitlines()if '='in l)
 path=pathlib.Path(d['FragmentPath']);data=path.read_bytes()
 assert hashlib.sha256(data).hexdigest()==PINS[region],(u,'unit changed since reviewed preflight')
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
for r in REGIONS:assert command('systemctl','show','enclave-control-tunnel-'+r,'-p','RestartUSec','--value').strip()=='1min'
stopped=[]
try:
 for r in FAILED:
  command('systemctl','stop','enclave-control-tunnel-'+r);stopped.append(r)
 print(json.dumps({'phase':'cooldown','seconds':35,'stopped':stopped,'healthyTunnelsUnchanged':True}),flush=True)
 time.sleep(35)
finally:
 for r in stopped:command('systemctl','start','enclave-control-tunnel-'+r)
time.sleep(3)
print(json.dumps({'phase':'after','after':{r:inspect(r)for r in REGIONS}}),flush=True)
