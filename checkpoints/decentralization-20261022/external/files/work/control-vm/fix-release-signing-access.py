from pathlib import Path
import subprocess,os,time,json
unit='enclave-api-relay.service'
pid=subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip()
env=dict(s.split('=',1) for s in Path('/proc/'+pid+'/environ').read_text().split('\0') if '=' in s)
source=Path('/etc/nan-relay/secrets-release-signing.seed')
assert env['SECRETS_RELEASE_SIGNING_KEY_FILE']==str(source)
assert not env.get('SECRETS_RELEASE_SIGNING_KEY')
assert source.stat().st_uid==0 and source.stat().st_mode&0o777==0o600
credential='/run/enclave-api-relay-secrets/release.seed'
override=Path('/etc/nan-relay/release-signing-credential.env')
dropin=Path('/etc/systemd/system/'+unit+'.d/zzzz-release-signing-credential.conf')
assert not override.exists() and not dropin.exists()
override.write_text('SECRETS_RELEASE_SIGNING_KEY_FILE='+credential+'\n');override.chmod(0o600)
dropin.write_text('[Service]\nLoadCredential=secrets-release-signing.seed:'+str(source)+'\nEnvironmentFile='+str(override)+'\nRuntimeDirectory=enclave-api-relay-secrets\nRuntimeDirectoryMode=0700\nExecStartPre=/usr/bin/install -m 0600 %d/secrets-release-signing.seed /run/enclave-api-relay-secrets/release.seed\n')
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','restart',unit],check=True)
print('Installed systemd private credential; source seed remains root-owned 0600')
