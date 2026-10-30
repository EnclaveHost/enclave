import subprocess,json,time
from pathlib import Path
p=Path(__file__).resolve().parent
rows=[]
for host in ('59f1273d.app.enclave.host','9a28642b.app.enclave.host'):
 for label,ip in [('us-west','134.199.235.187'),('eu-central','134.209.248.172')]:
  argv=['/usr/bin/curl','--silent','--show-error','--head','--max-time','10','--connect-timeout','5','--resolve',host+':443:'+ip,'https://'+host+'/']
  try:
   r=subprocess.run(argv,capture_output=True,text=True,timeout=12);row={'host':host,'edge':label,'ip':ip,'at':time.time(),'readOnly':True,'method':'HEAD','tlsVerified':True,'rc':r.returncode,'headers':r.stdout[:8192],'stderr':r.stderr[:1024],'truncated':len(r.stdout)>8192 or len(r.stderr)>1024}
  except subprocess.TimeoutExpired:row={'host':host,'edge':label,'error':'timeout'}
  rows.append(row)
(p/'EDGE-RESULT.json').write_text(json.dumps(rows,indent=2));print(json.dumps(rows))
