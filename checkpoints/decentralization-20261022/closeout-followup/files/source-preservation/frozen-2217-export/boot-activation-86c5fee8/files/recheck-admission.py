# PHASE 2b (ROOT EXECUTES, read-only): the PUBLIC allowlist now lists all 36 + the approved candidate (37), and metal0 is still
# attached at ed918e4b.
import json
from common import *
ad = json.loads((A/'admission.json').read_text()); assert ad['stage'] == 'installed; public endpoint recheck pending'
al = public_attestation(get)['operatorAllowlist']
assert al['admittedAtAttach'] == CURRENT['measurement'], 'metal0 is not attached at ed918e4b after the relay restart: inspect'
assert sorted(al['measurements']) == sorted(ad['existing'] + [ad['added']]), 'public allowlist is not existing + candidate'
ad.update(stage='verified active; old control still connected', verifiedAt=utc()); (A/'admission.json').write_text(json.dumps(ad, indent=2) + '\n')
print(json.dumps({'stage': ad['stage'], 'allowed': len(al['measurements'])}))
