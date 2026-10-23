import pathlib,subprocess,json,argparse,datetime
p=pathlib.Path(__file__).resolve().parent;a=argparse.ArgumentParser();a.add_argument('mode',choices=['read','apply','rollback']);mode=a.parse_args().mode
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo python3 -']
base={'mode':mode,'old':'8414496cd0d2af2a49ec0476f69b901bef04cea5d3b52b2347b81e1ef3f14b23','new':'62ac7aab7700ea41ace82549751ee8797a8e087502bf04ad96c0003727a6b535'}
if mode!='read':base['expected']=json.loads((p/'relay-policy-read.json').read_text())['policySha256']
if mode=='rollback':base['applied']=json.loads((p/'relay-policy-apply.json').read_text())['policySha256']
src=r'''
import pathlib,subprocess,json,hashlib,copy,os,time,urllib.request,datetime
cfg=CONFIG
unit='enclave-api-relay';pid=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip());assert pid>1
key=b'RELAY_SHIELD_MARKET_POLICY=';vals=[v[len(key):].decode() for v in pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0') if v.startswith(key)];assert len(vals)==1,'Expected marketplace policy configured'
f=pathlib.Path(vals[0]);assert f.is_absolute();raw=f.read_bytes();sha=lambda b:hashlib.sha256(b).hexdigest();j=json.loads(raw);assert j['schema']=='enclave-shield-app-policy/1'
bak=f.with_name(f.name+'.pre-cpu-quota-20261023');out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':cfg['mode'],'pidBefore':pid,'policyPath':str(f),'beforeSha256':sha(raw)}
if cfg['mode']=='apply':
 assert sha(raw)==cfg['expected'],'Policy changed';assert not bak.exists(),'Backup already exists'
 old=[x for x in j['images'] if x['measurement']==cfg['old']];assert len(old)==1;assert not any(x['measurement']==cfg['new'] for x in j['images'])
 n=copy.deepcopy(j);e=copy.deepcopy(old[0]);e['measurement']=cfg['new'];n['images'].append(e)
 check=copy.deepcopy(n);check['images'].pop();assert check==j
 target=(json.dumps(n,indent=2)+'\n').encode();st=f.stat()
 with open(bak,'xb') as w:w.write(raw);w.flush();os.fsync(w.fileno())
 os.chmod(bak,st.st_mode&0o777);os.chown(bak,st.st_uid,st.st_gid)
 tmp=f.with_name(f.name+'.cpu-quota.tmp');assert not tmp.exists()
 with open(tmp,'xb') as w:w.write(target);w.flush();os.fsync(w.fileno())
 os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid);assert sha(f.read_bytes())==cfg['expected'];os.replace(tmp,f)
 subprocess.run(['systemctl','restart',unit],check=True,timeout=35)
 out['addedEntry']=e;out['unchangedOriginalPolicy']=True;out['backup']=str(bak)
elif cfg['mode']=='rollback':
 assert sha(raw)==cfg['applied'];b=bak.read_bytes();assert sha(b)==cfg['expected'];st=f.stat();tmp=f.with_name(f.name+'.rollback.tmp');assert not tmp.exists();tmp.write_bytes(b);os.chmod(tmp,st.st_mode&0o777);os.chown(tmp,st.st_uid,st.st_gid);os.replace(tmp,f);subprocess.run(['systemctl','restart',unit],check=True,timeout=35)
if cfg['mode']!='read':
 for i in range(20):
  try:
   with urllib.request.urlopen('http://127.0.0.1:8100/health',timeout=2) as r:out['health']=r.status
   if out['health']==200:break
  except Exception:time.sleep(1)
 out['pidAfter']=int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip())
now=f.read_bytes();j=json.loads(now);out.update({'policySha256':sha(now),'cpu':j.get('cpu'),'matchingImages':[x for x in j['images'] if x['measurement'] in [cfg['old'],cfg['new']]],'imageCount':len(j['images'])});print(json.dumps(out))
'''.replace('CONFIG',repr(base))
r=subprocess.run(ssh,input=src,text=True,capture_output=True,timeout=80)
if r.returncode:raise SystemExit('Relay policy step failed; inspect state before retry: '+r.stderr[-700:])
o=json.loads(r.stdout);(p/('relay-policy-'+mode+'.json')).write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o));assert mode=='read' or o.get('health')==200
