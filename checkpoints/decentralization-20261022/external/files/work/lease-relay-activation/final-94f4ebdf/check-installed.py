import subprocess,json
from pathlib import Path
rows=[]
command="set -eu; set -a; . /etc/enclave-lease-relay/relay.env; set +a; state_dir=$(mktemp -d /var/tmp/enclave-lease-check.XXXXXXXX); trap 'rmdir \"$state_dir\"' EXIT; export LEASE_RELAY_KEY_FILE=/var/lib/enclave-lease-relay/relay.key LEASE_RELAY_STATE=\"$state_dir/relay-send.json\"; cd /opt/enclave-lease-relay/current; /usr/local/bin/node /opt/enclave-lease-relay/current/lease-relay-check.mjs"
for host in ['us-west','eu-central']:
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',host,command],capture_output=True,text=True,timeout=45)
 rows.append({'host':host,'exitCode':r.returncode,'result':r.stdout.strip(),'error':r.stderr[-1200:]})
 if r.returncode:break
result={'hosts':rows,'servicesStarted':False,'keyContentsRead':False}
Path('outputs/app-lease-gas-review/installed-relay-config-check.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
assert len(rows)==2 and all(r['exitCode']==0 for r in rows)
