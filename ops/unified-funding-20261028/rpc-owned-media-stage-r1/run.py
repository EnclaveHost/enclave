from pathlib import Path
import subprocess,json,time,os,base64,selectors,sys,hashlib
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
phase=sys.argv[1];assert phase in ('create','stage','execute')
for name,digest in json.loads((p/'PINS.json').read_text()).items():
 assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest,name
spec=json.loads((p/'SPEC.json').read_text())
with (p/(phase+'-INTENT.json')).open('x') as f:json.dump({'at':time.time(),'phase':phase,'noRetry':True},f)
options=['-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none']
def capture(args,seconds,label):
 proc=subprocess.Popen(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ,'stdout');sel.register(proc.stderr,selectors.EVENT_READ,'stderr')
 buf={'stdout':bytearray(),'stderr':bytearray()};deadline=time.monotonic()+seconds;failure=None
 while sel.get_map():
  if time.monotonic()>deadline:failure='local-timeout-remote-state-unknown';break
  for key,_ in sel.select(.1):
   data=os.read(key.fileobj.fileno(),8192)
   if not data:sel.unregister(key.fileobj);continue
   buf[key.data].extend(data)
   if len(buf[key.data])>(262144 if key.data=='stdout' else 16384):failure='output-bound-remote-state-unknown';break
  if failure:break
 if failure:proc.kill()
 try:rc=proc.wait(timeout=5)
 except subprocess.TimeoutExpired:proc.kill();rc=proc.wait(timeout=2);failure='transport-exit-timeout-remote-state-unknown'
 v={'at':time.time(),'rc':rc,'failure':failure,'stderrBytes':len(buf['stderr']),'remoteDeathProven':False,'automaticRetry':False}
 if not failure and rc==0 and label!='upload':
  try:v['result']=json.loads(bytes(buf['stdout']).decode('utf-8-sig'))
  except Exception:v['failure']='invalid-json-remote-state-unknown'
 # Bounded raw bytes retained locally for diagnosis; never publish raw stderr.
 (p/(phase+'-'+label+'.stdout')).write_bytes(bytes(buf['stdout']))
 (p/(phase+'-'+label+'.stderr')).write_bytes(bytes(buf['stderr']))
 (p/(phase+'-'+label+'-RESULT.json')).write_text(json.dumps(v,indent=2)+'\n')
 if rc or v['failure']:raise RuntimeError(label+' failed; no retry')
 return v
if phase=='create':
 body=(p/'create.ps1').read_text()
 command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(body.encode('utf-16le')).decode()
 v=capture(['/usr/bin/ssh','-T',*options,'minipc',command],40,'remote')
 assert v['result']['created'] is True and v['result']['nativeAttempted'] is False
elif phase=='stage':
 assert json.loads((p/'create-remote-RESULT.json').read_text())['result']['created'] is True
 target='minipc:'+spec['root'].replace('\\','/')+'/'
 capture(['/usr/bin/scp','-3','-B','-F',str(p/'ssh-config'),*options,'-X','nrequests=1','-X','buffer=32768','rpc-media-control:'+spec['source']+'/boot.vhdx','rpc-media-control:'+spec['source']+'/seed.iso',target],150,'upload')
else:
 assert json.loads((p/'stage-upload-RESULT.json').read_text())['rc']==0
 body=(p/'verify.ps1').read_text()
 command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(body.encode('utf-16le')).decode()
 v=capture(['/usr/bin/ssh','-T',*options,'minipc',command],45,'remote')
 assert v['result']['verified'] is True and v['result']['nativeVmAttempted'] is False
(p/(phase+'-RESULT.json')).write_text(json.dumps({'success':True,'phase':phase,'at':time.time(),'vmChanged':False})+'\n')
print(json.dumps({'phase':phase,'success':True}))
