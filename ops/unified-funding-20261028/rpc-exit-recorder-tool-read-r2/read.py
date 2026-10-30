from pathlib import Path
import subprocess,json,hashlib
p=Path(__file__).resolve().parent
ssh=['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=5', '-oControlMaster=no', '-oControlPath=none', '-oServerAliveInterval=5', '-oServerAliveCountMax=2', '-oIdentitiesOnly=yes', '-i', '/home/steven/.ssh/minipc', '-oProxyJump=minipc', '-oHostKeyAlias=[127.0.0.1]:32423', '-oUserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts']
cmd='/usr/bin/sudo -n /usr/bin/systemd-run --quiet --wait --pipe --unit=enclave-rpc-exit-recorder-tools-r2 --property=MemoryMax=64M --property=MemorySwapMax=0 --property=CPUQuota=25% --property=TasksMax=16 --property=RuntimeMaxSec=15 --property=TimeoutStopSec=3 /usr/bin/python3 -B -'
r=subprocess.run([*ssh,'controladmin@172.17.28.159',cmd],input=(p/'remote-read.py').read_bytes(),capture_output=True,timeout=25)
assert len(r.stdout)+len(r.stderr)<=16384
(p/'RESULT.json').write_text(json.dumps({'rc':r.returncode,'stdout':r.stdout.decode(),'stderr':r.stderr.decode(),'scriptSha256':hashlib.sha256((p/'remote-read.py').read_bytes()).hexdigest()},indent=2)+'\n')
raise SystemExit(r.returncode)
