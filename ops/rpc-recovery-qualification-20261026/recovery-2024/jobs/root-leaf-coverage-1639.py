import json,struct
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/base-journal-copy-1626');d=json.loads((p/'inventory-leaves.json').read_text());leaves=json.loads((p/'candidate-leaf-addresses.json').read_text());ext=[];picked=[];missing=[]
with (p/'journal-8.bin').open('rb') as f:
 for leaf in leaves:
  found=None
  for c in sorted(d['targets']['candidates'][str(leaf['block'])],key=lambda c:c['sequence'],reverse=True):
   if c['sequence']>17169:continue
   f.seek(c['imageByteOffset']);b=f.read(4096);magic,n,mx,depth,gen=struct.unpack_from('<HHHHI',b)
   if magic!=0xf30a or depth!=0 or not 0<n<=mx<=340:continue
   rows=[]
   for n0 in range(n):
    logical,length,hi,lo=struct.unpack_from('<IHHI',b,12+12*n0);unwritten=length>32768; length=length-32768 if unwritten else length
    rows.append({'logical':logical,'blocks':length,'physical':lo+(hi<<32),'unwritten':unwritten})
   if rows[0]['logical']!=leaf['logicalStart']:continue
   found=c;ext.extend(rows);picked.append({'block':leaf['block'],'sequence':c['sequence'],'journalBlock':c['imageJournalBlock'],'entries':len(rows)});break
  if found is None:missing.append(leaf)
end=0;gaps=[];overlaps=[]
for x in sorted(ext,key=lambda x:x['logical']):
 if x['logical']>end:gaps.append([end,x['logical']])
 if x['logical']<end:overlaps.append([x['logical'],end])
 end=max(end,x['logical']+x['blocks'])
expected=(1138166333440+4095)//4096
if end<expected:gaps.append([end,expected])
o={'authentication':'unchecked candidates only','expectedBlocks':expected,'endBlock':end,'missingLeaves':missing,'gaps':gaps,'overlaps':overlaps,'picked':picked,'extents':ext,'recoveryProven':False};(p/'candidate-extent-coverage.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps({k:v for k,v in o.items() if k not in ('extents','picked')},indent=2));print('extents',len(ext),'pickedLeaves',len(picked))
