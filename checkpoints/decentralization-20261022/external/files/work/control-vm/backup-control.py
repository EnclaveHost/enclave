from pathlib import Path
import subprocess,os,secrets,hashlib,json,datetime
root=Path.cwd();private=root/'work/private/control-recovery';private.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(private,0o700)
key=private/'passphrase';assert not key.exists();key.write_text(secrets.token_hex(32)+'\n');key.chmod(0o600)
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script='''from pathlib import Path
import subprocess,time,json
base=Path('/var/lib/enclave-migration/control-recovery-20261019');base.mkdir(mode=0o700)
units=['enclave-api-relay','enclave-policy-migration-bridge','enclave-provider-migration-mirror'];start=time.monotonic()
try:
 subprocess.run(['systemctl','stop',*units],check=True)
 subprocess.run(['tar','-czf',str(base/'relay-state.tar.gz'),'--exclude=./predict','-C','/var/lib/private/enclave-relay','.'],check=True)
finally:subprocess.run(['systemctl','start',*units],check=True)
(base/'relay-state.tar.gz').chmod(0o600)
paths=['etc/nan-relay','etc/enclave-dns','etc/enclave-control','etc/enclave-control-tls','var/lib/enclave-native-ca','var/lib/enclave-control-tunnel','var/lib/private/enclave-control-tls','opt/nan-relay','opt/enclave-predict','opt/enclave-recovery','usr/local/lib/enclave-node','usr/bin/node','usr/bin/caddy','var/lib/enclave-migration/control-recovery-20261019/relay-state.tar.gz']
for p in Path('/etc/systemd/system').glob('enclave-*'):
 if p.is_file() or p.is_dir():paths.append(str(p).lstrip('/'))
(base/'paths.txt').write_text('\\n'.join(paths)+'\\n')
print(json.dumps({'controlPauseSeconds':round(time.monotonic()-start,3),'paths':len(paths)}))
'''
r=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True);assert r.returncode==0,r.stderr[-1000:];meta=json.loads(r.stdout);print(meta,flush=True)
archive=private/'enclave-control-minipc-20261019.tar.zst.gpg'
source=subprocess.Popen(ssh+['sudo tar --zstd -cf - -C / -T /var/lib/enclave-migration/control-recovery-20261019/paths.txt'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
encrypt=subprocess.run(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-file',str(key),'--symmetric','--cipher-algo','AES256','--output',str(archive)],stdin=source.stdout,capture_output=True);source.stdout.close();err=source.stderr.read();rc=source.wait();assert rc==0,err[-1000:];assert encrypt.returncode==0,encrypt.stderr[-1000:];archive.chmod(0o600)
sha=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest();meta.update({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archiveBytes':archive.stat().st_size,'sha256':sha,'encrypted':True,'codeAndPredictorIncluded':True,'source':'minipc control VM','providers':[]})
for region in ['us-west','eu-central','ap-southeast','ca-east']:
 subprocess.run(['ssh',region,'install -d -m 0700 /var/lib/enclave-recovery/control'],check=True)
 subprocess.run(['scp','-q',str(archive),region+':/var/lib/enclave-recovery/control/'+archive.name],check=True)
 digest=subprocess.check_output(['ssh',region,'sha256sum /var/lib/enclave-recovery/control/'+archive.name],text=True).split()[0];assert digest==sha
 meta['providers'].append(region);print(region+': encrypted control backup verified',flush=True)
 (root/'outputs/control-recovery-backup.json').write_text(json.dumps(meta,indent=2)+'\n')
# Verify decrypt/decompress/tar integrity without writing private plaintext.
dec=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(key),'--decrypt',str(archive)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
check=subprocess.run(['tar','--zstd','-tf','-'],stdin=dec.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);dec.stdout.close();err=dec.stderr.read();rc=dec.wait();assert check.returncode==rc==0,(check.stderr[-400:],err[-400:]);meta['decryptAndArchiveIntegrityVerified']=True
(root/'outputs/control-recovery-backup.json').write_text(json.dumps(meta,indent=2)+'\n');print('Control recovery archive integrity verified',flush=True)
