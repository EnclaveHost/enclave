import hashlib,importlib.util,json,lzma
from pathlib import Path
p=Path.cwd();spec=importlib.util.spec_from_file_location('bundle',p/'offline-b3sum-bundle-stage/r2/b3bundle.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
src=p/'b3bundle-production-1516';signed=(src/'precheck/Release.signed').read_text();rel=m.parse_release(signed,'noble','universe')
b=(src/'Packages.xz').read_bytes();m.check_blob(b,*rel['xz'],'Packages.xz')
d=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=256<<20);first=d.decompress(b,max_length=(512<<20)+1)
r={'signedMetadataMatched':True,'xzBytes':len(b),'firstDecodedBytes':len(first),'firstEof':d.eof,'remainingBytes':len(d.unused_data),'remainingPrefixHex':d.unused_data[:32].hex(),'signedPlain':rel['plain']}
if d.eof and len(first)<512<<20:
 remaining=d.unused_data;all_parts=[first];total=len(first);count=1
 while remaining:
  assert count<32
  pad=len(remaining)-len(remaining.lstrip(b'\0'))
  if pad:assert pad%4==0;remaining=remaining[pad:]
  if not remaining:break
  x=lzma.LZMADecompressor(format=lzma.FORMAT_XZ,memlimit=256<<20);part=x.decompress(remaining,max_length=(512<<20)-total+1)
  total+=len(part);assert total<=512<<20 and x.eof
  all_parts.append(part);remaining=x.unused_data;count+=1
 full=b''.join(all_parts);m.check_blob(full,*rel['plain'],'Packages')
 candidates=[]
 for block in full.split(b'\n\n'):
  if block.startswith(b'Package: b3sum\n'):
   fields=dict(line.split(': ',1) for line in block.decode().splitlines() if ': ' in line and not line.startswith(' '))
   candidates.append({k:fields.get(k) for k in ['Package','Version','Architecture','Filename','SHA256','Size']})
 r.update(streams=count,plainBytes=len(full),plainSha256=hashlib.sha256(full).hexdigest(),plainMatched=True,b3sumCandidates=candidates)
Path('logs/b3bundle-xz-inspect-1517.json').write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r,indent=2))
