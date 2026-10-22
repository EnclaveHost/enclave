import pathlib,json,hashlib,subprocess,sys,datetime
p=pathlib.Path(__file__).resolve().parent;a=json.loads((p/'root-approval.json').read_text());host=sys.argv[1]
assert host in ['us-west','eu-central','ap-southeast','ca-east']
for f,h in a['pins'].items():assert hashlib.sha256((p/'kit'/f).read_bytes()).hexdigest()==h,f
r=subprocess.run([sys.executable,str(p/'kit/activation/activate-runtime.py'),'apply','--hosts',host,'--approve',a['manifestSha256'],'--execute'],capture_output=True,text=True,timeout=780)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'host':host,'exit':r.returncode,'stdout':r.stdout,'stderr':r.stderr}
(p/(host+'-activation.json')).write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2));raise SystemExit(r.returncode)
