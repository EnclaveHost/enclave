# ROOT EXECUTES to roll back a PROVISIONAL or kept post-adoption activation (prepared by Claude 2026-10-21). The same
# safe rollback activate.py uses on failure (common.safe_rollback): stop the new control first, wait out every sponsored
# deadline it logged on a block two public RPCs agree on, restore this directory's private-backup/config.json and remove
# exactly the drop-in activate.py wrote (compare-and-swap on both), start the previous control. guestd and its guests are
# never touched; no release journal is cleared or moved.
import json, hashlib
from common import *
r = json.loads((A/'result.json').read_text()); plan = json.loads((A/'plan.json').read_text())
old = (A/'private-backup/config.json').read_bytes(); new = CONFIG.read_bytes()
assert hashlib.sha256(new).hexdigest() == r['configAfterSha256'], 'the active config is not the one activate.py wrote'
assert hashlib.sha256(old).hexdigest() == r['configBeforeSha256']
assert r.get('productionActivated') in ('provisional', True), 'nothing to roll back: ' + r.get('state', '')
def save(): (A/'result.json').write_text(json.dumps(r, indent=2) + '\n')
r['rollbackRequestedAt'] = utc(); save()
safe_rollback(r, save, since=r['journalSince'], old_config=old, new_config=new,
              drop_body='[Service]\nWorkingDirectory=' + plan['release'] + '\n', rpcs=plan['leaseGas']['rpcs'])
r['state'] = 'rolled back to the previous control release (operator)'; save(); print(r['state'])
