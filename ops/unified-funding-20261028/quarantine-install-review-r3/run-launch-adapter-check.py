import sys,subprocess,json,hashlib,os
from pathlib import Path
import quarantine_install_r2 as q
p=Path(__file__).resolve().parent
# Read only public systemd properties; no Environment= or EnvironmentFile contents.
ssh=['ssh','-J','minipc','-o','HostKeyAlias=[127.0.0.1]:32423','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-o','ConnectTimeout=10','-i','/home/steven/.ssh/minipc','controladmin@172.17.28.159']
props=['MainPID','ActiveState','SubState','ControlGroup','InvocationID','DropInPaths','Result','ExecStart','EnvironmentFiles']
cmd='systemctl show enclave-api-relay.service '+ ' '.join('-p '+x for x in props)
r=subprocess.run(ssh+[cmd],capture_output=True,text=True,timeout=25,check=True)
(p/'actual-original-systemctl-public.txt').write_text(r.stdout)
d=q.parse_show(r.stdout)
assert d['MainPID']==228946 and d['ActiveState']=='active'
assert d['ExecStart']==[{'path':'/usr/bin/node','argv':list(q.PRODUCTION_PINS.exec_argv),'ignoreErrors':False}]
assert d['EnvironmentFiles']==[list(x) for x in q.PRODUCTION_PINS.environment_files]
assert len(d['DropInPaths'])==10
# Local, exclusively owned transient unit; never the production service.
# An EnvironmentFile deliberately disagrees; the exact env wrapper must win BEFORE Python starts.
f=p/'owned-launch-fixture.env'
with f.open('x') as h:h.write('SESSIONS_WRITE_QUARANTINE=0\nSESSIONS_FUNDING_INTAKE=1\nOWNED_FIXTURE_VALUE=preserved\n')
os.chmod(f,0o600)
check=p/'owned-launch-fixture.py'
with check.open('x') as h:h.write("import os,json\nassert os.environ['SESSIONS_WRITE_QUARANTINE']=='1'\nassert os.environ['SESSIONS_FUNDING_INTAKE']=='0'\nassert os.environ['OWNED_FIXTURE_VALUE']=='preserved'\nprint(json.dumps({'preExecutionFlagsForced':True,'otherEnvironmentPreserved':True}))\n")
unit='enclave-funding-owned-launch-wrapper-r1-20261029'
r=subprocess.run(['systemd-run','--user','--quiet','--wait','--pipe','--collect','--unit='+unit,'-p','MemoryMax=64M','-p','MemorySwapMax=0','-p','TasksMax=16','-p','CPUQuota=50%','-p','RuntimeMaxSec=10','-p','NoNewPrivileges=yes','-p','EnvironmentFile='+str(f),'/usr/bin/env','SESSIONS_WRITE_QUARANTINE=1','SESSIONS_FUNDING_INTAKE=0','/usr/bin/python3',str(check)],capture_output=True,text=True,timeout=20)
(p/'owned-launch-result.txt').write_text(r.stdout+r.stderr)
assert r.returncode==0,r.returncode
out=json.loads(r.stdout.strip());assert out['preExecutionFlagsForced'] and out['otherEnvironmentPreserved']
s=subprocess.run(['systemctl','--user','show',unit+'.service','-p','ActiveState','-p','LoadState'],capture_output=True,text=True,timeout=5)
assert 'ActiveState=active' not in s.stdout and 'ActiveState=activating' not in s.stdout
summary={'actualOriginalPropertyParsing':True,'originalPid':d['MainPID'],'environmentFileCount':9,'dropInCount':10,'ownedLocalSystemdPreExecutionWrapper':out,'ownedUnitGoneOrInactive':True,'noProductionMutation':True,'productionCandidateStarted':False}
(p/'launch-adapter-result.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary))
