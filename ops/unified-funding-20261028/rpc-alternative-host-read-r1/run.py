from pathlib import Path
import subprocess,json,time,os
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
with (p/'ATTEMPT.json').open('x') as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
cmd="LC_ALL=C; uname -s; awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{print}' /proc/meminfo; getconf _NPROCESSORS_ONLN; df -B1 -P /"
rows=[]
for host in ['storage','nan','us-west','ca-east','ap-southeast','eu-central']:
 try:
  r=subprocess.run(['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none',host,cmd],capture_output=True,timeout=15)
  assert len(r.stdout)<65536 and len(r.stderr)<65536
  rows.append({'host':host,'at':time.time(),'rc':r.returncode,'output':r.stdout.decode('utf-8','replace') if r.returncode==0 else '', 'stderrBytes':len(r.stderr)})
 except subprocess.TimeoutExpired: rows.append({'host':host,'at':time.time(),'status':'TIMEOUT_NO_RETRY'})
 except Exception as e: rows.append({'host':host,'at':time.time(),'status':type(e).__name__})
with (p/'RESULT.json').open('x') as f:json.dump({'observations':rows,'capacityAdmission':False,'pendingCommitments':'UNKNOWN','productionChanged':False},f,indent=2)
print(json.dumps(rows))
