#!/usr/bin/env python3
"""Prepared, NOT deployed. Inspect/CAS-gate/owned-route rollback via existing Caddy socket.

No process signals, service restart, financial call, key access or inspector access.
Gate/restore require --apply and root. Unknown outcomes are never resent automatically.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import stat
import tempfile

SOCKET = '/run/enclave-control-tls/admin.sock'
ROUTES = '/config/apps/http/servers/control/routes'
BACKUPS = Path('/var/lib/enclave-maintenance/session-write-gate')
HOSTS = ['api.enclave.host', 'mcp.enclave.host', 'api.enclavehost.eth',
         'mcp.enclavehost.eth', '62.238.4.214']


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


class UnixHTTP(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(SOCKET)


def api(method, path, value=None, etag=None):
    c = UnixHTTP('localhost', timeout=10)
    headers = {'Content-Type': 'application/json'}
    if etag is not None:
        headers['If-Match'] = etag
    try:
        c.request(method, path, body=None if value is None else encode(value), headers=headers)
        r = c.getresponse()
        body = r.read(2_000_001)
        if len(body) > 2_000_000:
            raise RuntimeError('response too large')
        if not 200 <= r.status < 300:
            # Never print a returned configuration or internal error body.
            raise RuntimeError(f'Caddy HTTP {r.status}; reconcile before any retry')
        return (json.loads(body) if body else None), r.getheader('Etag')
    finally:
        c.close()


def read_routes():
    routes, etag = api('GET', ROUTES)
    if not isinstance(routes, list) or not etag:
        raise RuntimeError('expected routes array and concurrency ETag')
    return routes, etag


def gate_route(op):
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{7,79}', op):
        raise ValueError('operation id must be 8..80 lowercase alphanumeric/hyphen characters')
    return {
        '@id': 'session-write-gate-' + op,
        'match': [{'host': HOSTS, 'path': ['/v1/sessions', '/v1/sessions/*'],
                   'not': [{'method': ['GET', 'HEAD', 'OPTIONS']}]}],
        'handle': [{'handler': 'static_response', 'status_code': 503,
                    'headers': {'Content-Type': ['application/json'],
                                'Cache-Control': ['no-store'], 'Retry-After': ['60'],
                                'Access-Control-Allow-Origin': ['https://enclave.host'],
                                'Access-Control-Allow-Credentials': ['true'], 'Vary': ['Origin']},
                    'body': '{"error":"Session writes temporarily paused for maintenance",'
                            '"code":"session_maintenance"}'}],
        'terminal': True,
    }


def check_precondition(routes, etag, expected_hash, expected_etag):
    if digest(routes) != expected_hash or etag != expected_etag:
        raise RuntimeError('live routes changed; no mutation attempted')


def remove_owned(routes, owned):
    found = [i for i, r in enumerate(routes) if r.get('@id') == owned['@id']]
    if len(found) != 1 or routes[found[0]] != owned:
        raise RuntimeError('owned route absent, duplicated or changed; do not overwrite')
    return routes[:found[0]] + routes[found[0] + 1:]


def secure_dir(path, create=False):
    if create and not path.exists():
        path.mkdir(mode=0o700)
        sync_dir(path.parent)
    s = path.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o700:
        raise RuntimeError('backup directory must be a root-owned real directory mode0700')


def sync_dir(path):
    d = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(d)
    finally:
        os.close(d)


def save(path, value):
    # The exclusive operation directory is root-only; atomic replace + fsync.
    fd, temp = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(encode(value) + b'\n')
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
        d = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(d)
        finally:
            os.close(d)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def load(path):
    s = path.lstat()
    if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or stat.S_IMODE(s.st_mode) != 0o600:
        raise RuntimeError('state must be a root-owned regular file mode0600')
    return json.loads(path.read_text())


def mutate(method, routes, etag, state, path, phase):
    state['phase'] = phase + '-unknown'
    save(path, state)  # durable intent before sending; never retry on exception
    api(method, ROUTES, routes, etag)
    live, _ = read_routes()
    if live != routes:
        raise RuntimeError('post-write state differs; preserve unknown outcome and reconcile')
    state['phase'] = phase + '-verified'
    state['afterHash'] = digest(live)
    save(path, state)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('action', choices=['inspect', 'gate', 'status', 'restore'])
    p.add_argument('--op')
    p.add_argument('--expected-hash')
    p.add_argument('--expected-etag')
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    routes, etag = read_routes()
    if a.action == 'inspect':
        upstreams, _ = api('GET', '/reverse_proxy/upstreams')
        print(json.dumps({'routesSha256': digest(routes), 'etag': etag,
                          'gateIds': [r.get('@id') for r in routes
                                      if str(r.get('@id', '')).startswith('session-write-gate-')],
                          'upstreams': upstreams}))
        return
    owned = gate_route(a.op or '')
    opdir = BACKUPS / a.op
    statepath = opdir / 'state.json'
    if a.action == 'status':
        secure_dir(BACKUPS); secure_dir(opdir)
        s = load(statepath)
        hits = [r for r in routes if r.get('@id') == owned['@id']]
        print(json.dumps({'phase': s['phase'], 'ownedGateExact': hits == [owned],
                          'gateAbsent': not hits, 'routesSha256': digest(routes),
                          'matchesBefore': digest(routes) == s['beforeHash'], 'etag': etag}))
        return
    if not a.apply or os.geteuid() != 0:
        raise RuntimeError('mutation requires explicit --apply and root; no mutation attempted')
    check_precondition(routes, etag, a.expected_hash, a.expected_etag)
    if a.action == 'gate':
        if any(str(r.get('@id', '')).startswith('session-write-gate-') for r in routes):
            raise RuntimeError('a maintenance gate already exists; reconcile rather than stack')
        secure_dir(Path('/var/lib/enclave-maintenance'), create=True)
        secure_dir(BACKUPS, create=True)
        opdir.mkdir(mode=0o700)  # exclusive: never silently rerun an old operation
        sync_dir(BACKUPS)
        secure_dir(opdir)
        save(opdir / 'routes-before.json', routes)
        s = {'op': a.op, 'beforeHash': digest(routes), 'beforeEtag': etag,
             'owned': owned, 'phase': 'prepared', 'sourceSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
        save(statepath, s)
        mutate('PATCH', [owned] + routes, etag, s, statepath, 'gate')
    else:
        secure_dir(BACKUPS); secure_dir(opdir)
        s = load(statepath)
        if s['owned'] != owned or s['op'] != a.op:
            raise RuntimeError('operation identity mismatch')
        # Remove only this exact owned route; preserve concurrent unrelated edits.
        updated = remove_owned(routes, owned)
        mutate('PATCH', updated, etag, s, statepath, 'restore')
    print(json.dumps({'op': a.op, 'phase': s['phase'], 'routesSha256': s['afterHash'],
                      'backupDirectory': str(opdir)}))


if __name__ == '__main__':
    main()
