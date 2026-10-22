import subprocess,json,datetime,pathlib,time
base=pathlib.Path(__file__).parent
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'queries':[]}
for i in range(2):
 r=subprocess.run(['curl','-sS','--max-time','20','https://59f1273d.app.enclave.host/resolve?name=38f368d6.app.enclave.host&type=A'],capture_output=True,text=True,timeout=25)
 try:v=json.loads(r.stdout)
 except:v=r.stdout[:300]
 out['queries'].append({'rc':r.returncode,'response':v,'error':r.stderr[:300]})
 if i==0:time.sleep(3)
(base/'probe.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
