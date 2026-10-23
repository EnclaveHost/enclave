# PHASE 1 (ROOT EXECUTES, read-only, after stage.py): python3 work/custody-boot-fee-activation-20261023/prepare-admission.py
# Reads (a) the PUBLIC attestation allowlist, (b) over root's SSH, READ-ONLY, the relay's installed measurement env file
# (its sha256 and body - a public measurement list, no secret) and its drop-in sha256 and the API service state.
# Asserts: the installed file is the third attempt's admission (136a6553...: the 37 + b007d471) holding exactly the 38 public
# measurements, the running ed918e4b, ee5df6b8, 08d1f838 and b007d471 among them, the approved candidate not yet; the drop-in is the
# installed one. Writes admission.json + measurement.env (ADDITIVE: all 38 in their installed order, then the candidate = 39;
# nothing removed). The remote backup name is unique to the candidate commit (.before-<short>): the earlier .before-a6b1378cd,
# .before-9f6d37bd8 and .before-7dd3acd06 stay untouched (admit.py's CAS refuses an existing backup).
# Changes nothing anywhere.
import json, sys
from common import *
NEW = load_new()
assert not (A/'admission.json').exists(), 'already prepared: inspect'
att = public_attestation(get); al = att['operatorAllowlist']
assert al['admittedAtAttach'] == CURRENT['measurement'], f"production attached at {al['admittedAtAttach'][:16]}, not ed918e4b"
code, out, err = run_remote(remote(REMOTE_READ, (RELAY['env'], RELAY['dropin'], 'systemctl', RELAY['service'])))
if code: sys.exit(f'remote read failed ({code}): {err.strip()[:300]}')
r = json.loads(out.strip().splitlines()[-1])
assert r['serviceActive'] == 'active', r['serviceActive']
assert r['envSha256'] == RELAY['installedSha256'], f"installed env {r['envSha256'][:16]} is not the 38-entry admission (136a6553): inspect first"
assert r['dropinSha256'] == RELAY['dropinSha256'], 'the admission drop-in changed: inspect first'
existing, body = admission_body(r['envBody'], al['measurements'], NEW['measurement'])
(A/'measurement.env').write_text(body)
rec = {'at': utc(), 'stage': 'prepared only', 'existing': existing, 'added': NEW['measurement'], 'admittedAtAttach': al['admittedAtAttach'],
       'replacesInstalledSha256': r['envSha256'], 'environmentSha256': sha(body.encode()), 'dropinSha256': r['dropinSha256'],
       'remoteBackup': RELAY['env'] + '.before-' + NEW['commit'][:9]}
assert not rec['remoteBackup'].endswith(('.before-9f6d37bd8', '.before-a6b1378cd', '.before-7dd3acd06')), 'backup name collides with an earlier attempt'
(A/'admission.json').write_text(json.dumps(rec, indent=2) + '\n')
print(json.dumps({'existing': len(existing), 'added': NEW['measurement'][:16], 'replaces': r['envSha256'][:16], 'new': rec['environmentSha256'][:16]}))
