import subprocess,json,time,datetime
from pathlib import Path
rows=[]
for i in range(12):
 for server in ['134.199.235.187','134.209.248.172','165.245.191.129','146.190.246.39','1.1.1.1','8.8.8.8']:
  for label in ['7ae476a3','d9798e4c']:
   r=subprocess.run(['dig','+time=2','+tries=1','+noall','+comments','+answer','@'+server,label+'.app.enclave.host','A'],capture_output=True,text=True)
   status=r.stdout.split('status: ')[1].split(',')[0] if 'status: ' in r.stdout else 'TIMEOUT'
   addresses=[line.split()[-1] for line in r.stdout.splitlines() if '\tA\t' in line]
   rows.append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'server':server,'label':label,'status':status,'addresses':addresses})
 print('DNS round',i+1,'failures',sum(not r['addresses'] for r in rows),flush=True)
 Path('outputs/nan-outage-dns-verification.json').write_text(json.dumps({'checks':rows,'allAnswered':all(r['addresses'] for r in rows)},indent=2)+'\n')
 if i<11:time.sleep(10)
