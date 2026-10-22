#!/usr/bin/env python3
"""Sequential policy mirror rollout, using the existing CAS/rollback controller.

`plan` prints a manifest; `apply --hosts us-west --approve <digest>` checks that exact
manifest, activates one host, and verifies public TLS. Failed readback rolls back only
our exact bytes. Unknown SSH outcomes require status then explicit --reconcile.
This publishes transport only, never a signed policy or an on-chain anchor.
"""
import hashlib
import http.client
import importlib.util
import json
from pathlib import Path
import ssl

HERE = Path(__file__).resolve().parent
OLD = HERE.parent / 'directory-https-activation/activation'
spec = importlib.util.spec_from_file_location('policy_rollout_engine', OLD / 'activate.py')
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)

engine.CAND = HERE
engine.REMOTE = 'NO_MAIN = True\n' + (OLD / 'remote.py').read_text() + '\n' + (HERE / 'remote_overrides.py').read_text()
engine.JOURNAL = HERE / 'journal.jsonl'
engine.SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
engine.REMOTE_TIMEOUT = 420
engine.HOST_PARAMS = dict(engine.HOST_PARAMS, peer_locks=[
    '/opt/enclave-site/.site-release.lock', '/etc/enclave-bootstrap-tls/directory-https.lock'])
READY = b'{"format":"enclave-platform-policy-mirror/v1","policyActivated":false}\n'
sha = lambda data: hashlib.sha256(data).hexdigest()


def manifest():
    from transform import transform
    prepared = json.loads((HERE / 'manifest.json').read_text())
    inputs = {'engineSha256': OLD / 'remote.py', 'overridesSha256': HERE / 'remote_overrides.py',
              'transformSha256': HERE / 'transform.py'}
    for field, path in inputs.items():
        if sha(path.read_bytes()) != prepared[field]:
            raise SystemExit('prepared source changed: ' + str(path))
    hosts = {}
    for name, record in prepared['hosts'].items():
        if engine.IPS.get(name) != record['ip']:
            raise SystemExit('unexpected host identity')
        before = (HERE / 'baseline' / (name + '.Caddyfile')).read_bytes()
        after = (HERE / 'result' / (name + '.Caddyfile')).read_bytes()
        if (sha(before) != record['baseSha256'] or sha(after) != record['resultSha256']
                or transform(before.decode(), record['ip']).encode() != after):
            raise SystemExit('prepared config changed: ' + name)
        hosts[name] = {'ip': record['ip'], 'base_sha256': sha(before), 'result_sha256': sha(after),
                       'result_bytes': len(after)}
    if set(hosts) != set(engine.IPS):
        raise SystemExit('host set changed')
    doc = {'schema': 'enclave-platform-policy-mirror-rollout/v1', 'hostParams': engine.HOST_PARAMS,
           'hosts': hosts, 'remoteSha256': sha(engine.REMOTE.encode()),
           'controllerSha256': sha(Path(__file__).read_bytes()),
           'controllerEngineSha256': sha((OLD / 'activate.py').read_bytes()),
           'preparedManifestSha256': sha((HERE / 'manifest.json').read_bytes()),
           'policyActivated': False}
    text = json.dumps(doc, indent=2, sort_keys=True) + '\n'
    return doc, sha(text.encode()), text


def request(ip, method, path, headers=None):
    conn = http.client.HTTPSConnection(ip, timeout=20, context=ssl.create_default_context())
    try:
        conn.request(method, path, headers=headers or {})
        response = conn.getresponse()
        data = response.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('public response exceeds readback limit')
        return response.status, {key.lower(): val for key, val in response.getheaders()}, data
    finally:
        conn.close()


def public_readback(host, expect):
    ip = engine.IPS[host]
    try:
        status, headers, body = request(ip, 'GET', '/platform-policy/ready.json', {'Origin': 'https://independent-dashboard.example'})
        if expect == 'inactive':
            return {'ok': body != READY, 'readyStatus': status, 'state': 'answered', 'policyActivated': False}
        if status != 200 or body != READY or headers.get('access-control-allow-origin') != '*':
            raise ValueError('public readiness or CORS mismatch')
        if headers.get('set-cookie') or headers.get('access-control-allow-credentials'):
            raise ValueError('public mirror unexpectedly uses credentials')
        head = request(ip, 'HEAD', '/platform-policy/ready.json')
        if head[0] != 200 or head[2]:
            raise ValueError('HEAD readback mismatch')
        for method, path in [('POST', '/platform-policy/ready.json'), ('GET', '/platform-policy/unknown.txt')]:
            if request(ip, method, path)[0] != 404:
                raise ValueError('unsupported request was not refused')
        status, _, body = request(ip, 'GET', '/v1/network/records')
        doc = json.loads(body)
        if status != 200 or doc.get('version') != 1 or not isinstance(doc.get('providers'), list):
            raise ValueError('existing public directory failed readback')
        return {'ok': True, 'state': 'answered', 'tlsVerifiedForIP': ip, 'ready': True,
                'directoryProviders': len(doc['providers']), 'policyActivated': False}
    except Exception as error:
        return {'ok': False, 'state': 'unknown' if isinstance(error, OSError) else 'answered',
                'error': type(error).__name__ + ': ' + str(error)[:300]}


engine.manifest = manifest
engine.public_readback = public_readback

if __name__ == '__main__':
    raise SystemExit(engine.main())
