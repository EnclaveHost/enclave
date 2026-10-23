# PHASE 2 (ROOT EXECUTES, privileged, after reviewing admission.json + measurement.env):
#   python3 work/custody-recipient-activation-20261023/admit.py
# On the API relay: COMPARE-AND-SWAP the measurement env (it must still be exactly what prepare-admission read), a FRESH
# backup beside it (.before-a6b1378cd; refuses if one exists), atomic replace, restart enclave-api-relay.service; on ANY
# failure the previous bytes are restored and the service restarted. TRANSIENT IMPACT: the relay restart drops every
# open api.enclave.host connection and fleet tunnel (metal0's control, custody-metal0, other boxes) for the restart
# (seconds); tunnels reconnect by themselves. The running ed918e4b stays admitted, so metal0 reattaches unchanged.
import json, sys
from common import *
ad = json.loads((A/'admission.json').read_text()); assert ad['stage'] == 'prepared only', ad['stage']
body = (A/'measurement.env').read_text(); assert sha(body.encode()) == ad['environmentSha256']
args = (RELAY['env'], RELAY['dropin'], ad['remoteBackup'], body, ad['replacesInstalledSha256'], ad['dropinSha256'], NEW['commit'][:9], 'systemctl', RELAY['service'])
code, out, err = run_remote(remote(REMOTE_CAS, args))
(A/'admission-apply.out').write_text(out + err); print(out + err, end='')
if code: sys.exit(code)
ad.update(stage='installed; public endpoint recheck pending', installedAt=utc()); (A/'admission.json').write_text(json.dumps(ad, indent=2) + '\n')
