from pathlib import Path
import subprocess,json,sys,datetime,time
base=Path(__file__).resolve().parent;root=base.parents[1]
host=sys.argv[1];assert host in ['us-west','eu-central']
pin='6e1b0bfb10a0d502921215e0624885406a0f2805e45bc2d4934a8d9e63e609f2'
required=list(range(1,24))+[24 if host=='us-west' else 25]
for n in required:
 j=json.loads((root/f'work/lease-enrollment-signing/journals/op-{n:02d}.json').read_text());assert j['status']=='confirmed' and j['planSha256']==pin
record=json.loads((base/'deployment.json').read_text());identities=json.loads((root/'outputs/app-lease-gas-review/lease-relay-identities.json').read_text())['identities'];identity=next(x for x in identities if x['host']==host)
log=base/'final-94f4ebdf'/(host+'-start.jsonl')
def note(x):
 with log.open('a') as f:f.write(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**x})+'\n');f.flush()
ssh=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',host]
note({'action':'systemctl start requested','unit':'enclave-lease-relay','requiredFundingOperationsConfirmed':required})
try:
 r=subprocess.run(ssh+['systemctl start enclave-lease-relay'],capture_output=True,text=True,timeout=120)
 note({'action':'start returned','returncode':r.returncode,'stdout':r.stdout,'stderr':r.stderr})
 if r.returncode:raise RuntimeError('service start failed; inspect unit status, do not repeat blindly')
 for attempt in range(15):
  r=subprocess.run(ssh+['curl --silent --show-error --fail --max-time 10 http://127.0.0.1:8549/v1/info'],capture_output=True,text=True,timeout=15)
  if r.returncode==0:break
  time.sleep(2)
 assert r.returncode==0,r.stderr
 info=json.loads(r.stdout)
 assert info['chainId']==8453
 for k,want in [('reserve',record['reserve']),('executor',record['executor']),('payee',identity['address'])]:assert info[k].lower()==want.lower(),k
 note({'action':'local identity verified','info':info});print(json.dumps({'host':host,'status':'started; local info bindings verified; not yet exposed or enabled','info':info}))
except Exception as e:
 note({'action':'not verified','error':str(e)});raise
