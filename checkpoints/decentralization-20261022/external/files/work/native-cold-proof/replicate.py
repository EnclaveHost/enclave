import pathlib,json,subprocess,hashlib,urllib.request,datetime
root=pathlib.Path(__file__).resolve().parent;archive=root/'artifacts.tar.gz';rows=json.loads((root/'entries.json').read_text());report=[]
archive_hash=hashlib.sha256(archive.read_bytes()).hexdigest()
script=r'''
import pathlib,json,hashlib,tarfile,base64,subprocess,urllib.request,time,sys,re,shutil,os
archive=pathlib.Path(sys.argv[1]);wanted=sys.argv[2]
def digest(file):
 h=hashlib.sha256()
 with open(file,'rb') as f:
  for b in iter(lambda:f.read(1<<20),b''):h.update(b)
 return h.hexdigest()
assert digest(archive)==wanted
cfg=json.load(open('/etc/enclave-bootstrap/config.json'));root=pathlib.Path(cfg['directory']);assert str(root)=='/opt/enclave-retained/cc96aad'
stage=root.parent/('native-cold-stage-'+wanted[:12]);stage.mkdir(exist_ok=True)
with tarfile.open(archive,'r:gz') as tar:
 for member in tar:
  assert member.isfile() and (member.name=='native-cold-entries.json' or re.fullmatch(r'b[a-z2-7]{58}\.bin',member.name)) and member.size<=512*1024*1024
  out=stage/member.name
  with tar.extractfile(member) as src,open(out,'wb') as dst:shutil.copyfileobj(src,dst,1<<20)
entries=json.load(open(stage/'native-cold-entries.json'))
for e in entries:
 raw=stage/(e['cid']+'.bin');assert raw.stat().st_size==e['bytes'] and digest(raw)==e['sha256']
 dest=root/raw.name
 if dest.exists():assert digest(dest)==e['sha256']
 else:raw.replace(dest)
 car=root/(e['cid']+'.car')
 if car.exists():assert digest(car)==e['carSha256']
 else:
  tmp=stage/(e['cid']+'.car')
  with open(tmp,'wb') as out,open(dest,'rb') as src:
   out.write(base64.b64decode(e['carPrefixBase64']));shutil.copyfileobj(src,out,1<<20)
  assert digest(tmp)==e['carSha256'];tmp.replace(car)
p=pathlib.Path(cfg['manifest']);m=json.load(open(p));old={e['cid']:e for e in m['verifiedObjects']};added=0
backup=p.with_name('manifest.before-native-cold.json')
if not backup.exists():backup.write_bytes(p.read_bytes())
for entry in entries:
 e={k:v for k,v in entry.items() if k!='carPrefixBase64'}
 if e['cid'] in old:assert old[e['cid']]['sha256']==e['sha256'] and old[e['cid']]['carSha256']==e['carSha256']
 else:m['verifiedObjects'].append(e);added+=1
if added:
 tmp=p.with_name('manifest.native-cold.next.json');tmp.write_text(json.dumps(m));tmp.replace(p)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
for n in range(180):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+entries[0]['cid'],timeout=3) as r:b=r.read()
  assert hashlib.sha256(b).hexdigest()==entries[0]['sha256'];break
 except Exception:time.sleep(1)
else:raise RuntimeError('replica has not finished verification')
# Read all newly supplied bytes over the actual public-artifact service.
for e in entries:
 h=hashlib.sha256();size=0
 with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+e['cid'],timeout=15) as r:
  for b in iter(lambda:r.read(1<<20),b''):size+=len(b);h.update(b)
 assert size==e['bytes'] and h.hexdigest()==e['sha256']
print(json.dumps({'ready':True,'objects':len(m['verifiedObjects']),'added':added,'readbackObjects':len(entries),'readbackBytes':sum(e['bytes'] for e in entries)}),flush=True)
shutil.rmtree(stage);archive.unlink()
'''
for host,ip in [('ca-east','146.190.246.39'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('us-west','134.199.235.187')]:
 opts=['-o','BatchMode=yes','-o','ConnectTimeout=10'];remote='/tmp/native-cold-'+archive_hash[:12]+'.tar.gz'
 print(json.dumps({'host':host,'phase':'transfer','archiveBytes':archive.stat().st_size}),flush=True)
 subprocess.run(['scp','-q',*opts,str(archive),host+':'+remote],check=True,timeout=120)
 print(json.dumps({'host':host,'phase':'verify-and-reload'}),flush=True)
 result=subprocess.run(['ssh',*opts,host,'python3','-',remote,archive_hash],input=script,text=True,capture_output=True,timeout=240)
 if result.returncode:raise RuntimeError(result.stderr[-1000:])
 row={'host':host,'origin':'http://'+ip+':8189/ipfs','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),**json.loads(result.stdout)}
 report.append(row);(root/'replicas.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(row),flush=True)
