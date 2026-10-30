from pathlib import Path
import subprocess,json,time,os,base64
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
with(p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
command='powershell.exe -NoProfile -NonInteractive -EncodedCommand '+base64.b64encode((p/'observe.ps1').read_text().encode('utf-16le')).decode()
try:
 r=subprocess.run(['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','minipc',command],capture_output=True,timeout=20)
 assert len(r.stdout)<65536 and len(r.stderr)<65536
 v={'rc':r.returncode,'at':time.time(),'output':r.stdout.decode('utf-8','replace') if r.returncode==0 else '', 'stderrBytes':len(r.stderr),'capacityAdmitted':False,'pending':'UNKNOWN','nativeExecutionQualified':False}
except subprocess.TimeoutExpired:v={'status':'TIMEOUT_NO_RETRY','remoteDeathProven':False}
with(p/'RESULT.json').open('x')as f:json.dump(v,f,indent=2)
print(json.dumps(v))
