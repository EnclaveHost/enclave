# PHASE 3b (ROOT EXECUTES, read-only; activate.py runs the same collect() again just before the restart):
#   python3 work/custody-boot-fee-activation-20261023/prebaseline.py --guestd-vms <root's private GET /vms answer, 0600, <= 300 s old>
# The old control (ed918e4b, restored 21:37Z) is NOT registered and adopted nothing, so /availability has no instanceSweep.held.
# The pre-cutover baseline is therefore guestd's own list, read by root with its existing AUTHENTICATED guestd client (root alone
# holds that key; nothing here reads it). Each app must run exactly ONE guest, running, with a record digest, and it must be the
# guest of the ORIGINAL 21:31:30Z baseline (gd9d4a391d image-generator, gdd0646f2c EyesOff) with the same failed history.
# /availability is recorded as it is: held absent = "old control adopted nothing" (never pretended otherwise); if present it must
# agree with guestd. Actual app health must pass now. Writes evidence/guestd-baseline.json (ids, names, statuses, record
# digests, createdAt and the listing's sha256 only; the raw listing is never copied).
import argparse, json, sys, time
from common import *
import apphealth, guestrows

def collect(guestd_vms, availability, now=None, get=get, fetch=apphealth.fetch, check=apphealth.check):
    now = time.time() if now is None else now
    listing, lsha = guestd_listing(guestd_vms, now)
    base, rows, probs = guestd_baseline(listing, list(APPS), original_baseline())
    st, body = get(availability)
    if st != 200: probs.append(f'/availability -> {st}'); held = None; state = 'unreadable'
    else:
        held = (json.loads(body).get('instanceSweep') or {}).get('held')
        state, p = availability_cross_check(held, base, guestrows) if not probs else ('not compared', []); probs += p
    specs, titles = {}, {}
    for i, s in APPS.items():
        spec = dict(s)
        if s['kind'] == 'html':
            hs, _ctype, hb = fetch(s['url']); spec.update(minBytes=1024, title=apphealth.title_of(hb) if hs == 200 else None); titles[i] = spec['title']
        ok, detail = check(spec)
        if not ok: probs.append(f'{i[:10]} is not actually healthy BEFORE the cutover ({detail})')
        specs[i] = spec
    return {'at': utc(), 'readOnly': True, 'source': {'guestdListingSha256': lsha, 'rows': len(rows)},
            'original': {'file': str(ORIGINAL['file'].name), 'sha256': ORIGINAL['sha256'], 'guests': ORIGINAL['guests']},
            'apps': base, 'otherGuests': [r for r in rows if str(r.get('name', '')).lower() not in APPS],
            'availability': state, 'oldControlAdopted': state == 'present and agrees with guestd', 'health': specs, 'problems': probs}

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--guestd-vms', required=True)
    ap.add_argument('--availability', default='https://api.enclave.host/t/metal0/availability'); a = ap.parse_args()
    out = collect(a.guestd_vms, a.availability)
    (EVIDENCE/'guestd-baseline.json').write_text(json.dumps(out, indent=2) + '\n'); print(json.dumps(out, indent=2))
    if out['problems']: sys.exit(1)
