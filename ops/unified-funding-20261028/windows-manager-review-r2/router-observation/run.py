# SOURCE ONLY proposal. One bounded read-only call after coordinator reviews pins. No retry.
from pathlib import Path
import hashlib,json,base64,subprocess,os,time
p=Path(__file__).resolve().parent
for n,h in json.loads((p/'input-pins.json').read_text()).items():
 if hashlib.sha256((p/n).read_bytes()).hexdigest()!=h:raise SystemExit('proposal input drift: '+n)
with (p/'attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'at':time.time(),'scope':'one readonly currentrouter publicpins/pendingjournal observation'},f)
s=(p/'probe.template.ps1').read_text().replace('__VALIDATOR_BASE64__',base64.b64encode((p/'validate.cjs').read_bytes()).decode())
w=base64.b64encode('[scriptblock]::Create([Console]::In.ReadToEnd()).Invoke()'.encode('utf-16le')).decode()
r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','ConnectionAttempts=1','minipc','powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',w],input=s.encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=40)
(p/'result.rc').write_text(str(r.returncode)+'\n')
if r.returncode:print(json.dumps({'rc':r.returncode,'stdoutBytes':len(r.stdout),'stderrBytes':len(r.stderr),'rawOutputWithheld':True,'admissible':False}));raise SystemExit(r.returncode)
j=json.loads(r.stdout.decode('utf-8-sig'));(p/'result.json').write_text(json.dumps(j,indent=2)+'\n');print(json.dumps(j,indent=2))
