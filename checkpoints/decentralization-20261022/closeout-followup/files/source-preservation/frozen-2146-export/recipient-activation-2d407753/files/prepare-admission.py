# PHASE 1 (ROOT EXECUTES, read-only): python3 work/custody-recipient-activation-20261023/prepare-admission.py
# Reads (a) the PUBLIC attestation allowlist, (b) over root's SSH, READ-ONLY, the relay's installed measurement env file
# (its sha256 and body - a public measurement list, no secret) and its drop-in sha256 and the API service state.
# Asserts: the installed file is the deabf8f90 admission (f33a6c91...) holding exactly the 35 public measurements, the
# running ed918e4b among them, the candidate not yet; the drop-in is the installed one. Writes admission.json +
# measurement.env (ADDITIVE: all 35 in their installed order, then ee5df6b8). Changes nothing anywhere.
import json, sys
from common import *
assert not (A/'admission.json').exists(), 'already prepared: inspect'
att = public_attestation(get); al = att['operatorAllowlist']
assert al['admittedAtAttach'] == CURRENT['measurement'], f"production attached at {al['admittedAtAttach'][:16]}, not ed918e4b"
code, out, err = run_remote(remote(REMOTE_READ, (RELAY['env'], RELAY['dropin'], 'systemctl', RELAY['service'])))
if code: sys.exit(f'remote read failed ({code}): {err.strip()[:300]}')
r = json.loads(out.strip().splitlines()[-1])
assert r['serviceActive'] == 'active', r['serviceActive']
assert r['envSha256'] == RELAY['installedSha256'], f"installed env {r['envSha256'][:16]} is not the deabf8f90 admission: inspect first"
assert r['dropinSha256'] == RELAY['dropinSha256'], 'the admission drop-in changed: inspect first'
existing, body = admission_body(r['envBody'], al['measurements'])
(A/'measurement.env').write_text(body)
rec = {'at': utc(), 'stage': 'prepared only', 'existing': existing, 'added': NEW['measurement'], 'admittedAtAttach': al['admittedAtAttach'],
       'replacesInstalledSha256': r['envSha256'], 'environmentSha256': sha(body.encode()), 'dropinSha256': r['dropinSha256'],
       'remoteBackup': RELAY['env'] + '.before-' + NEW['commit'][:9]}
(A/'admission.json').write_text(json.dumps(rec, indent=2) + '\n')
print(json.dumps({'existing': len(existing), 'added': NEW['measurement'][:16], 'replaces': r['envSha256'][:16], 'new': rec['environmentSha256'][:16]}))
