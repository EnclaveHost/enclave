import pathlib,json,hashlib,subprocess,urllib.request,datetime,sys,base64
root=pathlib.Path(__file__).resolve().parent
sys.path.insert(0,str(root.parent/'enclave/wasm'))
from ipfs_fetch import verify_car
raw=(root.parent/'bootstrap-hardware/package.json').read_bytes();p=json.loads(raw)
assert p['secretsMode']=='public' and 'custody' not in p and p['deployment']=='0x87508b958c4d14381b58fe05a781efbd3f185a36d5239abdf37e8f242f944538'
assert json.loads(p['configText'])=={'recursion':False,'ens':False,'onion':False,'zones':[],'listen':{'http':8000,'dns':0,'dot':0},'wasi':'0.2'}
digest=hashlib.sha256(raw).digest();cidbytes=b'\x01\x55\x12\x20'+digest;cid='b'+base64.b32encode(cidbytes).decode().lower().rstrip('=')
def vint(n):
 b=[]
 while n>127:b.append((n&127)|128);n>>=7
 return bytes(b+[n])
header=b'\xa2\x65roots\x81\xd8\x2a\x58\x25\x00'+cidbytes+b'\x67version\x01'
car=vint(len(header))+header+vint(len(cidbytes)+len(raw))+cidbytes+raw
assert verify_car(cid,car,len(raw))==raw
for ext,data in [('bin',raw),('car',car)]: (root/(cid+'.'+ext)).write_bytes(data)
e={'cid':cid,'bytes':len(raw),'sha256':digest.hex(),'carSha256':hashlib.sha256(car).hexdigest(),'source':'owner-committed-native-startup','verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()};(root/'entry.json').write_text(json.dumps(e))
script=r'''
import pathlib,json,hashlib,subprocess,urllib.request,time
cfg=json.load(open('/etc/enclave-bootstrap/config.json'));r=pathlib.Path(cfg['directory']);e=json.loads((r/'native-startup-entry.json').read_text())
for ext,key in [('bin','sha256'),('car','carSha256')]:
 assert hashlib.sha256((r/(e['cid']+'.'+ext)).read_bytes()).hexdigest()==e[key]
p=pathlib.Path(cfg['manifest']);m=json.loads(p.read_text());existing=[x for x in m['verifiedObjects'] if x['cid']==e['cid']]
if existing:assert existing[0]['sha256']==e['sha256'] and existing[0]['carSha256']==e['carSha256']
else:
 backup=p.with_name('manifest.before-native-startup.json')
 if not backup.exists():backup.write_bytes(p.read_bytes())
 m['verifiedObjects'].append(e);tmp=p.with_name('manifest.native-startup.next.json');tmp.write_text(json.dumps(m));tmp.replace(p)
 subprocess.run(['systemctl','restart','enclave-bootstrap-gateway'],check=True)
for i in range(150):
 try:
  with urllib.request.urlopen('http://127.0.0.1:8189/ipfs/'+e['cid'],timeout=3) as response:b=response.read()
  assert hashlib.sha256(b).hexdigest()==e['sha256'];print(json.dumps({'ready':True,'objects':len(m['verifiedObjects'])}));break
 except Exception:time.sleep(1)
else:raise RuntimeError('replica not ready')
'''
report=[]
for host,ip in [('ca-east','146.190.246.39'),('eu-central','134.209.248.172'),('ap-southeast','165.245.191.129'),('us-west','134.199.235.187')]:
 opts=['-o','BatchMode=yes','-o','ConnectTimeout=10']
 config=subprocess.check_output(['ssh',*opts,host,'cat /etc/enclave-bootstrap/config.json'],text=True,timeout=20);remote=json.loads(config)['directory'];assert remote=='/opt/enclave-retained/cc96aad'
 subprocess.run(['scp','-q',*opts,str(root/(cid+'.bin')),str(root/(cid+'.car')),host+':'+remote+'/'],check=True,timeout=30)
 subprocess.run(['scp','-q',*opts,str(root/'entry.json'),host+':'+remote+'/native-startup-entry.json'],check=True,timeout=30)
 result=subprocess.run(['ssh',*opts,host,'python3','-'],input=script,text=True,capture_output=True,timeout=180)
 if result.returncode:raise RuntimeError(result.stderr[-800:])
 with urllib.request.urlopen('http://'+ip+':8189/ipfs/'+cid,timeout=15) as response:assert response.read()==raw
 row={'host':host,'origin':'http://'+ip+':8189/ipfs','cid':cid,'verified':True,'service':json.loads(result.stdout)}
 report.append(row);(root/'replicas.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(row),flush=True)
