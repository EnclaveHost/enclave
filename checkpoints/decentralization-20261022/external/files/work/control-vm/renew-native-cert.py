#!/usr/bin/python3
from pathlib import Path
import subprocess,tempfile,os,hashlib,sys
ca=Path('/var/lib/enclave-native-ca');dest=Path('/var/lib/enclave-control-tls/native')
def run(args):return subprocess.run(args,check=True,capture_output=True)
assert all((ca/n).is_file() for n in ['ca.pem','ca.key','services.key'])
assert hashlib.sha256(run(['openssl','x509','-in',str(ca/'ca.pem'),'-outform','DER']).stdout).hexdigest()=='86bf2c486d9dea6ca6cafc6d5649f965121bd4d7ab0c7c8b8cbf88822641a62c'
if '--force' not in sys.argv and subprocess.run(['openssl','x509','-checkend','172800','-noout','-in',str(dest/'services.pem')],capture_output=True).returncode==0:sys.exit(0)
with tempfile.TemporaryDirectory(dir=ca,prefix='renew-') as td:
 p=Path(td);(p/'extensions').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.enclavehost.eth,DNS:mcp.enclavehost.eth,DNS:get.enclavehost.eth,DNS:ipfs.enclavehost.eth,DNS:sia.enclavehost.eth\n')
 run(['openssl','req','-new','-key',str(ca/'services.key'),'-subj','/CN=api.enclavehost.eth','-out',str(p/'request')])
 run(['openssl','x509','-req','-in',str(p/'request'),'-CA',str(ca/'ca.pem'),'-CAkey',str(ca/'ca.key'),'-set_serial','0x'+os.urandom(20).hex(),'-days','7','-sha256','-extfile',str(p/'extensions'),'-out',str(p/'leaf')])
 run(['openssl','verify','-CAfile',str(ca/'ca.pem'),'-verify_hostname','api.enclavehost.eth',str(p/'leaf')])
 full=(p/'leaf').read_bytes()+(ca/'ca.pem').read_bytes();target=dest/'services.pem';stat=target.stat();tmp=dest/'services.new.pem'
 with open(tmp,'wb') as f:f.write(full);f.flush();os.fsync(f.fileno())
 os.chown(tmp,stat.st_uid,stat.st_gid);os.chmod(tmp,stat.st_mode&0o777);os.replace(tmp,target)
run(['systemctl','reload','enclave-control-tls'])
print('Native service certificate renewed and reloaded; CA identity preserved.')
