# ROOT EXECUTES to roll back a KEPT corrected activation later (prepared by Claude 5a07654a; derived from
# linux-lease-root-release/activation/rollback.py). Restores this directory's fresh private-backup/config.json with
# compare-and-swap on both versions, removes exactly the drop-in activate.py wrote, restarts the control. The c083
# activation's backup and result are never read or written.
from pathlib import Path
import json,hashlib,subprocess,os,datetime
A=Path(__file__).resolve().parent;r=json.loads((A/'result.json').read_text());plan=json.loads((A/'plan.json').read_text())
config=Path('/home/steven/Projects/enclave/metal/config.json');drop=Path('/home/steven/.config/systemd/user/enclave-metal.service.d/95-app-funded-leases.conf');old=(A/'private-backup/config.json').read_bytes()
assert hashlib.sha256(config.read_bytes()).hexdigest()==r['configAfterSha256']
assert hashlib.sha256(old).hexdigest()==r['configBeforeSha256']
assert drop.read_text()=='[Service]\nWorkingDirectory='+plan['release']+'\n'
mode=config.stat().st_mode&0o777;tmp=config.with_name(config.name+'.leasegas-tmp');assert not tmp.exists();tmp.write_bytes(old);tmp.chmod(mode);os.replace(tmp,config);drop.unlink()
subprocess.run(['systemctl','--user','daemon-reload'],check=True)
subprocess.run(['systemctl','--user','restart','enclave-metal.service'],check=True,timeout=40)
r.update(state='rolled back to the previous control release (operator)',rolledBackAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),productionActivated=False)
(A/'result.json').write_text(json.dumps(r,indent=2)+'\n');print(r['state'])
