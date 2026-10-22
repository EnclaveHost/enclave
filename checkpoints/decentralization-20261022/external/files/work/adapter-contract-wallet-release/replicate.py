import pathlib,json,hashlib,subprocess,urllib.request,time,datetime,sys
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
cid='bafybeia5dmbhfmpgjhu45fgwu4me2k5ucfr23ssuz24ugrlzm46jywlevq';base=pathlib.Path('work/adapter-contract-wallet-cas');raw=(base/(cid+'.bin')).read_bytes();car=(base/(cid+'.car')).read_bytes();assert verify_car(cid,car,len(raw))==raw
row={'cid':cid,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'adapter-contract-wallet-50f93d74','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(base/'entry.json').write_text(json.dumps(row));remote='/opt/enclave-retained/cc96aad';report=[]
script=r'''
import pathlib,json,hashlib,subprocess,urllib.request,time,fcntl,os
lock=open("/opt/enclave-retained/.manifest-update.lock","a+");fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
r=pathlib.Path('/opt/enclave-retained/cc96aad');e=json.loads((r/'adapter-wallet-50f93d74-entry.json').read_text());
for ext,k in [('bin','sha256'),('car','carSha256')]:
 assert hashlib.sha256((r/(e['cid']+'.'+ext)).read_bytes()).hexdigest()==e[k]
p=r/'manifest.json';m=json.loads(p.read_text());old=p.read_text();backup=r/'manifest.before-adapter-wallet-50f93d74.json'
if not backup.exists():backup.write_text(old)
existing=[x for x in m['verifiedObjects'] if x['cid']==e['cid']]
if existing:assert existing[0]['sha256']==e['sha256']
else:m['verifiedObjects'].append(e)
n=r/'manifest.adapter-wallet-50f93d74.next.json'
with open(n,'w') as f:f.write(json.dumps(m));f.flush();os.fsync(f.fileno())
n.replace(p)
fd=os.open(str(r),os.O_RDONLY);os.fsync(fd);os.close(fd)
if not existing:subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
for i in range(360):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+e['cid'],timeout=3) as q:b=q.read()
  assert hashlib.sha256(b).hexdigest()==e['sha256'];print(json.dumps({'ready':True,'objects':len(m['verifiedObjects'])}));break
 except Exception:time.sleep(1)
else:raise RuntimeError('replica not ready')
'''
for host,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(pathlib.Path('work/ssh-%h-%p').resolve())]
 subprocess.run(['scp','-q',*opts,str(base/(cid+'.bin')),str(base/(cid+'.car')),host+':'+remote+'/'],check=True,timeout=45)
 subprocess.run(['scp','-q',*opts,str(base/'entry.json'),host+':'+remote+'/adapter-wallet-50f93d74-entry.json'],check=True,timeout=30)
 r=subprocess.run(['ssh',*opts,host,'python3','-'],input=script,text=True,capture_output=True,timeout=1500);assert r.returncode==0,r.stderr[-600:]
 with urllib.request.urlopen('http://'+ip+':8189/ipfs/'+cid,timeout=15) as q:assert q.read()==raw
 report.append({'host':host,'origin':'http://'+ip+':8189','verified':True});print(json.dumps(report[-1]),flush=True)
 pathlib.Path('outputs/adapter-contract-wallet-release/replicas.json').write_text(json.dumps(report,indent=2)+'\n')
p=pathlib.Path('outputs/adapter-contract-wallet-release/upload.json');a=json.loads(p.read_text());a.update(verifiedReadback=True,verifiedOrigins=[x['origin'] for x in report],artifactSourceCommit='50f93d74c5a41acb8df73c8ae094d8c9fb05e666',verifiedCopies=5,note='New component uploaded and byte-verified through the live adapter, then independently CID/CAR-verified and copied to four existing public artifact replicas. Catalog publication and runtime upgrade have not occurred; these hosts are all Enclave-operated.');p.write_text(json.dumps(a,indent=2)+'\n')
