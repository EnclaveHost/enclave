from pathlib import Path
import subprocess,tarfile,hashlib,json,datetime
p=Path('outputs/storage-post-cutover-backup.json');r=json.loads(p.read_text());private=Path('work/private/indexd-recovery');log=(private/'post-cutover-backup-verify.log').open('ab')
proc=subprocess.Popen(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',str(private/'backup.pass'),'--decrypt',str(private/r['file'])],stdout=subprocess.PIPE,stderr=log)
seen={};manifest=None
with tarfile.open(fileobj=proc.stdout,mode='r|') as archive:
 for member in archive:
  assert member.isfile() and member.name in [*r['sourceSnapshot']['files'],'manifest.json']
  f=archive.extractfile(member)
  if member.name=='manifest.json':manifest=json.loads(f.read())
  else:seen[member.name]=hashlib.file_digest(f,'sha256').hexdigest()
 # Consume padding to force GPG to check the authenticated end of the stream.
 proc.stdout.read()
assert proc.wait()==0 and manifest==r['sourceSnapshot']
assert set(seen)==set(manifest['files'])
for name,h in seen.items():assert h==manifest['files'][name]['sha256']
# Keep separate from the concurrently updated replica manifest.
result={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive':r['file'],'authenticatedDecryptionPassed':True,'allSnapshotFileHashesVerified':True,'plaintextPersistedLocally':False,'counts':manifest['counts']}
Path('outputs/storage-post-cutover-backup-integrity.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
