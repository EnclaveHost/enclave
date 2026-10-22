import pathlib,subprocess,sys,json
p=pathlib.Path(__file__).resolve().parent
for host in ['eu-central','ap-southeast','ca-east']:
 r=subprocess.run([sys.executable,str(p/'apply-one.py'),host],capture_output=True,text=True,timeout=790)
 if not (p/(host+'-activation.json')).exists():print(r.stdout,r.stderr,flush=True);raise SystemExit(r.returncode or 1)
 receipt=json.loads((p/(host+'-activation.json')).read_text())
 try:d=json.loads(receipt['stdout'].strip().splitlines()[-1])
 except Exception:d={'outcome':'unparseable','stdout':receipt['stdout'][-500:]}
 print(json.dumps({'host':host,'exit':r.returncode,'outcome':d.get('outcome'),'public':d.get('public'),'at':receipt['at']}),flush=True)
 if r.returncode:raise SystemExit(r.returncode)
