# READ-ONLY (ROOT, any time after activate.py): records every "[lease-gas] renew <id> landed in <tx>" line the new control has
# logged since its start into result.json renewalsObserved (no host change). Root audits those transactions on chain
# (e.g. work/lease-relay-activation/audit-paid-leases.mjs) and passes them to keep.py --verified.
import json, re
from common import *
r = json.loads((A/'result.json').read_text()); assert r.get('journalSince'), 'no activation recorded'
lines = journal(r['journalSince'])
for i in APPS:
    for l in lines:
        m = re.match(r'^\[lease-gas\] renew ' + i + r' landed in (0x[0-9a-f]{64})', l)
        if m: r.setdefault('renewalsObserved', {})[i] = m.group(1)
r['renewalWarnings'] = [l[:200] for l in lines if l.startswith('[lease-gas] ') and ' not sent' in l][-6:]; r['renewalWatchAt'] = utc()
(A/'result.json').write_text(json.dumps(r, indent=2) + '\n'); print(json.dumps({'renewalsObserved': r['renewalsObserved'], 'warnings': len(r['renewalWarnings'])}))
