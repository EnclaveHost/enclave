#!/usr/bin/env python3
"""Controller for the literal-IP HTTPS directory route. NOT run against hosts in this round.

  python3 activation/activate.py plan
  python3 activation/activate.py status   --hosts us-west,eu-central,...          (read-only SSH)
  python3 activation/activate.py apply    --hosts us-west --approve <manifest sha256> [--reconcile]
  python3 activation/activate.py rollback --hosts us-west --approve <manifest sha256> [--reconcile]

Run from anywhere. Hosts are processed one at a time in the order given (canary first); the run stops at the first host
that is not verified. Every step is appended to activation/journal.jsonl with an explicit outcome:
  verified-active | verified-inactive | refused | rolled-back-verified | rollback-refused-drift | unknown
`unknown` (lost connection, ssh/readback timeout, unparsable answer, unverified rollback) blocks apply/rollback on that
host until re-run with --reconcile, which first prints the host's read-only status and then lets the host program
reconcile from the file hash and the running config (compare-and-swap; it never overwrites bytes it does not expect and
never repeats a reload blindly). Exit status is 0 only when every requested host reached the requested verified state.

Test hooks (fixture only; production uses the defaults): DHA_SSH (JSON argv prefix replacing ssh), DHA_READBACK (JSON
argv prefix replacing `node public-readback.mjs`), DHA_JOURNAL, DHA_REMOTE_TIMEOUT, DHA_READBACK_TIMEOUT.
"""
import argparse, base64, hashlib, json, os, subprocess, sys, time, uuid
from pathlib import Path

CAND = Path(__file__).resolve().parent.parent
REMOTE = (CAND / 'activation' / 'remote.py').read_text()
JOURNAL = Path(os.environ.get('DHA_JOURNAL') or (CAND / 'activation' / 'journal.jsonl'))
IPS = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172', 'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'}
HOST_PARAMS = {
    'caddyfile': '/etc/enclave-bootstrap-tls/Caddyfile',
    'caddy': '/usr/local/lib/enclave-caddy/caddy',
    'reload_argv': ['systemctl', 'reload', 'enclave-bootstrap-tls'],
    'admin_socket': '/run/enclave-bootstrap-tls/admin.sock',
    'https_port': 28443,
    'directory_port': 8188,
    'ca_file': None,
    # site-release's root lock (scripts/site-release/root-state.mjs), at the documented release root; flock'ed only if present
    'peer_locks': ['/opt/enclave-site/.site-release.lock'],
}
REMOTE_TIMEOUT = float(os.environ.get('DHA_REMOTE_TIMEOUT', 420))
READBACK_TIMEOUT = float(os.environ.get('DHA_READBACK_TIMEOUT', 180))
SSH = json.loads(os.environ['DHA_SSH']) if os.environ.get('DHA_SSH') else ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
READBACK = json.loads(os.environ['DHA_READBACK']) if os.environ.get('DHA_READBACK') else ['node', str(CAND / 'activation' / 'public-readback.mjs')]
sha = lambda b: hashlib.sha256(b).hexdigest()


def manifest():
    """Recompute and check everything locally before any SSH: baseline hashes, deterministic transform, result hashes."""
    sys.path.insert(0, str(CAND))
    from transform import transform
    hosts = {}
    for h, ip in IPS.items():
        base = (CAND / 'baseline' / (h + '.Caddyfile')).read_bytes()
        result = (CAND / 'result' / (h + '.Caddyfile')).read_bytes()
        if transform(base.decode(), ip).encode() != result:
            raise SystemExit(h + ': result is not transform(baseline)')
        hosts[h] = {'ip': ip, 'base_sha256': sha(base), 'result_sha256': sha(result), 'result_bytes': len(result)}
    doc = {'schema': 'enclave-directory-https-activation/1', 'hostParams': HOST_PARAMS, 'remoteSha256': sha(REMOTE.encode()),
           'transformSha256': sha((CAND / 'transform.py').read_bytes()), 'hosts': hosts}
    text = json.dumps(doc, indent=2, sort_keys=True) + '\n'
    return doc, sha(text.encode()), text


def log(event, **kw):
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    with open(JOURNAL, 'a') as f:
        f.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **kw}, sort_keys=True) + '\n')
        f.flush(); os.fsync(f.fileno())


