import json,struct,hashlib
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/base-journal-copy-1626')
r=json.loads((p/'record.json').read_text()); assert r['sourceUnchanged'] and r['journalBytes']==1073741824
h=hashlib.sha256(); matches=[]; total=0
with (p/'journal-8.bin').open('rb') as f:
 for block in range(262144):
  b=f.read(4096); assert len(b)==4096; h.update(b); at=0
  while True:
   at=b.find(b'mdbx.dat',at)
   if at<0: break
   total+=1
   if len(matches)<256:
    row={'journalBlock':block,'nameOffset':at,'authenticated':False}
    if at>=8:
     ino,reclen,nlen,typ=struct.unpack_from('<IHBB',b,at-8)
     row.update(inodeCandidate=ino,recordLength=reclen,nameLength=nlen,fileType=typ,plausibleDirectoryEntry=bool(ino>0 and nlen==8 and typ==1 and reclen>=16 and reclen%4==0 and at-8+reclen<=4096))
    matches.append(row)
   at+=8
assert h.hexdigest()==r['journalSha256']
o={'totalNameMatches':total,'matches':matches,'truncated':total>256,'authenticated':False,'recoveryProven':False,'sha256':h.hexdigest()}
(p/'name-candidates.json').write_text(json.dumps(o,indent=2)+'\n'); print(json.dumps(o,indent=2))
