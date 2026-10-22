"""Produce an exact review manifest and host programs. Does not connect or deploy."""
from pathlib import Path
import hashlib
import json
from transform import transform

HERE = Path(__file__).resolve().parent
HOSTS = {'us-west': '134.199.235.187', 'eu-central': '134.209.248.172',
         'ap-southeast': '165.245.191.129', 'ca-east': '146.190.246.39'}
sha = lambda value: hashlib.sha256(value).hexdigest()


def prepare():
    engine = (HERE.parent / 'directory-https-activation/activation/remote.py').read_bytes()
    overrides = (HERE / 'remote_overrides.py').read_bytes()
    hosts = {}
    for host, ip in HOSTS.items():
        before = (HERE / 'baseline' / (host + '.Caddyfile')).read_bytes()
        after = transform(before.decode(), ip).encode()
        (HERE / 'result' / (host + '.Caddyfile')).write_bytes(after)
        hosts[host] = {'ip': ip, 'baseSha256': sha(before), 'resultSha256': sha(after),
                       'mirror': 'https://' + ip + '/platform-policy'}
    manifest = {'format': 'enclave-platform-policy-mirror-rollout/v1', 'hosts': hosts,
                'engineSha256': sha(engine), 'overridesSha256': sha(overrides),
                'transformSha256': sha((HERE / 'transform.py').read_bytes()),
                'status': 'prepared only; no live route or policy activation implied',
                'policyActivated': False}
    (HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


if __name__ == '__main__':
    result = prepare()
    print(json.dumps({'hosts': len(result['hosts']), 'status': result['status']}))
