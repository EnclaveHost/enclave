import json,struct,datetime
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/base-journal-copy-1626')
d=json.loads((p/'inventory-r1.json').read_text()); rows=[]
with (p/'journal-8.bin').open('rb') as f:
 for c in d['targets']['candidates']['499122230']:
  f.seek(c['imageByteOffset']+1024); b=f.read(256)
  u=lambda o:struct.unpack_from('<I',b,o)[0]
  s=lambda o:struct.unpack_from('<H',b,o)[0]
  rows.append(dict(sequence=c['sequence'],journalBlock=c['imageJournalBlock'],commitUtc=datetime.datetime.fromtimestamp(c['commitSec'],datetime.timezone.utc).isoformat(),mode=s(0),size=u(4)+(u(108)<<32),links=s(26),dtime=u(20),generation=u(100),extentMagic=hex(s(40)),extentEntries=s(42),extentDepth=s(46),extentRoot=b[40:100].hex(),checksumVerified=False))
(p/'inode-candidates.json').write_text(json.dumps(rows,indent=2)+'\n')
print('candidateCount',len(rows));print('generations',sorted(set(r['generation'] for r in rows)));print(json.dumps(sorted(rows,key=lambda r:(r['size'],r['sequence']),reverse=True)[:8],indent=2))
