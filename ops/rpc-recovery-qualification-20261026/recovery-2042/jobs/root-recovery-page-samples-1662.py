import hashlib,json,os,subprocess
from pathlib import Path
P=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025');B=Path('/home/steven/Documents/Codex/2026-10-26/my');i=B/'work/tr004-readonly/enclave-rpc-production/base-origin.qcow2';v=B/'work/tr004/base-view/nbd';o=P/'logs/base-journal-copy-1626/page-samples';assert not o.exists()
d=json.loads((P/'ext4-recovery-checksum-stage/r2/runs/real-20261026T203730Z-2323458/ext4-candidate-checksums.json').read_text());assert d['metadataChecksumsValid'] and not d['problems'];ex=d['map']['extentList'];old=json.loads((P/'logs/base-journal-copy-1626/candidate-extent-coverage.json').read_text())['extents'];assert ex==[[x['logical'],x['blocks'],x['physical'],x['unwritten']] for x in old]
assert 'ro' in subprocess.check_output(['findmnt','-rn','-T',str(i),'-o','OPTIONS'],text=True).strip().split(',');assert Path('/proc/2253798/fd/10').resolve()==i
before=i.stat();o.mkdir(mode=0o700);fd=os.open(v,os.O_RDONLY);rows=[]
try:
 for name,e,n in [('first-4-pages',ex[0],4),('middle-page',ex[len(ex)//2],1),('last-extent-first-page',ex[-1],1)]:
  assert e[1]>=n and not e[3];b=os.pread(fd,4096*n,e[2]*4096);assert len(b)==4096*n
  f=os.open(o/(name+'.bin'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);os.write(f,b);os.close(f)
  rows.append({'name':name,'logicalBlock':e[0],'physicalBlock':e[2],'bytes':len(b),'allZero':not any(b),'sha256':hashlib.sha256(b).hexdigest(),'first32Hex':b[:32].hex()})
finally:os.close(fd)
after=i.stat();assert all(getattr(before,k)==getattr(after,k) for k in ['st_size','st_ino','st_mtime_ns','st_ctime_ns']);r={'readOnly':True,'sourceUnchanged':True,'samples':rows,'databaseValidated':False};(o/'record.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
