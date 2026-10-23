# ROOT EXECUTES only to undo admit.py: restores the env file it replaced (CAS on both versions) and restarts the API relay
# (same transient impact as admit.py). Never run while the new measurement is attached.
import json, sys
from common import *
NEW = load_new()
ad = json.loads((A/'admission.json').read_text())
assert public_attestation(get)['operatorAllowlist']['admittedAtAttach'] != NEW['measurement'], 'the candidate is attached: roll back the control first'
args = (RELAY['env'], ad['remoteBackup'], ad['environmentSha256'], ad['replacesInstalledSha256'], NEW['commit'][:9], 'systemctl', RELAY['service'])
code, out, err = run_remote(remote(REMOTE_RESTORE, args)); print(out + err, end='')
if code: sys.exit(code)
ad.update(stage='unadmitted (restored)', unadmittedAt=utc()); (A/'admission.json').write_text(json.dumps(ad, indent=2) + '\n')
