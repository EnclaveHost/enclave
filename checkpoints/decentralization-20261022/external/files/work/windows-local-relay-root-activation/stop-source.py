import subprocess,json,urllib.request,datetime
from pathlib import Path
url='https://134.209.248.172/v1/info'
with urllib.request.urlopen(url,timeout=15) as r:j=json.load(r)
assert j['payee'].lower()=='0xc5d88d2d1c898fcacdce965cbe2f1c3cd38bb26a',j
assert int(j['chainId'])==8453 and j['reserve'].lower()=='0x12a3f873041dec436daa0085b766a399a6fa3639',j
print('Fallback relay public identity verified',flush=True)
with Path('work/windows-local-relay-root-activation/source-stop.out').open('xb') as f:
 p=subprocess.Popen(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15','us-west','bash /root/enclave-local-relay-migration-tools-20261021/do-source-stop.sh --stop'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 for line in p.stdout:
  f.write(line);f.flush();print(line.decode(errors='replace'),end='',flush=True)
 rc=p.wait()
Path('outputs/decentralization-audit/windows-relay-source-stop.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit':rc,'sourceStopAttempted':True,'fallbackPublicInfo':j},indent=2)+'\n')
raise SystemExit(rc)
