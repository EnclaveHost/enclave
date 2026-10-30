from pathlib import Path
import os,json,time,hashlib,subprocess
p=Path(__file__).resolve().parent
policy=json.loads((p/'POLICY.json').read_text());r=Path(policy['runtime'])
os.umask(0o077)
def save(v):
 with (p/'RESULT.json').open('x') as f:json.dump(v,f,indent=2);f.write('\n')
assert hashlib.sha256((r/'PINS.json').read_bytes()).hexdigest()==policy['runtimePinsSha256']
for name,h in json.loads((r/'PINS.json').read_text()).items():assert hashlib.sha256((r/name).read_bytes()).hexdigest()==h
while time.time()<policy['deadline']:
 if (r/'RESULT.json').exists():save({'status':'trial-already-terminal','at':time.time(),'noStopSent':True});raise SystemExit(0)
 time.sleep(min(1,policy['deadline']-time.time()))
m=subprocess.check_output(['/usr/bin/systemctl','--user','show',policy['unit'],'-p','ActiveState','-p','MainPID','-p','InvocationID'],text=True,timeout=5)
v=dict(line.split('=',1) for line in m.splitlines() if '=' in line)
if v.get('MainPID')=='0':save({'status':'trial-already-terminal','at':time.time(),'manager':v,'noStopSent':True});raise SystemExit(0)
assert v.get('InvocationID')==policy['invocation'] and int(v['MainPID'])==policy['mainPid']
t=Path('/proc',str(policy['mainPid']),'stat').read_text().rsplit(')',1)[1].split();assert int(t[19])==policy['mainStartTicks']
g={};exec(compile((r/'capture-local.py').read_text(),'qualified-capture','exec'),g)
ssh=['/usr/bin/ssh','-oBatchMode=yes','-oStrictHostKeyChecking=yes','-oConnectTimeout=5','-oControlMaster=no','-oControlPath=none','-oServerAliveInterval=5','-oServerAliveCountMax=2']
command='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-nan-human-limit-n10 --slice=enclavenanguardn10.slice --property=User=root --property=MemoryMax=128M --property=MemorySwapMax=0 --property=CPUQuota=100% --property=TasksMax=64 --property=RuntimeMaxSec=10 --property=TimeoutStopSec=5 --property=KillMode=control-group --property=UMask=0077 /usr/bin/python3 -B /run/enclave-rpc-nan-client-n10/program.py request-stop'
started=time.time();result=g['capture']([*ssh,'nan',command],20,limit=65536)
save({'status':'stop-request-at-human-deadline','at':started,'deadline':policy['deadline'],'capture':result,'cleanupComplete':False})
assert result['rc']==0 and not result['reason'] and not result['truncated'],'stop-request-failed-observe-do-not-replay'
rows=[json.loads(l[len('RESULT_JSON='):]) for l in result['stdout'].splitlines() if l.startswith('RESULT_JSON=')]
assert len(rows)==1 and rows[0].get('stopRequested') and rows[0]['ok'],'stop-request-not-confirmed'
