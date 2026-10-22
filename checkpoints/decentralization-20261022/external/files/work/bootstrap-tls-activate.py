from pathlib import Path
import subprocess,json,sys,hashlib,os
region=sys.argv[1]
assert region in ['us-west','eu-central','ap-southeast','ca-east']
active=Path('/etc/enclave-network/provider-pinned-8b37c37.json')
backup=active.with_name(active.stem+'.before-bootstrap-tls.json')
candidate=Path('/etc/enclave-bootstrap-tls/provider-prepared.json')
assert active.read_bytes()==backup.read_bytes(),'Provider configuration changed; review required'
new=json.loads(candidate.read_text());old=json.loads(active.read_text())
assert new['localRoutes'].pop('bootstrap-'+region+'.enclave.host')=={'host':'127.0.0.1','tls':28443,'http':28080}
assert new==old,'Unexpected provider change'
tmp=active.with_suffix('.bootstrap-tmp');tmp.write_bytes(candidate.read_bytes());tmp.chmod(active.stat().st_mode & 0o777);os.chown(tmp,active.stat().st_uid,active.stat().st_gid);os.replace(tmp,active)
try:
    subprocess.run(['systemctl','restart','enclave-network-provider'],check=True,capture_output=True)
    subprocess.run(['systemctl','enable','--now','enclave-bootstrap-tls'],check=True,capture_output=True)
    subprocess.run(['systemctl','is-active','--quiet','enclave-network-provider','enclave-bootstrap-tls'],check=True)
except Exception:
    active.write_bytes(backup.read_bytes())
    subprocess.run(['systemctl','restart','enclave-network-provider'],check=True)
    raise
print(json.dumps({'region':region,'activated':True,'activeSHA256':hashlib.sha256(active.read_bytes()).hexdigest(),'custodyCaddyUnchanged':True}))
