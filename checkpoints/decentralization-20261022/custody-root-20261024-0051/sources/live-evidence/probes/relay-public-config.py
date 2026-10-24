"""Read-only relay inventory: public environment allowlist, source hashes, encrypted-store metadata/count only."""
import subprocess,json,pathlib,datetime,hashlib
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo python3 -']
remote=r'''
import subprocess,json,pathlib,hashlib,datetime
pid=int(subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip());assert pid>1
raw=pathlib.Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
env={x.split(b'=',1)[0].decode():x.split(b'=',1)[1].decode() for x in raw if b'=' in x};del raw
allowed=['ADDRESS_BOOK_ADDRESS','CUSTODY_VAULT','CUSTODY_VAULT_V2','CUSTODY_COMMITTEE','CUSTODY_COMMITTEE_V2','AUTH_DATA_DIR','ATTESTED_SHIELD_POLICY']
public={k:env.get(k) for k in allowed};del env
root=pathlib.Path('/opt/nan-relay');names=['api-relay.js','secrets.js','relay/custody-state.mjs']
source={n:hashlib.file_digest(open(root/n,'rb'),'sha256').hexdigest() if (root/n).is_file() else None for n in names}
policy=None
pp=public.get('ATTESTED_SHIELD_POLICY')
if pp:
 p=pathlib.Path(pp);assert p.is_absolute()
 if p.is_file():
  b=p.read_bytes();j=json.loads(b);policy={'path':str(p),'sha256':hashlib.sha256(b).hexdigest(),'schema':j.get('schema'),'images':j.get('images',[]),'cpu':j.get('cpu')}
store=None
if public.get('AUTH_DATA_DIR'):
 p=pathlib.Path(public['AUTH_DATA_DIR'])/'secrets.json';assert p.is_absolute()
 if p.is_file():
  st=p.stat();data=json.loads(p.read_text());by=data.get('byId');assert isinstance(by,dict),'Unexpected encrypted store schema'
  store={'path':str(p),'bytes':st.st_size,'mode':oct(st.st_mode&0o777),'recordCount':len(by),'knownExistingCustodyCanaryPresent':'0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e' in by};del data,by
backs=[]
for base in pathlib.Path('/root').glob('relay-*'):
 if not base.is_dir():continue
 for p in base.glob('secrets.json*'):
  st=p.stat();backs.append({'path':str(p),'bytes':st.st_size,'modified':datetime.datetime.fromtimestamp(st.st_mtime,datetime.timezone.utc).isoformat()})
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'pid':pid,'publicEnvironment':public,'sourceHashes':[{'path':k,'sha256':v} for k,v in source.items()],'shieldPolicy':policy,'activeEncryptedStore':store,'boundedBackupMetadata':backs,'limits':['No secret values or private environment values emitted. No decryption performed.','Only direct /root/relay-*/secrets.json* backup metadata checked, not an exhaustive retention inventory.','No service or configuration changed.']}))
'''
r=subprocess.run(ssh,input=remote,text=True,capture_output=True,timeout=40)
if r.returncode:raise SystemExit('Read-only relay probe failed: '+r.stderr[-350:])
out=json.loads(r.stdout);pathlib.Path('work/custody-v2-live-20261023/evidence/relay-public-config.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
