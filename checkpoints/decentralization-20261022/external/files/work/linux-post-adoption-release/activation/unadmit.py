# ROOT EXECUTES only to undo admit.py (this directory's): restores the env file admit.py replaced (CAS on both versions), restarts the API.
from pathlib import Path
import subprocess,json
A=Path(__file__).resolve().parent;ad=json.loads((A/'admission.json').read_text());ENV='/etc/nan-relay/linux-leasegas-measurements.env'
script='''from pathlib import Path
import subprocess,hashlib,os
ENV,BACKUP,NEW,OLD,SHORTN=ARGS
e,b=Path(ENV),Path(BACKUP)
assert hashlib.sha256(e.read_bytes()).hexdigest()==NEW and hashlib.sha256(b.read_bytes()).hexdigest()==OLD
t=e.with_name(e.name+'.restore-'+SHORTN);assert not t.exists();t.write_bytes(b.read_bytes());t.chmod(0o644);os.replace(t,e)
subprocess.run(['systemctl','restart','enclave-api-relay.service'],check=True,timeout=45)
print('ADMISSION-RESTORED')
'''.replace('ARGS',repr((ENV,ad['remoteBackup'],ad['environmentSha256'],ad['replacesInstalledSha256'],ad['remoteBackup'].rsplit('-',1)[1])))
args=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo -n python3 -']
r=subprocess.run(args,input=script,text=True,capture_output=True,timeout=60);print(r.stdout+r.stderr,end='');raise SystemExit(r.returncode)
