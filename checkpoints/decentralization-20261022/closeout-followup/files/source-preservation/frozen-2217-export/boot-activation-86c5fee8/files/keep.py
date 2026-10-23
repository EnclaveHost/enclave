# PHASE 5 (ROOT EXECUTES after its own fresh attestation + capability check): records KEEP; changes nothing on the host.
#   python3 keep.py --checked-attestation <root's fresh attest-control/1 verdict JSON for the approved measurement>
#                   --attestation-raw <its private 0600 raw answer>
#                   [--audit <root's chain audit output> --verified <app id>=<tx> ...]
# Re-asserts read-only, at keep time: attached at the approved candidate; both apps actually healthy; each app's ONE live guest is still the
# baseline guest. Renewal proof is recorded where available (audited --verified pairs must be renewals renewal-watch.py saw);
# without it the keep records "renewals pending audit" honestly - the lease code is byte-identical to deabf8f90's.
import argparse, json, time
from common import *
NEW = load_new()
import apphealth, guestrows
ap = argparse.ArgumentParser(); ap.add_argument('--checked-attestation', required=True); ap.add_argument('--attestation-raw', required=True)
ap.add_argument('--audit'); ap.add_argument('--verified', action='append', default=[])
ap.add_argument('--availability', default='https://api.enclave.host/t/metal0/availability')
a = ap.parse_args()
r = json.loads((A/'result.json').read_text())
assert r.get('productionActivated') == 'provisional', 'not provisional: ' + r.get('state', '')
assert public_attestation(get)['operatorAllowlist']['admittedAtAttach'] == NEW['measurement'], 'not attached at the approved candidate'
specs = apphealth.load_specs(A/'apps-health.json', list(APPS))
for i, s in specs.items(): ok, d = apphealth.check(s); assert ok, f'{i[:10]} not healthy ({d})'
st, body = get(a.availability); assert st == 200
held = json.loads(body)['instanceSweep']['held']
for i in APPS: vm, why = guestrows.the_live_guest(held, i); assert vm == r['preCutoverGuests'][i], f'{i[:10]}: {vm or why} is not the baseline guest'
ev = Path(a.checked_attestation).read_bytes()   # STRICT verdict, never a substring (root 22:08 review)
vp = attestation_verdict_problems(json.loads(ev), NEW['measurement'], r.get('attachedAt'), time.time(), a.attestation_raw)
assert not vp, 'attestation verdict: ' + '; '.join(vp)
v = dict(x.lower().split('=', 1) for x in a.verified)
if v:
    assert a.audit, '--verified needs --audit'
    obs = {k.lower(): t.lower() for k, t in r.get('renewalsObserved', {}).items()}
    assert all(obs.get(k) == t for k, t in v.items()), 'an audited transaction is not a renewal renewal-watch.py recorded'
    audit = Path(a.audit).read_bytes().lower()
    for t in v.values(): assert t.encode() in audit, f'{t} is not in the audit output'
r.update(state=f'KEPT: {NEW["measurement"][:8]} attached, same guests, gate v4 passed, root attestation checked'
               + ('; app-paid renewals audited: ' + ','.join(k[:10] for k in v) if v else '; app-paid renewals pending root audit'),
         productionActivated=True, keptAt=utc(), attestationEvidence={'file': str(Path(a.checked_attestation).resolve()), 'sha256': sha(ev)},
         **({'audit': {'file': str(Path(a.audit).resolve()), 'sha256': sha(Path(a.audit).read_bytes()), 'verified': v}} if v else {}))
(A/'result.json').write_text(json.dumps(r, indent=2) + '\n'); print(r['state'])
