"""Public policy metadata from running control-VM services; never print arbitrary environment."""
import subprocess,json,pathlib
ssh=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','sudo python3 -']
src=r'''
import subprocess,pathlib,json,hashlib,datetime
lines=subprocess.check_output(['systemctl','list-units','--type=service','--state=running','--no-legend','--plain'],text=True).splitlines()
rows=[]
for proc in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  a=(proc/'cmdline').read_bytes().split(b'\0')
  if any(v.endswith(b'/dns-relay.js') or v==b'dns-relay.js' for v in a):lines.append('process-'+proc.name+' synthetic')
 except (PermissionError,FileNotFoundError,ProcessLookupError):pass
for line in lines:
 unit=line.split()[0]
 if not any(w in unit for w in ['enclave','dns','relay','process-']):continue
 p=int(unit.split('-')[1]) if unit.startswith('process-') else int(subprocess.check_output(['systemctl','show',unit,'-p','MainPID','--value'],text=True).strip())
 if p<2:continue
 env={}
 for v in pathlib.Path(f'/proc/{p}/environ').read_bytes().split(b'\0'):
  if b'=' in v:
   k,val=v.split(b'=',1)
   if k in [b'ATTESTED_SHIELD_POLICY',b'APP_CHALLENGE_SHIELD_POLICY',b'ENCLAVE_NETWORK_SHIELD_POLICY']:env[k.decode()]=val.decode()
 row={'unit':unit,'pid':p,'policyPaths':env,'policies':[]}
 for path in env.values():
  f=pathlib.Path(path);assert f.is_absolute()
  if f.is_file():
   b=f.read_bytes();j=json.loads(b);row['policies'].append({'path':path,'sha256':hashlib.sha256(b).hexdigest(),'schema':j.get('schema'),'images':j.get('images',[]),'cpu':j.get('cpu')})
 rows.append(row)
print(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'services':rows}))
'''
r=subprocess.run(ssh,input=src,capture_output=True,text=True,timeout=40)
if r.returncode:raise SystemExit(r.stderr[-350:])
o=json.loads(r.stdout);pathlib.Path('work/custody-v2-live-20261023/evidence/dns-policy-inventory-complete.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
