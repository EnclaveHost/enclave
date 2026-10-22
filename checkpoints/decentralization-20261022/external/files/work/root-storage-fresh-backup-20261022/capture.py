from pathlib import Path
import datetime,hashlib,json,secrets,subprocess,shlex
P=Path(__file__).resolve().parent
src=Path('work/claude-resumed-20261022/storage-fresh-backup/runner/vm_fresh_backup.py')
expected='1460169a15b7bc44748d0f8a6891f208ca045cf92de6abdcedc74956c0c5d1c6'
assert hashlib.sha256(src.read_bytes()).hexdigest()==expected
pf=json.loads(Path('work/root-storage-prebackup-r4-20261022/result.json').read_text())
assert pf['exit']==0 and (datetime.datetime.now(datetime.timezone.utc)-datetime.datetime.fromisoformat(pf['at'])).total_seconds()<900
rid=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ-')+secrets.token_hex(4)
vm='/root/fresh-backup/vm_fresh_backup-1460169a.py'
unit='enclave-indexd-fresh-backup-'+rid
ssh=['ssh','-p','32422','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=4','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
rec={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'runId':rid,'unit':unit,'runnerPath':vm,'runnerSha256':expected,'preflightSha256':pf['captureSha'],'productionEffect':'briefly stop indexd, capture coupled backup, resume prior state; no schema migration','status':'STAGING'}
with (P/'attempt.json').open('x') as f:json.dump(rec,f,indent=2)
def call(name,cmd,data=None,timeout=60):
 r=subprocess.run(ssh+[cmd],input=data,capture_output=True,timeout=timeout)
 (P/(name+'.out')).write_bytes(r.stdout);(P/(name+'.err')).write_bytes(r.stderr)
 rec[name+'Exit']=r.returncode;(P/'progress.json').write_text(json.dumps(rec,indent=2)+'\n');return r
r=call('stage',"sudo -n install -d -o root -g root -m 0700 /root/fresh-backup && sudo -n sh -c "+shlex.quote('set -C; umask 077; cat > '+vm),src.read_bytes())
if r.returncode:raise SystemExit('stage failed; capture not attempted')
r=call('stage-verify','sudo -n sha256sum '+vm)
assert r.returncode==0 and r.stdout.decode().split()[0]==expected
rec['status']='CAPTURE_SUBMITTED';(P/'progress.json').write_text(json.dumps(rec,indent=2)+'\n')
args=['sudo','-n','systemd-run','--unit='+unit,'--collect','--wait','--quiet','--property=RuntimeMaxSec=1500','--property=TimeoutStopSec=300','--property=KillMode=mixed','/usr/bin/python3',vm,'capture','--run-id',rid,'--confirm','fresh-backup','--expect-db-version','26','--expect-binary-sha256','2d7a637e843500f7bd1864d76e1fa310e3163e57adc5d8c19e43598e827de5dc','--expect-geoip-sha256','18bf1695e85007dc1525e88bddd26d4f45b85550899bda8f8d1ebc1e804fc933','--quiesce-budget','600','--dump-timeout','300']
try:r=call('capture',shlex.join(args),timeout=1850);rec['transportResult']=r.returncode
except subprocess.TimeoutExpired:rec['transportResult']='UNKNOWN: timed out; inspect same unit/run, never resubmit'
r=call('status',shlex.join(['sudo','-n','python3',vm,'status','--run-id',rid]))
rec['status']='REQUIRES_STATUS_REVIEW';(P/'progress.json').write_text(json.dumps(rec,indent=2)+'\n')
print(json.dumps(rec));print(r.stdout.decode())
