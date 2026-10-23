# READ-ONLY, ROOT runs it on the recovery attestation BEFORE work/custody-boot-activation-20261023/keep.py, whose own
# --checked-attestation test is only that the file's bytes CONTAIN the measurement hex (a substring: a failed verdict, a verdict
# for another target, or any text naming 08d1f838 would satisfy it). Pass keep.py the SAME verdict file this accepts.
#   python3 work/custody-recipient-activation-20261023/check-recovery-verdict.py evidence/attestation-<UTC>.json
# Accepts ONLY a `recovery-target.mjs attest` verdict (attest-control/1 via wrapper recovery-target/1, target "recovery") that the
# wrapper ACCEPTED: pass, status verified, admissionSafe, every required check PASS, no failed check, observed == expected == the
# pinned 08d1f838 (= recovery-target.mjs RECOVERY.measurement, test-checked), freshness by the verifier's own 64-hex nonce, VMPL 0;
# made AFTER the activation attached (custody-boot-activation-20261023/result.json attachedAt, whose measurement must be the pin and
# state provisional) and at most MAX_AGE_S before now; its private raw answer present, 0600, hashing to rawSha256.
import datetime, hashlib, json, stat, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
PIN = '08d1f838d51274571fdf17b635606d20a6e7250f74d6676217eea40733a8d269aaf52edb85aac4a9ad1cc5c53318a000'
RESULT = HERE.parent / 'custody-boot-activation-20261023' / 'result.json'
REQUIRED = ['report shape', 'product line', 'guest policy', 'chain', 'tcb policy', 'measurement', 'binding']
MAX_AGE_S = 900

def when(s):
    """ISO-8601 with Z or an offset -> aware datetime; anything else -> None (never compared as text)."""
    try: t = datetime.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    except ValueError: return None
    return t if t.tzinfo else None

def problems(v, result, raw_dir, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    out = []
    if v.get('probe') != 'attest-control/1' or v.get('wrapper') != 'recovery-target/1': out.append('not a recovery-target.mjs attest verdict')
    if v.get('target') != 'recovery': out.append(f"target {v.get('target')!r} is not recovery")
    if v.get('accepted') is not True or v.get('pass') is not True: out.append('the wrapper did not accept it')
    if v.get('status') != 'verified' or v.get('admissionSafe') is not True: out.append(f"status {v.get('status')!r} / admissionSafe {v.get('admissionSafe')!r}")
    if (v.get('expectedMeasurement'), v.get('observedMeasurement'), v.get('measurementMatches')) != (PIN, PIN, True): out.append('measurement is not the pinned 08d1f838')
    req = v.get('required') or {}
    for k in REQUIRED:
        if req.get(k) != 'PASS': out.append(f'required check {k!r} is {req.get(k)!r}')
    if v.get('failedChecks') != []: out.append(f"failed checks {v.get('failedChecks')!r}")
    n = v.get('nonce')
    if v.get('freshness') != 'verifier nonce' or not (isinstance(n, str) and len(n) == 64 and all(c in '0123456789abcdef' for c in n)): out.append('not bound to the verifier nonce')
    if v.get('vmpl') != 0: out.append(f"vmpl {v.get('vmpl')!r}")
    if result.get('measurement') != PIN: out.append('the activation result is for another measurement')
    if result.get('productionActivated') != 'provisional': out.append(f"the activation is not provisional ({result.get('productionActivated')!r})")
    at, attached = when(v.get('at')), when(result.get('attachedAt'))
    if at is None: out.append(f"verdict time {v.get('at')!r} unreadable")
    elif attached is None: out.append('the activation has no readable attachedAt')
    else:
        if at <= attached: out.append(f"verdict at {v.get('at')} is not after the attachment {result.get('attachedAt')}")
        if (now - at).total_seconds() > MAX_AGE_S: out.append(f'verdict is older than {MAX_AGE_S} s: attest again')
        if (at - now).total_seconds() > 30: out.append('verdict is from the future')
    stamp = str(v.get('at', '')).replace(':', '').replace('.', '')
    raw = Path(raw_dir) / f'attestation-raw-{stamp}.json'
    if not raw.is_file(): out.append(f'private raw answer {raw.name} missing')
    else:
        if stat.S_IMODE(raw.stat().st_mode) != 0o600: out.append('private raw answer is not 0600')
        if hashlib.sha256(raw.read_bytes()).hexdigest() != v.get('rawSha256'): out.append('raw answer does not hash to rawSha256')
    return out

if __name__ == '__main__':
    f = Path(sys.argv[1]); v = json.loads(f.read_text())
    p = problems(v, json.loads(RESULT.read_text()), HERE / 'evidence' / 'private')
    print(json.dumps({'file': str(f), 'sha256': hashlib.sha256(f.read_bytes()).hexdigest(), 'ok': not p, 'problems': p}))
    sys.exit(1 if p else 0)
