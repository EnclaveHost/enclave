from pathlib import Path
import subprocess,hashlib,json,concurrent.futures
private=Path('work/private/control-recovery');key=private/'passphrase';archive=private/'enclave-control-minipc-20261019-supplement.tar.zst.gpg'
assert key.exists() and not archive.exists()
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
paths=['opt/enclave-dns','opt/enclave-directory-bridge']
source=subprocess.Popen(ssh+['sudo tar --zstd -cf - -C / '+' '.join(paths)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
r=subprocess.run(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-file',str(key),'--symmetric','--cipher-algo','AES256','--output',str(archive)],stdin=source.stdout,capture_output=True);source.stdout.close();err=source.stderr.read();rc=source.wait();assert rc==0 and r.returncode==0,(err[-300:],r.stderr[-300:]);archive.chmod(0o600)
sha=hashlib.file_digest(archive.open('rb'),'sha256').hexdigest()
def copy(region):
 subprocess.run(['scp','-q',str(archive),region+':/var/lib/enclave-recovery/control/'+archive.name],check=True)
 got=subprocess.check_output(['ssh',region,'chmod 600 /var/lib/enclave-recovery/control/'+archive.name+' && sha256sum /var/lib/enclave-recovery/control/'+archive.name],text=True).split()[0]
 assert got==sha
 print(region+': supplement verified',flush=True);return region
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: regions=list(pool.map(copy,['us-west','eu-central','ap-southeast','ca-east']))
dec=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(key),'--decrypt',str(archive)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
r=subprocess.run(['tar','--zstd','-tf','-'],stdin=dec.stdout,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE);dec.stdout.close();err=dec.stderr.read();rc=dec.wait();assert rc==r.returncode==0,(err[-300:],r.stderr[-300:])
p=Path('outputs/control-recovery-backup.json');meta=json.loads(p.read_text());meta['supplement']={'archive':archive.name,'bytes':archive.stat().st_size,'sha256':sha,'paths':paths,'providers':regions,'decryptAndArchiveIntegrityVerified':True};meta['requiredArchives']=['enclave-control-minipc-20261019.tar.zst.gpg',archive.name];meta['executablePathAudit']='All Enclave unit ExecStart application paths included across the main and supplemental archives';p.write_text(json.dumps(meta,indent=2)+'\n');print('Supplement complete',flush=True)
