# ROOT EXECUTES (prepared by Claude 5a07654a; derived from linux-lease-root-release/activation/admit.py).
# Remote, on the API relay: COMPARE-AND-SWAP the installed measurement env file (it must still be exactly the content
# the c083 admission installed), keeping a fresh backup beside it; the existing drop-in must be exactly the installed
# one and is not rewritten. On any failure the previous file is restored and the service restarted.
from pathlib import Path
import subprocess,json,datetime,hashlib
A=Path(__file__).resolve().parent;ad=json.loads((A/'admission.json').read_text())
assert ad['stage']=='prepared only'
ENV='/etc/nan-relay/linux-leasegas-measurements.env';DROP='/etc/systemd/system/enclave-api-relay.service.d/zzzzz-linux-leasegas-measurement.conf'
BACKUP=ENV+'.before-51516b778'
body=(A/'measurement.env').read_text();assert hashlib.sha256(body.encode()).hexdigest()==ad['environmentSha256']
script='''from pathlib import Path
import subprocess,hashlib,os
ENV,DROP,BACKUP,BODY,EXPECT,DROPSHA=ARGS
e,dr,b=Path(ENV),Path(DROP),Path(BACKUP)
assert hashlib.sha256(e.read_bytes()).hexdigest()==EXPECT,'installed admission changed since the c083 record: inspect first'
assert hashlib.sha256(dr.read_bytes()).hexdigest()==DROPSHA,'admission drop-in changed: inspect first'
assert not b.exists(),'a backup from an earlier attempt exists: inspect first'
assert subprocess.check_output(['systemctl','is-active','enclave-api-relay.service'],text=True).strip()=='active'
old=e.read_bytes();b.write_bytes(old);b.chmod(0o600)
try:
 t=e.with_name(e.name+'.tmp-51516b778');assert not t.exists();t.write_text(BODY);t.chmod(0o644);os.replace(t,e)
 subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=45)
 subprocess.run(['systemctl','is-active','--quiet','enclave-api-relay.service'],check=True)
 print('ADMISSION-UPDATED API service active')
except BaseException:
 e.write_bytes(old);subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=45)
 raise
'''.replace('ARGS',repr((ENV,DROP,BACKUP,body,ad['replacesInstalledSha256'],ad['dropinSha256'])))
args=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo -n python3 -']
r=subprocess.run(args,input=script,text=True,capture_output=True,timeout=60)
(A/'admission-apply.out').write_text(r.stdout+r.stderr);print(r.stdout+r.stderr,end='')
if r.returncode:raise SystemExit(r.returncode)
ad.update(stage='installed; public endpoint recheck pending',installedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),remoteBackup=BACKUP,
 files={ENV:ad['environmentSha256'],DROP:ad['dropinSha256']});(A/'admission.json').write_text(json.dumps(ad,indent=2)+'\n')
