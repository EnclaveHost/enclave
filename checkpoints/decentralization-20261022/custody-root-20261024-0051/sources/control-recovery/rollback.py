# ROOT EXECUTES to roll back a PROVISIONAL or kept activation: the same safe rollback activate.py uses on failure (stop the
# new control first, wait out every sponsored deadline it logged on a verified block, CAS-restore config.json from THIS
# directory's private-backup, start the previous control on dist-leasegas-deabf8f90 / ed918e4b, still admitted).
# NOTE: a rollback does NOT restore the host's registry registration: the previous control's boot still needs a full
# register() (the 21:37Z state: not registered, nothing adopted). Root may need to maintain the app leases separately.
# The private backup is only compared and written back, never printed. guestd, guests, drop-ins and journals are not touched.
import json
from common import *
r = json.loads((A/'result.json').read_text())
old = (A/'private-backup/config.json').read_bytes(); new = CONFIG.read_bytes()
assert sha(new) == r['configAfterSha256'], 'the active config is not the one activate.py wrote'
assert sha(old) == r['configBeforeSha256']
assert r.get('productionActivated') in ('provisional', True), 'nothing to roll back: ' + r.get('state', '')
def save(): (A/'result.json').write_text(json.dumps(r, indent=2) + '\n')
r['rollbackRequestedAt'] = utc(); save()
safe_rollback(r, save, since=r['journalSince'], old_config=old, new_config=new)
r['state'] = 'rolled back to the previous control image (operator)'; save(); print(r['state'])
