import json,os,struct,subprocess
from pathlib import Path
p=Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/base-journal-copy-1626');b=Path('/home/steven/Documents/Codex/2026-10-26/my');image=b/'work/tr004-readonly/enclave-rpc-production/base-origin.qcow2'
assert 'ro' in subprocess.check_output(['findmnt','-rn','-T',str(image),'-o','OPTIONS'],text=True).strip().split(',')
r=max((r for r in json.loads((p/'inode-candidates.json').read_text()) if r['size']==1138166333440 and r['links']==1 and r['dtime']==0),key=lambda r:r['sequence'])
x=bytes.fromhex(r['extentRoot']); logical,lo,hi,unused=struct.unpack_from('<IIHH',x,12);block=lo+(hi<<32);assert 0<block<976562500
fd=os.open(b/'work/tr004/base-view/nbd',os.O_RDONLY); data=os.pread(fd,4096,block*4096);os.close(fd);assert len(data)==4096
(p/'candidate-extent-index.bin').write_bytes(data)
print(json.dumps({'inodeCandidate':1950053,'generation':r['generation'],'journalSequence':r['sequence'],'physicalBlock':block,'header':struct.unpack_from('<HHHHI',data),'firstEntriesHex':data[:72].hex(),'checksumVerified':False},indent=2))
