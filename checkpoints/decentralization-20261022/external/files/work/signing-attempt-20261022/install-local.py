from pathlib import Path
import hashlib,json,os,shutil,signal
root=Path(__file__).resolve().parents[2]
base=root/'work/enclavedns-stale-20261021/wallet-handoff'
candidate=Path(__file__).resolve().parent/'wallet-handoff'
backup=candidate.parent/'rollout'; backup.mkdir(exist_ok=False)
sha=lambda b:hashlib.sha256(b).hexdigest()
old=base/'files.lock.json'; oldbytes=old.read_bytes(); lock=json.loads(oldbytes)
assert sha(oldbytes)=='c41681344b69000259e1b700f5913075c274c244b83522cb17b2cb5f70e6c901'
for f,h in lock['files'].items(): assert sha((base/f).read_bytes())==h,f
journals={p.name:sha(p.read_bytes()) for p in (base/'journals').glob('*.json')}
assert journals==json.loads((root/'outputs/enclavedns-release/signing-test-current.json').read_text())['journalHashes']
pid=249067
proc=Path('/proc')/str(pid)
expected=['node','serve.mjs','--approved-plan','sha256:bd074a6bd01cff351d666ad0e80bf378c4cac06e895ec2d8830ffe24577cd46f','--approved-files','sha256:'+sha(oldbytes),'--serve']
assert proc.joinpath('cmdline').read_bytes().decode().rstrip('\x00').split('\x00')==expected
assert proc.joinpath('cwd').resolve()==base
for name in ('server.mjs','app.js','files.lock.json'): shutil.copy2(base/name,backup/name)
for name in ('server.mjs','app.js'):
 data=(candidate/name).read_bytes(); lock['files'][name]=sha(data)
newbytes=(json.dumps(lock,indent=1)+'\n').encode()
receipt={'journals':journals,'oldPid':pid,'newFilesLockSha256':sha(newbytes),'files':{k:lock['files'][k] for k in ('app.js','server.mjs')},'plan':'bd074a6bd01cff351d666ad0e80bf378c4cac06e895ec2d8830ffe24577cd46f'}
(backup/'before.json').write_text(json.dumps(receipt,indent=2)+'\n')
for name in ('server.mjs','app.js'):
 tmp=base/(name+'.attempt-patch.tmp'); tmp.write_bytes((candidate/name).read_bytes()); os.replace(tmp,base/name)
tmp=base/'files.lock.json.attempt-patch.tmp'; tmp.write_bytes(newbytes); os.replace(tmp,old)
assert {p.name:sha(p.read_bytes()) for p in (base/'journals').glob('*.json')}==journals
print(json.dumps(receipt))
# Server retains loaded source until root's separate, identity-checked restart. No requests are sent here.
