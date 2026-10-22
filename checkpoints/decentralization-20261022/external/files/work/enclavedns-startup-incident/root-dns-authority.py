import subprocess,concurrent.futures,json,pathlib,datetime
script="""python3 - <<'REMOTE'
import subprocess,json
out={}
for unit in ['enclave-route-dns','enclave-dns-front','enclave-public-directory']:
 r=subprocess.run(['journalctl','-u',unit,'--since','20 minutes ago','-n','100','--no-pager','-o','cat'],capture_output=True,text=True,timeout=12)
 lines=[s[:700]for s in r.stdout.splitlines() if any(w in s.lower()for w in ['error','failed','refus','quorum','route map','59f1273d'])]
 out[unit]=lines[-16:]
r=subprocess.run(['ss','-ltnp'],capture_output=True,text=True,timeout=5)
out['listeners']=[s.split()[3]for s in r.stdout.splitlines()[1:]if 'node' in s]
print(json.dumps(out))
REMOTE"""
def run(host):
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10',host,script],capture_output=True,text=True,timeout=50)
 return {'host':host,'exit':r.returncode,'out':r.stdout,'err':r.stderr[:500]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2)as ex:rows=list(ex.map(run,['eu-central','ap-southeast']))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'hosts':rows};pathlib.Path(__file__).with_name('root-dns-authority.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
