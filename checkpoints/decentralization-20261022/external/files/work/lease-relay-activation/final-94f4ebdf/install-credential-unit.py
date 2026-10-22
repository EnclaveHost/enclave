from pathlib import Path
import subprocess,base64,hashlib,json,sys
host=sys.argv[1];assert host in ['us-west','eu-central']
base=Path(__file__).resolve().parent;data=(base/'enclave-lease-relay-credential-copy.service').read_bytes();want=hashlib.sha256(data).hexdigest();assert want=='4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba'
program='DATA='+repr(base64.b64encode(data).decode())+'\n'+r'''
from pathlib import Path
import base64,hashlib,os,subprocess,json
p=Path('/etc/systemd/system/enclave-lease-relay.service');old='133d8fdc7046047bc00a0837fb8190e332665560448886d6e32da5c11827a5fc';new='4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert not p.is_symlink() and sha(p)==old
assert subprocess.run(['systemctl','is-active','--quiet','enclave-lease-relay']).returncode!=0
backup=p.with_name('enclave-lease-relay.service.before-credential-copy');fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
with os.fdopen(fd,'wb') as f:f.write(p.read_bytes());f.flush();os.fsync(f.fileno())
tmp=p.with_name('.enclave-lease-relay.service.credential-copy');data=base64.b64decode(DATA);assert hashlib.sha256(data).hexdigest()==new
fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
with os.fdopen(fd,'wb') as f:f.write(data);f.flush();os.fsync(f.fileno())
assert sha(p)==old;os.replace(tmp,p);assert sha(p)==new
subprocess.run(['systemctl','daemon-reload'],check=True,timeout=30)
print(json.dumps({'unitSha256':new,'oldSha256':old,'keyMaterialRead':False,'started':False}))
'''
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',host,'python3','-'],input=program,capture_output=True,text=True,timeout=45)
(base/(host+'-credential-unit.json')).write_text(r.stdout);print(r.stdout);assert r.returncode==0,r.stderr
