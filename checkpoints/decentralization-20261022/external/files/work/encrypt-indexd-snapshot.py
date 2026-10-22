from pathlib import Path
import subprocess,os,hashlib,json,datetime
root=Path('/home/steven/Documents/Codex/2026-10-18/wo');private=root/'work/private/indexd-recovery';dest=private/'indexd-full-20261019.tar.gpg';temp=dest.with_suffix('.part')
assert not dest.exists()
opts=['-o','BatchMode=yes','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(root/'work/ssh-%h-%p')]
# Only ciphertext is written locally; SSH protects the plaintext transport.
with (private/'full-encryption.log').open('wb') as log, temp.open('xb') as out:
 os.chmod(temp,0o600)
 source=subprocess.Popen(['ssh',*opts,'nan','tar -C /var/backups/enclave-indexd-20261019-consistent -cf - indexd.pgdump consensus.db indexd.yml indexd counts.json manifest.json'],stdout=subprocess.PIPE,stderr=log)
 encrypted=subprocess.run(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-file',str(private/'backup.pass'),'--symmetric','--cipher-algo','AES256','--compress-algo','zlib'],stdin=source.stdout,stdout=out,stderr=log)
 source.stdout.close();assert source.wait()==0 and encrypted.returncode==0,'snapshot encryption failed; inspect protected diagnostics'
temp.rename(dest)
h=hashlib.sha256()
with dest.open('rb') as f:
 for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
r={'encryptedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'file':dest.name,'bytes':dest.stat().st_size,'sha256':h.hexdigest(),'sourceSnapshot':json.loads((root/'work/indexd-consistent-snapshot-source.json').read_text()),'restored':False}
(root/'outputs/indexd-full-recovery-verification.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({'file':r['file'],'bytes':r['bytes'],'sha256':r['sha256']}))