def last_event(host):
    try:
        rows = [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return None
    rows = [r for r in rows if r.get('host') == host and r['event'] != 'start']
    return rows[-1]['event'] if rows else None


def remote(host, mode, doc, run_id, timeout=None):
    """-> (answer dict | None, detail). None means the outcome is UNKNOWN (no parsable answer)."""
    h = doc['hosts'][host]
    params = {**HOST_PARAMS, 'mode': mode, 'ip': h['ip'], 'base_sha256': h['base_sha256'], 'result_sha256': h['result_sha256'], 'run_id': run_id}
    if mode == 'apply':
        params['result_b64'] = base64.b64encode((CAND / 'result' / (host + '.Caddyfile')).read_bytes()).decode()
    program = 'PARAMS = ' + repr(json.dumps(params)) + '\n' + REMOTE
    try:
        r = subprocess.run([*SSH, host, 'python3', '-'], input=program, capture_output=True, text=True, timeout=timeout or REMOTE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, 'timeout after %ss' % (timeout or REMOTE_TIMEOUT)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
        if not isinstance(out, dict) or 'state' not in out:
            raise ValueError('no state')
        return out, 'rc %s' % r.returncode
    except Exception:
        return None, 'unparsable answer (rc %s): %s' % (r.returncode, ((r.stderr or '') + (r.stdout or ''))[-400:])


def public_readback(host, expect):
    """-> dict with ok True/False, or state 'unknown' when no answer arrived (timeout/crash)."""
    try:
        r = subprocess.run([*READBACK, IPS[host], '--expect', expect], capture_output=True, text=True, timeout=READBACK_TIMEOUT,
                           env={k: v for k, v in os.environ.items() if 'proxy' not in k.lower()})
    except subprocess.TimeoutExpired:
        return {'ok': False, 'state': 'unknown', 'error': 'public readback timeout after %ss' % READBACK_TIMEOUT}
    try:
        out = json.loads(r.stdout)
        out.setdefault('state', 'answered')
        return out
    except Exception:
        return {'ok': False, 'state': 'unknown', 'error': 'public readback unparsable (rc %s): %s' % (r.returncode, (r.stderr or r.stdout)[-400:])}


def classify(out):
    """Remote answer -> journal outcome."""
    s = out.get('state')
    return {'active': 'verified-active', 'rolled-back': 'rolled-back-verified', 'baseline': 'verified-inactive', 'refused': 'refused',
            'rollback-refused-drift': 'rollback-refused-drift'}.get(s, 'unknown')


def run_host(host, mode, doc, digest, run_id, reconcile):
    if last_event(host) in ('unknown', 'rollback-refused-drift') and not reconcile:
        return False, {'host': host, 'outcome': 'refused-local', 'why': 'last outcome %s; read `status`, then re-run with --reconcile' % last_event(host)}
    if reconcile:
        st, detail = remote(host, 'status', doc, run_id, timeout=90)
        print(json.dumps({'host': host, 'reconcileStatus': st, 'detail': detail}, sort_keys=True), flush=True)
        if st is None:
            log('unknown', host=host, mode='status', run=run_id, detail=detail)
            return False, {'host': host, 'outcome': 'unknown', 'why': 'status unavailable; nothing attempted', 'detail': detail}
    log('start', host=host, mode=mode, run=run_id, manifest=digest)
    out, detail = remote(host, mode, doc, run_id)
    if out is None:
        log('unknown', host=host, mode=mode, run=run_id, detail=detail)
        return False, {'host': host, 'outcome': 'unknown', 'detail': detail, 'next': 'status, then --reconcile'}
    outcome = classify(out)
    if outcome in ('verified-active', 'verified-inactive', 'rolled-back-verified'):
        expect = 'active' if outcome == 'verified-active' else 'inactive'
        pub = public_readback(host, expect)
        if pub.get('ok'):
            log(outcome, host=host, mode=mode, run=run_id, remote=out, public=pub)
            ok = (mode == 'apply' and outcome == 'verified-active') or (mode == 'rollback' and outcome in ('rolled-back-verified', 'verified-inactive'))
            return ok, {'host': host, 'outcome': outcome, 'remote': out, 'public': pub}
        log('public-readback-' + ('unknown' if pub.get('state') == 'unknown' else 'failed'), host=host, mode=mode, run=run_id, remote=out, public=pub)
        if outcome != 'verified-active':
            log('unknown', host=host, mode=mode, run=run_id, why='host reports inactive but the public view did not confirm it')
            return False, {'host': host, 'outcome': 'unknown', 'remote': out, 'public': pub}
        # Locally verified, publicly not: roll back THIS host once (host program checks it is still our result first).
        back, bdetail = remote(host, 'rollback', doc, run_id)
        bout = 'unknown' if back is None else classify(back)
        if bout == 'rolled-back-verified':
            pub2 = public_readback(host, 'inactive')
            if not pub2.get('ok'):
                bout = 'unknown'
            log(bout, host=host, mode='rollback', run=run_id, remote=back, public=pub2, cause='public readback failed after activation')
        else:
            log('unknown' if bout == 'unknown' else bout, host=host, mode='rollback', run=run_id, remote=back, detail=bdetail)
        return False, {'host': host, 'outcome': 'public-readback-failed', 'rollback': bout, 'remote': out, 'public': pub, 'rollbackAnswer': back}
    log(outcome, host=host, mode=mode, run=run_id, remote=out)
    return False, {'host': host, 'outcome': outcome, 'remote': out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['plan', 'status', 'apply', 'rollback'])
    ap.add_argument('--hosts', default='')
    ap.add_argument('--approve', default='')
    ap.add_argument('--reconcile', action='store_true')
    a = ap.parse_args()
    doc, digest, text = manifest()
    if a.mode == 'plan':
        print(text + 'manifest sha256 ' + digest)
        return 0
    hosts = [h for h in a.hosts.split(',') if h]
    if not hosts or any(h not in IPS for h in hosts) or len(set(hosts)) != len(hosts):
        raise SystemExit('--hosts: a comma-separated subset of ' + ','.join(IPS))
    if a.mode != 'status' and a.approve != digest:
        raise SystemExit('--approve must equal the reviewed manifest sha256 ' + digest)
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    if a.mode == 'status':
        ok = True
        for host in hosts:
            out, detail = remote(host, 'status', doc, run_id, timeout=90)
            ok = ok and out is not None
            print(json.dumps({'host': host, 'status': out, 'detail': detail}, sort_keys=True), flush=True)
        return 0 if ok else 1
    for host in hosts:
        ok, report = run_host(host, a.mode, doc, digest, run_id, a.reconcile)
        print(json.dumps(report, sort_keys=True), flush=True)
        if not ok:
            print('STOPPED at ' + host + ': ' + report['outcome'], file=sys.stderr)
            return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
