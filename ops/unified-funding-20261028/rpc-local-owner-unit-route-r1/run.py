from pathlib import Path
import os,json,subprocess,hashlib,time
from capture_local import capture
p=Path(__file__).resolve().parent;s=p.parent.parent/'source'
for n,h in json.loads((p/'PINS.json').read_text()).items():assert hashlib.sha256(Path(n).read_bytes()).hexdigest()==h,n
r=subprocess.run(['/usr/bin/node',str(s/'rpc/server/observe_resources.mjs'),str(p.parent/'rpc-export-current-admission-read-r2/CONFIG.json')],capture_output=True,text=True,timeout=3,check=True);a=json.loads(r.stdout)
assert a['authenticated'] and not a['unreadUnits'] and a['availableMiB']-a['pendingMiB']-640>=max(27648,a['floorMiB']);(p/'ADMISSION.json').write_text(json.dumps(a)+'\n')
cfg=json.loads((p/'private/CONFIG.json').read_text());attempt=cfg['qualificationAttempt'];unit='enclave-rpc-guest-workflow-'+attempt+'.service'
with (p/'INTENT.json').open('x')as f:json.dump({'qualificationOnly':True,'attempt':attempt,'unit':unit,'noProductionClock':True},f);f.flush();os.fsync(f.fileno())
props=['Type=exec','MemoryMax=256M','MemorySwapMax=0','CPUQuota=100%','TasksMax=16','LimitCORE=0','RuntimeMaxSec=240','TimeoutStopSec=1','KillMode=control-group','SendSIGKILL=yes','FinalKillSignal=SIGKILL','Restart=no','UMask=0077','NoNewPrivileges=yes']
cmd=['/usr/bin/systemd-run','--user','--quiet','--wait','--pipe','--unit='+unit,*['--property='+v for v in props],'/usr/bin/python3','-B',str(p/'probe.py'),str(time.time_ns()+900_000_000_000)]
r=capture(cmd,30,limit=16384);(p/'RUN-RESULT.json').write_text(json.dumps(r,indent=2)+'\n');assert r['rc']==0 and not r['reason'] and not r['truncated']
show=subprocess.check_output(['/usr/bin/systemctl','--user','show',unit,'-p','MainPID','-p','ExecMainStatus','-p','ActiveState'],text=True,timeout=3)
(p/'TERMINAL.txt').write_text(show);assert 'MainPID=0' in show and 'ExecMainStatus=0' in show
