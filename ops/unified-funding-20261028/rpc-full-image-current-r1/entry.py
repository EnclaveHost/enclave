from pathlib import Path
import gzip,hashlib,importlib.util,json,os,stat,subprocess,time,unittest
p=Path('/output');started=time.monotonic();rows=[]
def run(label,argv,seconds):
 with (p/(label+'.log')).open('x') as log:r=subprocess.run(argv,stdout=log,stderr=log,timeout=min(seconds,max(.01,180-(time.monotonic()-started))),cwd='/src/test/rpc-server')
 rows.append({'phase':label,'exit':r.returncode});assert r.returncode==0,label
run('build',['/usr/bin/python3','-B','/src/isolation/m3/build-rpc.py','--spec','/spec.json','--out','/output/image'],145)
s=importlib.util.spec_from_file_location('readback','/src/test/rpc-server/test_rpc_image_build.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.loads((p/'image/build.json').read_text());spec=json.loads(Path('/spec.json').read_text())
gz=p/'image/rpc.cpio.gz'
assert hashlib.file_digest(gz.open('rb'),'sha256').hexdigest()==r['initrd']['sha256']
with gzip.open(gz,'rb') as f:raw=f.read((128<<20)+1);assert not f.read(1)
assert len(raw)<=128<<20 and len(raw)==r['cpioBytes'] and hashlib.sha256(raw).hexdigest()==r['cpioSha256']
entries=m.read_cpio(raw);assert set(entries)=={e['path'] for e in r['entries']}
extract=p/'readback';extract.mkdir()
for e in r['entries']:
 name=e['path'];data,mode,kind=entries[name];assert mode==e['mode']
 dest=extract/name
 if e['type']=='dir':
  assert kind==stat.S_IFDIR
  if name!='.':dest.mkdir()
 else:
  assert kind==stat.S_IFREG and len(data)==e['bytes'] and hashlib.sha256(data).hexdigest()==e['sha256']
  with dest.open('xb') as f:f.write(data)
 os.chmod(dest,mode)
profile=json.loads(entries['plat/native-rpc/profile.json'][0]);m.build.boot.profile(entries['plat/native-rpc/profile.json'][0])
assert hashlib.sha256(entries['plat/native-rpc/profile.json'][0]).hexdigest()==r['profileSha256']
for key,path in [('entrySha256','plat/native-rpc/rpc-native-init'),('wrapperSha256','plat/native-rpc/chain_service.py')]:assert hashlib.sha256(entries[path][0]).hexdigest()==profile[key]
assert profile['controllerSha256']==spec['controller']['sha256']
assert hashlib.sha256(entries['plat/native-rpc/nbd.ko'][0]).hexdigest()==spec['nbd']['sha256']
assert m.build.module_info(entries['plat/native-rpc/nbd.ko'][0])==r['nbdVermagic']
assert not any('native-desktop' in n or n.endswith('.wasm') for n in entries)
assert not any(hashlib.sha256(v[0]).hexdigest()==profile['controllerSha256'] for v in entries.values())
for role in ('image','hash'):
 c=r['containers'][role];path=p/'image'/c['path'];assert path.stat().st_size==c['bytes']==profile['root'][role+'Bytes']+65536
 with path.open('rb') as f:
  assert f.read(65536)==bytes(65536)
  assert hashlib.file_digest(f,'sha256').hexdigest()==spec['root'][role]['sha256']
 assert hashlib.file_digest(path.open('rb'),'sha256').hexdigest()==c['sha256']
for flag in ('platformAccepted','brokerProvisioned','rpcReady','deployed'):assert r[flag] is False
result={'phases':rows,'strictArchiveReadback':True,'entries':len(entries),'containersVerified':True,'nbdLoaded':False,'guestBooted':False,'deployed':False,'elapsed':time.monotonic()-started,'profileSha256':r['profileSha256'],'initrd':r['initrd'],'containers':r['containers']}
(p/'READBACK.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
