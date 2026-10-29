# PREPARED ONLY. Coordinator reviews before ONE read-only SSH call; no retry.
from pathlib import Path
import base64,hashlib,json,os,selectors,subprocess,time
p=Path(__file__).resolve().parent
for name,h in json.loads((p/'input-pins.json').read_text()).items():
 if hashlib.sha256((p/name).read_bytes()).hexdigest()!=h:raise SystemExit('proposal drift')
with (p/'attempt.json').open('x') as f:json.dump({'pid':os.getpid(),'at':time.time(),'scope':'one bounded read-only resource and manager/router pending observation'},f)
wrapper=base64.b64encode('[scriptblock]::Create([Console]::In.ReadToEnd()).Invoke()'.encode('utf-16le')).decode()
args=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=6','-o','ConnectionAttempts=1','minipc','C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe','-NoProfile','-NonInteractive','-EncodedCommand',wrapper]
child=subprocess.Popen(args,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
script=(p/'probe.template.ps1').read_text().replace('__VALIDATOR_BASE64__',base64.b64encode((p/'validate.cjs').read_bytes()).decode())
child.stdin.write(script.encode());child.stdin.close()
sel=selectors.DefaultSelector()
for s in [child.stdout,child.stderr]:sel.register(s,selectors.EVENT_READ)
parts=[];total=0;deadline=time.monotonic()+45;reason=None
while sel.get_map():
 if time.monotonic()>=deadline:reason='SSH observation timeout; remote completion unknown';break
 for key,_ in sel.select(timeout=min(0.25,max(0,deadline-time.monotonic()))):
  b=os.read(key.fileobj.fileno(),4096)
  if not b:sel.unregister(key.fileobj);continue
  total+=len(b)
  if total>32768:reason='combined transport output bound exceeded';break
  if key.fileobj is child.stdout:parts.append(b)
 if reason:break
if reason:
 child.kill()
 try:child.wait(timeout=3)
 except subprocess.TimeoutExpired:pass
 out={'readOnly':True,'known':False,'reason':reason,'rawOutputWithheld':True,'noRetry':True,'remoteExitConfirmed':False}
else:
 try:
  rc=child.wait(timeout=3);out=json.loads(b''.join(parts).decode('utf-8-sig'))
  out['sshExit']=rc
 except (ValueError,subprocess.TimeoutExpired):out={'readOnly':True,'known':False,'reason':'invalid/incomplete sanitized response','rawOutputWithheld':True,'noRetry':True}
sel.close()
(p/'result.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
