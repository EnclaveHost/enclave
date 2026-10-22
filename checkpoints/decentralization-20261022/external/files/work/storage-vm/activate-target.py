import subprocess,json,datetime
from pathlib import Path
base=['ssh','-p','32422','-o','BatchMode=yes','-o','UserKnownHostsFile=work/storage-vm/known_hosts','-i','/home/steven/.ssh/minipc','storageadmin@127.0.0.1']
restore=json.loads(Path('outputs/storage-final-restore-verification.json').read_text());assert restore['allFileHashesVerified'] and not restore['targetWriterStarted']
check="set -eu; test ! -e /etc/indexd/ALLOW_NAN_WRITER; test \"$(systemctl show indexd -p MainPID --value)\" = 0; test \"$(systemctl is-enabled indexd || true)\" = disabled; grep -Fxq ConditionPathExists=/etc/indexd/ALLOW_NAN_WRITER /etc/systemd/system/indexd.service.d/90-migration-write-fence.conf; ! pgrep -u indexd -x indexd >/dev/null"
r=subprocess.run(['ssh','-o','BatchMode=yes','nan',check],capture_output=True);assert r.returncode==0,'Source fence verification failed; target remains stopped'
receipt={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'source':'nan','sourceWriterStopped':True,'sourceDisabled':True,'persistentFence':True,'finalRestore':restore}
Path('outputs/storage-writer-handoff.json').write_text(json.dumps(receipt,indent=2)+'\n')
remote="sudo sh -c 'set -eu; umask 077; test ! -e /etc/enclave-indexd/ALLOW_LIVE_START; cat > /etc/enclave-indexd/source-fence-receipt.json; touch /etc/enclave-indexd/ALLOW_LIVE_START; systemctl start enclave-indexd'"
r=subprocess.run(base+[remote],input=json.dumps(receipt).encode(),capture_output=True);assert r.returncode==0,'Target activation failed; do not restart Nan without reconciliation'
r=subprocess.run(base+['sudo python3 migration/live-admin-check.py'],capture_output=True,text=True)
if r.returncode:
 Path('work/private/indexd-recovery/target-startup-diagnostic.log').write_text(r.stdout+r.stderr)
 raise RuntimeError('Target admin API not ready; private diagnostics retained; source stays fenced')
health=json.loads(r.stdout);receipt['targetAdminHealth']=health;receipt['targetWriterStarted']=True
Path('outputs/storage-writer-handoff.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps({'sourceStoppedAndFenced':True,'targetStarted':True,'health':health}))
