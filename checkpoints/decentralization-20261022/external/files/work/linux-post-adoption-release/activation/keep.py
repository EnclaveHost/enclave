# ROOT EXECUTES after its OWN chain audit of the two renewal transactions activate.py recorded (each must be a renewal
# of that app paid by the app's reserve, never by this host's key - e.g. work/lease-relay-activation/audit-paid-leases.mjs):
#   python3 keep.py --audit <root's audit output file> --verified <app id>=<tx hash> --verified <app id>=<tx hash>
# Records the keep decision; changes nothing on the host. Until it runs, the activation is PROVISIONAL.
import argparse, hashlib, json
from common import *
ap = argparse.ArgumentParser(); ap.add_argument('--audit', required=True); ap.add_argument('--verified', action='append', required=True)
a = ap.parse_args()
r = json.loads((A/'result.json').read_text())
assert r.get('productionActivated') == 'provisional', 'not provisional: ' + r.get('state', '')
v = dict(x.lower().split('=', 1) for x in a.verified)
assert v == {k.lower(): h.lower() for k, h in r['renewals'].items()}, 'the audited transactions are not the recorded renewals'
audit = Path(a.audit).read_bytes()
for h in v.values(): assert h.encode() in audit.lower(), f'{h} is not in the audit output'
r.update(state='KEPT: operational gate passed, both app-paid renewals audited on chain by root', productionActivated=True, keptAt=utc(),
         audit={'file': str(Path(a.audit).resolve()), 'sha256': hashlib.sha256(audit).hexdigest()})
(A/'result.json').write_text(json.dumps(r, indent=2) + '\n'); print(r['state'])
