"""Beacon API view for the Base client that fills slots the local Lighthouse cannot serve.

python3 -I /opt/enclave-rpc/beacon-patch.py PATCH.json   (listens on 127.0.0.1:15053)

Every request goes to Lighthouse (127.0.0.1:15052) unchanged. Only GET
/eth/v1/beacon/blobs/<slot> for a slot listed in PATCH.json, when Lighthouse does not return
every requested blob, is answered from the patch, and only if the patch holds every
requested versioned hash. The patch is part of the measured image and was verified by the
coverage gate (rpc/base_coverage, --blob-patch: KZG commitment -> versioned hash in the
L1 transactions); Base itself checks each blob against the versioned hashes it derives from L1.
"""
import http.server
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

UPSTREAM = 'http://127.0.0.1:15052'
FORMAT = 'enclave-base-blob-patch/v1'


def load(path):
    doc = json.load(open(path))
    assert doc.get('format') == FORMAT and isinstance(doc.get('slots'), dict), 'blob patch format'
    return {int(k): v for k, v in doc['slots'].items()}


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, status, body, ctype='application/json'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _forward(self):
        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in ('accept', 'content-type', 'eth-consensus-version')}
        req = urllib.request.Request(UPSTREAM + self.path, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.status, r.read(), r.headers.get('Content-Type', 'application/json')
        except urllib.error.HTTPError as e:
            return e.code, e.read(), e.headers.get('Content-Type', 'application/json')

    def _patched(self, status, body):
        u = urllib.parse.urlsplit(self.path)
        parts = u.path.strip('/').split('/')
        if self.command != 'GET' or parts[:4] != ['eth', 'v1', 'beacon', 'blobs'] or len(parts) != 5 or not parts[4].isdigit():
            return None
        slot = PATCH.get(int(parts[4]))
        if slot is None:
            return None
        want = urllib.parse.parse_qs(u.query).get('versioned_hashes', [])
        want = [h for v in want for h in v.split(',')] or sorted(slot)
        if status == 200:
            try:
                if len(json.loads(body).get('data') or []) == len(want):
                    return None
            except ValueError:
                pass
        if not all(h in slot for h in want):
            return None
        return json.dumps({'execution_optimistic': False, 'finalized': True, 'data': [slot[h] for h in want]}).encode()

    def _handle(self):
        status, body, ctype = self._forward()
        patched = self._patched(status, body)
        if patched is not None:
            print(json.dumps({'event': 'beacon-patch-served', 'path': self.path.split('?')[0]}), flush=True)
            return self._send(200, patched)
        self._send(status, body, ctype)

    do_GET = do_POST = _handle


if __name__ == '__main__':
    PATCH = load(sys.argv[1])
    http.server.ThreadingHTTPServer(('127.0.0.1', 15053), Handler).serve_forever()
