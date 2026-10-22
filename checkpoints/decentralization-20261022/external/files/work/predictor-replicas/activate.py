from pathlib import Path
import subprocess,hashlib,os,json
oldhash='9b7bb22231ef0b020b8eb6ec579c23823f8dcf5e999d51e05d67aab22dad238f'
active=Path('/opt/nan-relay/measurement-predict.mjs'); candidate=active.with_name('measurement-predict.replicas.mjs')
root=Path('/var/lib/indexd-migration/predictor-replicas');root.mkdir(mode=0o700,exist_ok=True)
backup=root/'measurement-predict.before.mjs'
assert hashlib.sha256(active.read_bytes()).hexdigest()==oldhash,'Production baseline changed'
assert not backup.exists(),'Already activated or backed up; inspect first'
proof=json.loads(Path('/var/lib/enclave-replica-preflight/result.json').read_text())
assert proof['kat']['ok'] and proof['adapterArtifact']['ok'] and proof['exactMeasurements'],'Preflight incomplete'
newhash=hashlib.sha256(candidate.read_bytes()).hexdigest()
envpath=Path('/etc/nan-relay/predictor-replicas.env')
dropin=Path('/etc/systemd/system/enclave-api-relay.service.d/zz-predictor-replicas.conf')
assert not envpath.exists() and not dropin.exists(),'Existing replica configuration needs review'
backup.write_bytes(active.read_bytes());backup.chmod(0o600)
gateways=','.join('https://bootstrap-'+r+'.enclave.host' for r in ['us-west','eu-central','ap-southeast','ca-east'])+',https://7ae476a3.app.enclave.host'
envtext='SECRETS_RELEASE_PREDICT_GATEWAYS='+gateways+'\nSECRETS_RELEASE_PREDICT_GATEWAY=\nSECRETS_RELEASE_CONFIG_GATEWAY=\n'
droptext='[Service]\nEnvironmentFile=/etc/nan-relay/predictor-replicas.env\n'
rollback='''from pathlib import Path
import hashlib,os,subprocess
p=Path('/opt/nan-relay/measurement-predict.mjs')
assert hashlib.sha256(p.read_bytes()).hexdigest()==NEWHASH,'Refusing rollback of a newer module'
e=Path('/etc/nan-relay/predictor-replicas.env');d=Path('/etc/systemd/system/enclave-api-relay.service.d/zz-predictor-replicas.conf')
assert e.read_text()==ENVTEXT and d.read_text()==DROPTEXT,'Refusing rollback of newer configuration'
t=p.with_suffix('.rollback');t.write_bytes(Path('/var/lib/indexd-migration/predictor-replicas/measurement-predict.before.mjs').read_bytes());t.chmod(p.stat().st_mode & 0o777);os.chown(t,p.stat().st_uid,p.stat().st_gid);os.replace(t,p)
e.unlink();d.unlink();subprocess.run(['systemctl','daemon-reload'],check=True);subprocess.run(['systemctl','restart','enclave-api-relay'],check=True)
'''.replace('NEWHASH',repr(newhash)).replace('ENVTEXT',repr(envtext)).replace('DROPTEXT',repr(droptext))
(root/'rollback.py').write_text(rollback)
envpath.write_text(envtext);envpath.chmod(0o600);dropin.write_text(droptext)
tmp=active.with_suffix('.replica-tmp');tmp.write_bytes(candidate.read_bytes());tmp.chmod(active.stat().st_mode & 0o777);os.chown(tmp,active.stat().st_uid,active.stat().st_gid);os.replace(tmp,active)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemd-run','--unit=enclave-predictor-replica-rollback','--on-active=20m','/usr/bin/python3',str(root/'rollback.py')],check=True,capture_output=True)
subprocess.run(['systemctl','restart','enclave-api-relay'],check=True)
print(json.dumps({'activated':True,'oldSHA256':oldhash,'newSHA256':newhash,'gateways':gateways.split(','),'rollbackTimerMinutes':20}))
