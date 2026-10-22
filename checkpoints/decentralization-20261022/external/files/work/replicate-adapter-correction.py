import pathlib,json,hashlib,subprocess,urllib.request,time,datetime,sys
sys.path.insert(0,str(pathlib.Path('work/enclave/wasm').resolve()))
from ipfs_fetch import verify_car
cid='bafybeihnfbvrrnuioglduqx6k4hniceutqthzg6aawnaeeyhds3vx2gl7q';base=pathlib.Path('work/adapter-correction-cas');raw=(base/(cid+'.bin')).read_bytes();car=(base/(cid+'.car')).read_bytes();assert verify_car(cid,car,len(raw))==raw
row={'cid':cid,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'corrected-adapter-d4a755b','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(base/'entry.json').write_text(json.dumps(row));remote='/opt/enclave-retained/cc96aad';report=[]
script=r'''
import pathlib,json,hashlib,subprocess,urllib.request,time
r=pathlib.Path('/opt/enclave-retained/cc96aad');e=json.loads((r/'correction-entry.json').read_text());
for ext,k in [('bin','sha256'),('car','carSha256')]:
 assert hashlib.sha256((r/(e['cid']+'.'+ext)).read_bytes()).hexdigest()==e[k]
p=r/'manifest.json';m=json.loads(p.read_text());old=p.read_text();backup=r/'manifest.before-adapter-correction.json'
if not backup.exists():backup.write_text(old)
existing=[x for x in m['verifiedObjects'] if x['cid']==e['cid']]
if existing:assert existing[0]['sha256']==e['sha256']
else:m['verifiedObjects'].append(e)
n=r/'manifest.correction.next.json';n.write_text(json.dumps(m));n.replace(p)
if not existing:subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
for i in range(150):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+e['cid'],timeout=3) as q:b=q.read()
  assert hashlib.sha256(b).hexdigest()==e['sha256'];print(json.dumps({'ready':True,'objects':len(m['verifiedObjects'])}));break
 except Exception:time.sleep(1)
else:raise RuntimeError('replica not ready')
'''
for host,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('ca-east','146.190.246.39')]:
 opts=['-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ControlMaster=auto','-o','ControlPersist=60','-o','ControlPath='+str(pathlib.Path('work/ssh-%h-%p').resolve())]
 subprocess.run(['scp','-q',*opts,str(base/(cid+'.bin')),str(base/(cid+'.car')),host+':'+remote+'/'],check=True,timeout=45)
 subprocess.run(['scp','-q',*opts,str(base/'entry.json'),host+':'+remote+'/correction-entry.json'],check=True,timeout=30)
 r=subprocess.run(['ssh',*opts,host,'python3','-'],input=script,text=True,capture_output=True,timeout=180);assert r.returncode==0,r.stderr[-600:]
 with urllib.request.urlopen('http://'+ip+':8189/ipfs/'+cid,timeout=15) as q:assert q.read()==raw
 report.append({'host':host,'origin':'http://'+ip+':8189','verified':True});print(json.dumps(report[-1]),flush=True)
 pathlib.Path('outputs/adapter-correction/replicas.json').write_text(json.dumps(report,indent=2)+'\n')
p=pathlib.Path('outputs/adapter-correction/upload.json');a=json.loads(p.read_text());a.update(verifiedReadback=True,verifiedOrigins=[x['origin'] for x in report],artifactSourceCommit='d4a755b',note='Upload to the currently regressed adapter timed out. The exact CID and bytes are verified on four existing host bootstrap origins.');p.write_text(json.dumps(a,indent=2)+'\n')
