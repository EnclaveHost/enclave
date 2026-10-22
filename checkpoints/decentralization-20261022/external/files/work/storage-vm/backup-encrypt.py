from pathlib import Path
import subprocess,os,json,hashlib,datetime
os.umask(0o077);private=Path('work/private/indexd-recovery');out=private/'indexd-minipc-20261019.tar.gpg';assert not out.exists()
m=json.loads(Path('outputs/storage-post-cutover-snapshot.json').read_text());assert m['sourceResumed']
base=['ssh','-p','32422','-o','BatchMode=yes','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
log=(private/'post-cutover-backup.log').open('ab')
src=subprocess.Popen(base+['sudo tar -C /var/lib/enclave-indexd/recovery-20261019 -cf - indexd.pgdump consensus.db indexd.yml indexd GeoLite2-City.mmdb counts.json manifest.json'],stdout=subprocess.PIPE,stderr=log)
dst=subprocess.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(private/'backup.pass'),'--symmetric','--cipher-algo','AES256','--compress-algo','ZLIB','--output',str(out)+'.partial'],stdin=src.stdout,stdout=log,stderr=log)
src.stdout.close();assert src.wait()==0 and dst.returncode==0
Path(str(out)+'.partial').rename(out)
with out.open('rb') as stream:h=hashlib.file_digest(stream,'sha256').hexdigest()
r={'encryptedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'file':out.name,'bytes':out.stat().st_size,'sha256':h,'sourceSnapshot':m,'replicas':[],'containsLatestSmokeUpload':True,'decryptionKeyReplicated':False}
Path('outputs/storage-post-cutover-backup.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps({'encrypted':True,'bytes':r['bytes'],'sha256':h}))
