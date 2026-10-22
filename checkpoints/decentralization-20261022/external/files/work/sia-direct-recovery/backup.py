import os,json,io,tarfile,secrets,subprocess,hashlib,datetime,concurrent.futures
from pathlib import Path
root=Path('private/sia-direct-recovery'); password=root/'backup.pass';out=root/'sia-direct-recovery-20261019-complete.tar.gpg'
if not password.exists():
 fd=os.open(password,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
 with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(48)+'\n')
if out.exists():raise RuntimeError('backup already exists; do not overwrite')
files={'snapshot.json':(root/'snapshot.json').read_bytes(),'app.seed':(root/'app.seed').read_bytes()}
files.update({'sia-s3-linux':Path('enclave-apps-sia-recovery/sia-s3/target/x86_64-unknown-linux-gnu/release/sia-s3').read_bytes(),'sia-s3.wasm':Path('enclave-apps-sia-recovery/sia-s3/target/wasm32-wasip2/release/sia-s3.wasm').read_bytes(),'README.md':Path('enclave-apps-sia-recovery/sia-s3/README.md').read_bytes()})
source=subprocess.check_output(['git','-C','enclave-apps-sia-recovery','rev-parse','HEAD'],text=True).strip()
files['manifest.json']=json.dumps({'sourceCommit':source,'files':{name:{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()} for name,data in files.items()}},indent=2).encode()
archive=io.BytesIO()
with tarfile.open(fileobj=archive,mode='w') as tar:
 for name,data in files.items():
  info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600;tar.addfile(info,io.BytesIO(data))
base=['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(password)]
subprocess.run(base+['--symmetric','--cipher-algo','AES256','--output',str(out)],input=archive.getvalue(),capture_output=True,check=True);out.chmod(0o600)
plain=subprocess.run(base+['--decrypt',str(out)],capture_output=True,check=True).stdout
with tarfile.open(fileobj=io.BytesIO(plain)) as tar:
 assert set(tar.getnames())==set(files)
 for name,data in files.items():assert tar.extractfile(name).read()==data
sha=hashlib.sha256(out.read_bytes()).hexdigest();dest='/var/backups/enclave-sia-recovery/'+out.name
hosts=['us-west','ca-east','ap-southeast','eu-central']
def copy(host):
 subprocess.run(['ssh','-o','BatchMode=yes',host,'install -d -m 0700 /var/backups/enclave-sia-recovery'],capture_output=True,check=True)
 subprocess.run(['scp','-q',str(out),host+':'+dest],capture_output=True,check=True)
 result=subprocess.run(['ssh','-o','BatchMode=yes',host,'chmod 0600 '+dest+' && sha256sum '+dest+' && stat -c %a '+dest],capture_output=True,text=True,check=True).stdout.splitlines()
 assert result[0].split()[0]==sha and result[1]=='600';return {'host':host,'sha256':sha,'mode':'0600','verified':True}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:copies=list(pool.map(copy,hosts))
report={'createdAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'encryptedArchive':out.name,'sha256':sha,'bytes':out.stat().st_size,'snapshotSha256':hashlib.sha256(files['snapshot.json']).hexdigest(),'containsAppSeed':True,'containsRecoveryBinaries':True,'sourceCommit':source,'encrypted':'GnuPG AES256 symmetric archive','localAuthenticatedDecryptionVerified':True,'copies':copies,'decryptionPassphraseCopiedToProviders':False,'plaintextKeyCopiedToProviders':False,'independentOperatorsVerified':False,'limit':'Point-in-time metadata and key recovery; no new Sia live writer, contract renewal or long-term funding path.'}
Path('../outputs/sia-indexer-free-recovery').mkdir(exist_ok=True)
Path('../outputs/sia-indexer-free-recovery/backup.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'encryptedBackupCopies':len(copies),'sha256':sha,'bytes':out.stat().st_size,'verifiedDecryption':True,'providerDecryptionKeys':False}))
