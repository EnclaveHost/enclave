"""Read-only production capacity measurement. No config or key contents emitted."""
import datetime
import json
import subprocess
from pathlib import Path

script = r'''
import subprocess,json,pathlib
r={}
for unit in ['enclave-indexd','enclave-indexd-postgres']:
 p=subprocess.run(['systemctl','show',unit,'-p','ActiveState','-p','MainPID','-p','MemoryCurrent','-p','MemoryPeak','-p','MemoryMax'],text=True,capture_output=True,check=True)
 r[unit]=dict(x.split('=',1) for x in p.stdout.splitlines() if '=' in x)
 pid=r[unit].get('MainPID','0')
 if pid!='0':
  r[unit]['processMemory']=[s for s in pathlib.Path('/proc/'+pid+'/status').read_text().splitlines() if s.startswith(('VmRSS:','VmHWM:','VmSize:'))]
r['postgres']=json.loads(subprocess.run(['docker','stats','--no-stream','--format','{{json .}}','enclave-indexd-postgres'],text=True,capture_output=True,check=True).stdout)
r['database']=json.loads(subprocess.run(['docker','exec','enclave-indexd-postgres','psql','-U','postgres','-d','indexd','-Atq','-c',"SELECT json_build_object('bytes',pg_database_size(current_database()),'objects',(SELECT count(*) FROM objects),'slabs',(SELECT count(*) FROM slabs),'contracts',(SELECT count(*) FROM contracts),'accounts',(SELECT count(*) FROM accounts));"],text=True,capture_output=True,check=True).stdout)
r['stateBytes']=subprocess.run(['du','-sb','/var/lib/enclave-indexd/state','/var/lib/enclave-indexd/postgres'],text=True,capture_output=True,check=True).stdout
r['memory']=[x for x in pathlib.Path('/proc/meminfo').read_text().splitlines() if x.split(':')[0] in ('MemTotal','MemAvailable','SwapTotal','SwapFree')]
r['disk']=subprocess.run(['df','-B1','/var/lib/enclave-indexd'],text=True,capture_output=True,check=True).stdout
print(json.dumps(r))
'''
base = [
    "ssh", "-p", "32422", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
    "-o", "UserKnownHostsFile=work/storage-vm/known_hosts",
    "-i", "/home/steven/.ssh/minipc", "storageadmin@127.0.0.1", "sudo python3 -",
]
p = subprocess.run(base, input=script, text=True, capture_output=True, timeout=45)
report = {
    "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "readOnly": True, "exitCode": p.returncode,
}
if p.returncode == 0:
    report["measurement"] = json.loads(p.stdout)
else:
    report["error"] = p.stderr[-2000:]
Path("outputs/storage-indexd-review/live-footprint.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report))
