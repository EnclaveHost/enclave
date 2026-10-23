# READ-ONLY, ROOT runs it BEFORE keep.py (keep.py stays frozen; its own --checked-attestation test is only that the file
# CONTAINS the ee5df6b8 hex - a substring, which a failed verdict or any text naming the measurement would also satisfy):
#   python3 work/custody-recipient-activation-20261023/check-attestation-verdict.py evidence/attestation-<UTC>.json
# Accepts ONLY an attest-control/1 verdict for target "new" that PASSED: status verified, admissionSafe, every required
# check PASS, observed == expected == the pinned ee5df6b8, freshness by the verifier's own nonce, VMPL 0, produced AFTER this
# activation attached (result.json attachedAt), with its private raw answer present (0600) and hashing to rawSha256.
import json, os, stat, sys, hashlib, datetime
from pathlib import Path
from common import A, NEW
REQUIRED = ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement', 'binding']
def problems(v, attached_at=None, raw_dir=None):
    out = []
    want = NEW['measurement']
    if v.get('probe') != 'attest-control/1': out.append('not an attest-control/1 verdict')
    if v.get('target') != 'new': out.append(f"target {v.get('target')!r} is not new")
    if v.get('pass') is not True: out.append('pass is not true')
    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append(f"status {v.get('status')!r} / admissionSafe {v.get('admissionSafe')!r}")
    if v.get('expectedMeasurement') != want or v.get('observedMeasurement') != want or v.get('measurementMatches') is not True: out.append('measurement is not the pinned ee5df6b8')
    req = v.get('required') or {}
    for k in REQUIRED:
        if req.get(k) != 'PASS': out.append(f'required check {k!r} is {req.get(k)!r}')
    if v.get('freshness') != 'verifier nonce' or not isinstance(v.get('nonce'), str) or len(v['nonce']) != 64: out.append('not bound to the verifier nonce')
    if v.get('vmpl') != 0: out.append(f"vmpl {v.get('vmpl')!r}")
    if v.get('failedChecks'): out.append(f"failed checks {v['failedChecks']}")
    if attached_at is not None and str(v.get('at', '')) <= attached_at: out.append(f"verdict at {v.get('at')} is not after the attachment {attached_at}")
    if raw_dir is not None:
        stamp = str(v.get('at', '')).replace(':', '').replace('.', '')
        raw = Path(raw_dir) / f'attestation-raw-{stamp}.json'
        if not raw.exists(): out.append(f'private raw answer {raw.name} missing')
        else:
            if stat.S_IMODE(raw.stat().st_mode) != 0o600: out.append('private raw answer is not 0600')
            if hashlib.sha256(raw.read_bytes()).hexdigest() != v.get('rawSha256'): out.append('raw answer does not hash to rawSha256')
    return out
if __name__ == '__main__':
    f = Path(sys.argv[1]); v = json.loads(f.read_text())
    r = json.loads((A / 'result.json').read_text())
    p = problems(v, attached_at=r.get('attachedAt'), raw_dir=A / 'evidence' / 'private')
    print(json.dumps({'file': str(f), 'ok': not p, 'problems': p}))
    sys.exit(1 if p else 0)
