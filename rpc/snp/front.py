"""In-enclave RPC front for the SEV-SNP RPC guest.

At boot it creates a TLS key that never leaves guest memory, asks the AMD-SP for
an SNP report whose report_data is sha256(certificate SPKI DER) || 32 zero bytes,
and serves:

  GET  /.well-known/enclave-attestation  {report, certificate, reportData}
  GET  /health                           local L1/Base sync summary (no secrets)
  GET  /logs/{el,cl,base,front,identity}  bounded journal tail (operator view)
  POST /l1, POST /base                   JSON-RPC proxied to the local node

A client that verifies the report (AMD VCEK chain, expected launch measurement)
and then sees the same certificate on the TLS session knows it is talking to the
measured image. Only read-only JSON-RPC namespaces are forwarded; nothing here
can sign, mine, administer the nodes or reach the engine API.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socketserver
import ssl
import subprocess
import sys
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = Path('/run/enclave-rpc-front')
UPSTREAM = {'/l1': 'http://127.0.0.1:18645', '/base': 'http://127.0.0.1:18545'}
BEACON = 'http://127.0.0.1:15052'
ALLOWED = re.compile(r'^(eth_(?!sign|sendTransaction|accounts|coinbase|mining|hashrate|submit|getWork)[A-Za-z]+|net_(version|listening|peerCount)|web3_clientVersion)$')
MAX_BODY = 1 << 20
LOG_UNITS = {'/logs/'+k: 'enclave-rpc-%s.service' % k for k in ('el', 'cl', 'base', 'front', 'identity')}
MAX_BATCH = 100


def tsm_report(report_data):
    root = Path('/sys/kernel/config/tsm/report')
    if not root.is_dir():
        subprocess.run(['/usr/bin/mount', '-t', 'configfs', 'none', '/sys/kernel/config'], check=False)
    entry = root/('front-%d' % os.getpid())
    entry.mkdir()
    try:
        (entry/'inblob').write_bytes(report_data)
        if (entry/'provider').read_text().strip() != 'sev_guest':
            raise RuntimeError('SEV-SNP report provider required')
        return (entry/'outblob').read_bytes()
    finally:
        entry.rmdir()


def identity():
    STATE.mkdir(mode=0o700, exist_ok=True)
    key, cert = STATE/'key.pem', STATE/'cert.pem'
    subprocess.run(['/usr/bin/openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
                    '-nodes', '-keyout', str(key), '-out', str(cert), '-days', '3650', '-subj', '/CN=enclave-rpc',
                    '-addext', 'subjectAltName=DNS:enclave-rpc'], check=True, capture_output=True, timeout=20)
    spki = subprocess.run(['/usr/bin/openssl', 'x509', '-in', str(cert), '-noout', '-pubkey'], check=True,
                          capture_output=True, timeout=10).stdout
    der = subprocess.run(['/usr/bin/openssl', 'pkey', '-pubin', '-outform', 'DER'], input=spki, check=True,
                         capture_output=True, timeout=10).stdout
    report_data = hashlib.sha256(der).digest() + bytes(32)
    report = tsm_report(report_data)
    if len(report) < 0x2a0 or report[0x50:0x90] != report_data:
        raise RuntimeError('SNP report does not bind the front key')
    doc = {'schema': 'enclave-rpc-attestation/1', 'report': base64.b64encode(report).decode(),
           'certificate': cert.read_text(), 'reportData': report_data.hex(),
           'measurement': report[0x90:0xc0].hex()}
    (STATE/'attestation.json').write_text(json.dumps(doc))
    return key, cert, json.dumps(doc).encode()


def post(url, body, timeout=30):
    req = urllib.request.Request(url, data=body, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(16 << 20)


def health():
    out = {}
    for name, url in UPSTREAM.items():
        try:
            rows = json.loads(post(url, json.dumps([
                {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_syncing', 'params': []},
                {'jsonrpc': '2.0', 'id': 2, 'method': 'eth_getBlockByNumber', 'params': ['latest', False]}]).encode(), 5))
            res = {x['id']: x.get('result') for x in rows}
            out[name[1:]] = {'syncing': res[1] is not False, 'head': int(res[2]['number'], 16),
                             'headTimestamp': int(res[2]['timestamp'], 16)}
        except Exception as e:
            out[name[1:]] = {'error': type(e).__name__}
    try:
        with urllib.request.urlopen(BEACON+'/eth/v1/node/syncing', timeout=5) as r:
            out['beacon'] = json.loads(r.read(65536))['data']
    except Exception as e:
        out['beacon'] = {'error': type(e).__name__}
    return out


def allowed(call):
    return isinstance(call, dict) and isinstance(call.get('method'), str) and ALLOWED.match(call['method'])


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    attestation = b''
    timeout = 30  # also bounds the lazy TLS handshake, which runs in this thread

    def log_message(self, *args):
        pass

    def reply(self, code, body, kind='application/json'):
        self.send_response(code)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == '/.well-known/enclave-attestation':
            self.reply(200, self.attestation)
        elif self.path == '/health':
            self.reply(200, json.dumps(health()).encode())
        elif self.path.split('?')[0] in LOG_UNITS:
            # Read-only operator view; a public gateway forwards only RPC, attestation and health.
            query = dict(x.split('=', 1) for x in self.path.partition('?')[2].split('&') if '=' in x)
            lines = min(max(int(query.get('lines', '200')) if query.get('lines', '').isdigit() else 200, 1), 2000)
            r = subprocess.run(['/usr/bin/journalctl', '-u', LOG_UNITS[self.path.split('?')[0]], '-n', str(lines),
                                '-o', 'short-iso', '--no-pager'], capture_output=True, timeout=15)
            self.reply(200, r.stdout[-(4 << 20):], 'text/plain; charset=utf-8')
        else:
            self.reply(404, b'{"error":"not found"}')

    def do_POST(self):
        upstream = UPSTREAM.get(self.path)
        length = int(self.headers.get('content-length') or 0)
        if upstream is None or not 0 < length <= MAX_BODY:
            return self.reply(404 if upstream is None else 413, b'{"error":"unsupported"}')
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            return self.reply(400, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}')
        calls = body if isinstance(body, list) else [body]
        if not calls or len(calls) > MAX_BATCH or not all(allowed(c) for c in calls):
            return self.reply(403, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"method not allowed"}}')
        try:
            self.reply(200, post(upstream, json.dumps(body).encode()))
        except Exception:
            self.reply(502, b'{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"node unavailable"}}')


class Server(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
    request_queue_size = 256


def stage(name, **fields):
    print(json.dumps({'event': 'front-'+name, **fields}), flush=True)


def main():
    stage('starting')
    key, cert, doc = identity()
    stage('attested')
    Handler.attestation = doc
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(cert, key)
    os.unlink(key)  # the loaded context keeps the key; nothing else in the guest needs it
    srv = Server(('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8443), Handler)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    stage('ready', measurement=json.loads(doc)['measurement'])
    srv.serve_forever()


if __name__ == '__main__':
    main()
