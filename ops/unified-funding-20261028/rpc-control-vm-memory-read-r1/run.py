from pathlib import Path
import subprocess,json,time,os
p=Path(__file__).resolve().parent
assert os.sched_getaffinity(0)=={1}
with(p/'ATTEMPT.json').open('x')as f:json.dump({'at':time.time(),'readOnly':True,'noRetry':True},f)
args=['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','-oIdentitiesOnly=yes','-i','/home/steven/.ssh/minipc','-oProxyJump=minipc','-oHostKeyAlias=[127.0.0.1]:32423','-oUserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','controladmin@172.17.28.159',"LC_ALL=C; uname -s; awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/{print}' /proc/meminfo; getconf _NPROCESSORS_ONLN; df -B1 -P /; cat /sys/fs/cgroup/memory.max"]
try:
 r=subprocess.run(args,capture_output=True,timeout=20)
 assert len(r.stdout)<65536 and len(r.stderr)<65536
 v={'at':time.time(),'rc':r.returncode,'output':r.stdout.decode('utf-8','replace') if r.returncode==0 else '', 'stderrBytes':len(r.stderr),'capacityAdmitted':False,'newAllocation':False,'productionChanged':False}
except subprocess.TimeoutExpired:v={'status':'TIMEOUT_NO_RETRY','remoteDeathProven':False}
with(p/'RESULT.json').open('x')as f:json.dump(v,f,indent=2)
print(json.dumps(v))
