#!/usr/bin/env python3
"""Controller for the literal-IP HTTPS directory route. NOT run against hosts in this round.

  python3 activation/activate.py plan
  python3 activation/activate.py status   --hosts us-west,eu-central,...          (read-only SSH)
  python3 activation/activate.py apply    --hosts us-west --approve <manifest sha256> [--reconcile]
  python3 activation/activate.py rollback --hosts us-west --approve <manifest sha256>

Run from the workspace root. Hosts are processed one at a time in the order given (canary first); the run stops at the
first host that is not verified active (local readback on the host AND public readback from here). Every step is
appended to activation/journal.jsonl. A host whose last journal event is `unknown` (lost connection, timeout, unparsable
answer) is refused by apply/rollback until re-run with --reconcile, which first prints its read-only status; the host
script then reconciles from the file hash and the running config (never a blind second install or reload loop).
"""
import argparse, base64, hashlib, json, os, subprocess, sys, time, uuid
from pathlib import Path

CAND = Path(__file__).resolve().parent.parent
REMOTE = (CAND / 'activation' / 'remote.py').read_text()
JOURNAL = CAND / 'activation' / 'journal.jsonl'
MANIFEST = CAND / 'activation' / 'manifest.json'
IPS = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172', 'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'}
HOST_PARAMS = {
    'caddyfile': '/etc/enclave-bootstrap-tls/Caddyfile',
    'caddy': '/usr/local/lib/enclave-caddy/caddy',
    'reload_argv': ['systemctl', 'reload', 'enclave-bootstrap-tls'],
    'admin_socket': '/run/enclave-bootstrap-tls/admin.sock',
    'https_port': 28443,
    'directory_port': 8188,
    'ca_file': None,
}
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
    with open(JOURNAL, 'a') as f:
        f.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **kw}, sort_keys=True) + '\n')
        f.flush(); os.fsync(f.fileno())


def last_event(host):
    try:
        rows = [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return None
    rows = [r for r in rows if r.get('host') == host]
    return rows[-1]['event'] if rows else None


def remote(host, mode, doc, run_id, timeout=420):
    h = doc['hosts'][host]
    params = {**HOST_PARAMS, 'mode': mode, 'ip': h['ip'], 'base_sha256': h['base_sha256'], 'result_sha256': h['result_sha256'], 'run_id': run_id}
    if mode == 'apply':
        params['result_b64'] = base64.b64encode((CAND / 'result' / (host + '.Caddyfile')).read_bytes()).decode()
    program = 'PARAMS = ' + repr(json.dumps(params)) + '\n' + REMOTE
    try:
        r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', host, 'python3', '-'],
                           input=program, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, 'timeout'
    try:
        return json.loads(r.stdout.strip().splitlines()[-1]), r.returncode
    except Exception:
        return None, 'unparsable (ssh rc %s): %s' % (r.returncode, (r.stderr or '')[-400:])


def public_readback(host, expect):
    r = subprocess.run(['node', str(CAND / 'activation' / 'public-readback.mjs'), IPS[host], '--expect', expect],
                       capture_output=True, text=True, timeout=180, env={k: v for k, v in os.environ.items() if 'proxy' not in k.lower()})
    try:
        out = json.loads(r.stdout)
    except Exception:
        out = {'ok': False, 'error': (r.stderr or r.stdout)[-600:]}
    return out


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
        return
    hosts = [h for h in a.hosts.split(',') if h]
    if not hosts or any(h not in IPS for h in hosts) or len(set(hosts)) != len(hosts):
        raise SystemExit('--hosts: a comma-separated subset of ' + ','.join(IPS))
    if a.mode != 'status' and a.approve != digest:
        raise SystemExit('--approve must equal the reviewed manifest sha256 ' + digest)
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    for host in hosts:
        if a.mode == 'status':
            out, rc = remote(host, 'status', doc, run_id, timeout=90)
            print(json.dumps({'host': host, 'status': out, 'rc': rc}, sort_keys=True)); continue
        if last_event(host) == 'unknown' and not a.reconcile:
            raise SystemExit(host + ': last outcome unknown; re-run with --reconcile after reading `status`')
        if a.reconcile:
            out, rc = remote(host, 'status', doc, run_id, timeout=90)
            print(json.dumps({'host': host, 'reconcileStatus': out, 'rc': rc}, sort_keys=True))
            if out is None:
                raise SystemExit(host + ': status unavailable; nothing attempted')
        log('start', host=host, mode=a.mode, run=run_id, manifest=digest)
        out, rc = remote(host, a.mode, doc, run_id)
        if out is None:
            log('unknown', host=host, mode=a.mode, run=run_id, detail=str(rc))
            raise SystemExit(host + ': outcome UNKNOWN (' + str(rc) + '); stop. Next: status, then --reconcile')
        if rc != 0 or out.get('state') not in ('active', 'baseline', 'rolled-back'):
            log('refused', host=host, mode=a.mode, run=run_id, out=out)
            raise SystemExit(host + ': ' + json.dumps(out))
        expect = 'active' if (a.mode == 'apply' and out['state'] == 'active') else 'inactive'
        pub = public_readback(host, expect)
        log(('verified-' + expect) if pub.get('ok') else 'public-readback-failed', host=host, mode=a.mode, run=run_id, out=out, public=pub)
        print(json.dumps({'host': host, 'remote': out, 'public': pub}, sort_keys=True))
        if a.mode == 'apply' and out['state'] == 'active' and not pub.get('ok'):
            # Locally verified but not publicly: roll back THIS host only, once, and stop the rollout.
            back, brc = remote(host, 'rollback', doc, run_id)
            log('unknown' if back is None else 'public-failure-rollback', host=host, run=run_id, out=back, detail=str(brc))
            raise SystemExit(host + ': public readback failed; host rolled back: ' + json.dumps(back))
        if a.mode == 'apply' and out['state'] != 'active':
            raise SystemExit(host + ': not active (' + out['state'] + '); rollout stopped')


if __name__ == '__main__':
    main()
