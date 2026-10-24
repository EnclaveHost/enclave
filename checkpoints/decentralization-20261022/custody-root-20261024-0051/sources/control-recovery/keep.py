# PHASE 5 (ROOT EXECUTES after its own fresh attestation + capability check): records KEEP; changes nothing on the host.
#   python3 keep.py --checked-attestation <evidence/attestation-<UTC>.json from `node attest-price.mjs attest` (target priceRecovery)>
#                   --attestation-raw <its private 0600 raw answer, evidence/private/attestation-raw-<UTC>.json>
# FINAL RECOVERY: KEEP also REQUIRES each app's normal renewal by the new control, receipt-verified on two RPCs (renewal_attribution_problems).
# Re-asserts read-only, at keep time: attached at the approved candidate; both apps actually healthy; each app's ONE live guest is still the
# baseline guest. Then every app's normal renewal: renewal-watch.py (run after each app's renew window) records the tx the NEW
# control logged; KEEP refuses (the activation stays PROVISIONAL) until each has a matching two-RPC receipt with the ledger's
# Renewed log for that app and metal0, after the attachment. Never /availability alone.
import argparse, json, time
from common import *
NEW = load_new()
import apphealth, guestrows
ap = argparse.ArgumentParser(); ap.add_argument('--checked-attestation', required=True); ap.add_argument('--attestation-raw', required=True)
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
vp = attestation_verdict_problems(json.loads(ev), NEW['measurement'], r.get('attachedAt'), time.time(), a.attestation_raw, build_sha=NEW['buildSha256'])
assert not vp, 'attestation verdict: ' + '; '.join(vp)
# ACTUAL normal renewal attribution for BOTH apps (run renewal-watch.py after each app's renew window first): never /availability alone
import datetime as _dt
attached_ts = _dt.datetime.fromisoformat(r['attachedAt']).timestamp() if r.get('attachedAt') else None
attrib, probs = {}, []
for i in APPS:
    tx = (r.get('renewalsObserved') or {}).get(i)
    recs, ts = renewal_receipts(tx) if tx else ([], None)
    p = renewal_attribution_problems(i, tx, recs, ts, attached_ts); probs += p
    attrib[i] = {'tx': tx, 'blockTimestamp': ts, 'ok': not p}
r['renewalAttribution'] = attrib; (A/'result.json').write_text(json.dumps(r, indent=2) + '\n')
assert not probs, 'renewal attribution (KEEP refused, still PROVISIONAL): ' + '; '.join(probs)
r.update(state=f'KEPT: {NEW["measurement"][:8]} attached, same guests, gate v5 passed, root attestation checked, normal renewals attributed: '
               + ', '.join(f'{k[:10]} {v["tx"][:12]}' for k, v in attrib.items()),
         productionActivated=True, keptAt=utc(), attestationEvidence={'file': str(Path(a.checked_attestation).resolve()), 'sha256': sha(ev)})
(A/'result.json').write_text(json.dumps(r, indent=2) + '\n'); print(r['state'])
