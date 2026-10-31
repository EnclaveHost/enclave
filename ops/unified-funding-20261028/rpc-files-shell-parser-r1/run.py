from pathlib import Path
import subprocess,json,time,os,base64,selectors,sys,gzip
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
name=sys.argv[1];assert name in ('manager','storage')
with(p/(name+'-ATTEMPT.json')).open('x')as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
body=(p/(name+'-read.ps1')).read_text();assert len(body.encode())<50000
compressed=base64.b64encode(gzip.compress(body.encode('utf-8'),mtime=0)).decode()
wrapper="$b=[Convert]::FromBase64String('"+compressed+"');$m=New-Object IO.MemoryStream(,$b);$g=New-Object IO.Compression.GZipStream($m,[IO.Compression.CompressionMode]::Decompress);$r=New-Object IO.StreamReader($g,[Text.Encoding]::UTF8);$s=$r.ReadToEnd();$r.Dispose();if($s.Length-gt 50000){throw 'source bound'};&([scriptblock]::Create($s))"
command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode(wrapper.encode('utf-16le')).decode();assert len(command)<30000

proc=subprocess.Popen(['/usr/bin/ssh','-T','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','minipc',command],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
sel=selectors.DefaultSelector();sel.register(proc.stdout,selectors.EVENT_READ,'stdout');sel.register(proc.stderr,selectors.EVENT_READ,'stderr');buf={'stdout':bytearray(),'stderr':bytearray()};deadline=time.monotonic()+40;failure=None
while sel.get_map():
 if time.monotonic()>deadline:failure='local-timeout-remote-death-unknown';break
 for key,_ in sel.select(.2):
  data=os.read(key.fileobj.fileno(),8192)
  if not data:sel.unregister(key.fileobj);continue
  buf[key.data].extend(data)
  if len(buf[key.data])>(262144 if key.data=='stdout' else 16384):failure='output-bound';break
 if failure:break
if failure:proc.kill()
rc=proc.wait(timeout=5)
v={'at':time.time(),'readOnly':True,'rc':rc,'failure':failure,'stderrBytes':len(buf['stderr']),'capacityAdmitted':False,'remoteDeathProven':False}
if not failure and rc==0:
 try:
  v['observation']=json.loads(bytes(buf['stdout']).decode('utf-8-sig'))
  if v['observation'].get('success') is not True:v['failure']='remote-read-failed'
 except Exception:v['failure']='invalid-json'
(p/(name+'-stderr.local')).write_bytes(bytes(buf['stderr']))
(p/(name+'-RESULT.json')).write_text(json.dumps(v,indent=2)+'\n');print(json.dumps({'rc':rc,'failure':v['failure']}));sys.exit(0 if not v['failure'] and rc==0 else 1)
