from pathlib import Path
import gzip,hashlib,json,stat,subprocess
root=Path(__file__).resolve().parent
baseline=root/'inputs/runtime-baseline.cpio.gz'
sha=lambda b:hashlib.sha256(b).hexdigest()
packed=baseline.read_bytes();assert sha(packed)=='f86fb512a552554217769a347c8f5b1e3eb5b3a95dfecd9d3a5d0680e808d227'
data=gzip.decompress(packed);entries=[];offset=0;seen=set()
while True:
 assert data[offset:offset+6]==b'070701'
 f=[int(data[offset+6+i*8:offset+14+i*8],16) for i in range(13)];offset+=110
 namesize=f[11];raw=data[offset:offset+namesize];assert raw[-1:]==b'\0';name=raw[:-1].decode();offset=(offset+namesize+3)&~3
 body=data[offset:offset+f[6]];assert len(body)==f[6];offset=(offset+f[6]+3)&~3
 if name=='TRAILER!!!':break
 key=name.removeprefix('./');assert key and not key.startswith('/') and '..' not in key.split('/') and key not in seen;seen.add(key)
 assert stat.S_ISREG(f[1]) or stat.S_ISDIR(f[1]),name
 entries.append({'name':name,'key':key,'mode':f[1],'nlink':f[4],'data':body})
replacements={'init':'init','plat/domexec':'domexec','plat/front':'front','monitor':'monitor','plat/secretrun':'secretrun'}
assert set(replacements)<=seen
manifest=[]
for e in entries:
 oldsha=sha(e['data']);k=e['key']
 if k in replacements:e['data']=(root/'bin'/replacements[k]).read_bytes()
 manifest.append({'path':k,'mode':oct(e['mode']),'bytes':len(e['data']),'sha256':sha(e['data']),'baselineSha256':oldsha,'recompiled':k in replacements})
 if k=='plat/rt/runtime.json':(root/'runtime.json').write_bytes(e['data'])
def pack(out):
 with out.open('wb') as sink, gzip.GzipFile(filename='',fileobj=sink,mode='wb',compresslevel=9,mtime=0) as gz:
  count=0
  for i,e in enumerate(sorted(entries,key=lambda e:e['name'])):
   name=e['name'].encode()+b'\0';body=e['data'];fields=[i+1,e['mode'],0,0,e['nlink'],0,len(body),0,0,0,0,len(name),0]
   header=b'070701'+''.join(f'{v:08x}' for v in fields).encode();gz.write(header);gz.write(name);n=110+len(name);pad=(-n)%4;gz.write(b'\0'*pad);gz.write(body);gz.write(b'\0'*((-len(body))%4));count+=n+pad+len(body)+(-len(body))%4
  name=b'TRAILER!!!\0';fields=[0,0,0,0,1,0,0,0,0,0,0,len(name),0];gz.write(b'070701'+''.join(f'{v:08x}' for v in fields).encode());gz.write(name);n=110+len(name);gz.write(b'\0'*((-n)%4));count+=n+(-n)%4;gz.write(b'\0'*((-count)%512))
pack(root/'shield-direct.cpio.gz');pack(root/'shield-direct-again.cpio.gz')
a=(root/'shield-direct.cpio.gz').read_bytes();assert a==(root/'shield-direct-again.cpio.gz').read_bytes()
report={'sourceCommit':'0ed5a8ba','sourceArchiveSha256':sha((root/'source.tar').read_bytes()),'baselineInitrdSha256':sha(packed),'initrdSha256':sha(a),'initrdBytes':len(a),'assemblyRepeatable':True,'compilerReproductionIndependent':False,'goToolchain':subprocess.check_output(['go','version'],text=True).strip(),'gcc':subprocess.check_output(['gcc','--version'],text=True).splitlines()[0],'frontBuildTags':['bootstrapdirect','shielddirect'],'preservedBaselineFiles':len(entries)-len(replacements),'files':manifest,'hardwareActivated':False}
(root/'initrd-build.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='files'}))
