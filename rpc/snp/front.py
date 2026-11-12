"""In-enclave RPC front for the SEV-SNP RPC guest.

At boot it creates a TLS key that never leaves guest memory, asks the AMD-SP for
an SNP report whose report_data is sha256(certificate SPKI DER) || 32 zero bytes,
and serves:

  GET  /                                 the web page: chain heads, endpoints, a request box, the attestation
  GET  /.well-known/enclave-attestation  {report, certificate, reportData}: the boot document
  GET  /.well-known/enclave-attestation?nonce=<64 hex>
                                         a FRESH report over sha256(SPKI DER || nonce), for a caller's own challenge
  GET  /.well-known/enclave-ready        200 once the front serves
  GET  /.well-known/enclave-csr          a certificate request for the app name, signed by the same key
  POST /.well-known/enclave-cert         a CA-issued chain for that request (installed only if it verifies)
  GET  /health                           local L1/Base sync summary (no secrets)
  GET  /logs/{el,cl,base,front,identity}  bounded journal tail (operator view, local name only)
  GET  /beacon/eth/...                   allowlisted read-only beacon API (blobs, blocks, headers)
  POST /l1 (or /ethereum), POST /base    JSON-RPC proxied to the local node

A client that verifies the report (AMD VCEK chain, expected launch measurement)
and then sees the same key on the TLS session knows it is talking to the
measured image. Only read-only JSON-RPC namespaces are forwarded; nothing here
can sign, mine, administer the nodes or reach the engine API.

Two names, one key. The local name `enclave-rpc` is served on the boot's
self-signed certificate: the gateway, the host's manager and the local proxy pin
its attested key and need no CA. The app name is `<first 8 hex of HOST_DATA>.` +
APP_ZONE, the deployment's address in the platform's app zone: for it the front
hands out a certificate request and takes back the chain a public CA issued, so
a browser reaches the same key over ordinary WebPKI TLS. The front checks a
chain itself (its own key, its app name, a root this image trusts, in date)
before serving it, so whoever delivers the chain needs no trust at all.
"""
import base64
import calendar
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
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = Path('/run/enclave-rpc-front')
UPSTREAM = {'/l1': 'http://127.0.0.1:18645', '/ethereum': 'http://127.0.0.1:18645', '/base': 'http://127.0.0.1:18545'}
BEACON = 'http://127.0.0.1:15052'
ALLOWED = re.compile(r'^(eth_(?!sign|sendTransaction|accounts|coinbase|mining|hashrate|submit|getWork)[A-Za-z]+|net_(version|listening|peerCount)|web3_clientVersion)$')
MAX_BODY = 1 << 20
BEACON_PATH = re.compile(r'^/eth/(v1/beacon/(blobs|blob_sidecars|headers|genesis|states/[a-z0-9x]+/finality_checkpoints)|v2/beacon/blocks|v1/node/(syncing|version|identity)|v1/config/spec)(/[A-Za-z0-9]+)?$')
LOG_UNITS = {'/logs/'+k: 'enclave-rpc-%s.service' % k for k in ('el', 'cl', 'base', 'front', 'identity')}
MAX_BATCH = 100
LOCAL_NAME = 'enclave-rpc'
APP_ZONE = 'app.enclave.host'
FRESH_FORMAT = 'sev-snp-vm-v1'
PAGE = Path(__file__).resolve().parent/'front.html'
CA_FILE = '/etc/ssl/certs/ca-certificates.crt'
OPENSSL = '/usr/bin/openssl'
MAX_CHAIN = 64 << 10
PEM_CERT = re.compile(rb'-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----')
# The AMD-SP answers one report at a time and the host may throttle guest requests: one fresh report runs while at
# most this many wait; a caller beyond that is told to retry (the platform's probes wait that answer out).
FRESH_WAITERS = 4
HEALTH_TTL = 2.0


def tsm_report(report_data):
    root = Path('/sys/kernel/config/tsm/report')
    if not root.is_dir():
        subprocess.run(['/usr/bin/mount', '-t', 'configfs', 'none', '/sys/kernel/config'], check=False)
    entry = root/('front-%d-%d' % (os.getpid(), threading.get_ident()))
    entry.mkdir()
    try:
        (entry/'inblob').write_bytes(report_data)
        if (entry/'provider').read_text().strip() != 'sev_guest':
            raise RuntimeError('SEV-SNP report provider required')
        return (entry/'outblob').read_bytes()
    finally:
        entry.rmdir()


def openssl(*args, data=None, timeout=20):
    return subprocess.run([OPENSSL, *args], input=data, check=True, capture_output=True, timeout=timeout).stdout


def spki_of(cert_pem):
    return openssl('pkey', '-pubin', '-outform', 'DER', data=openssl('x509', '-noout', '-pubkey', data=cert_pem))


def root_hash():
    """The dm-verity root hash this guest booted: on the kernel command line, which the launch measurement covers."""
    try:
        m = re.search(r'(?:^|\s)enclave\.roothash=([0-9a-f]{64})(?:\s|$)', Path('/proc/cmdline').read_text())
    except OSError:
        m = None
    return m.group(1) if m else ''


def csr_for(key, name):
    """A request for exactly CN=name, SAN=[name]: the only shape the platform's certificate service accepts."""
    conf = STATE/'csr.cnf'
    conf.write_text('[req]\ndistinguished_name=dn\nreq_extensions=ext\nprompt=no\n[dn]\nCN=%s\n[ext]\nsubjectAltName=DNS:%s\n' % (name, name))
    try:
        return openssl('req', '-new', '-key', str(key), '-config', str(conf), '-sha256')
    finally:
        conf.unlink()


class Front:
    """This boot's identity: one key, its SNP report, and the certificates it is served on."""

    def __init__(self):
        STATE.mkdir(mode=0o700, exist_ok=True)
        key, cert = STATE/'key.pem', STATE/'cert.pem'
        openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', str(key),
                '-out', str(cert), '-days', '3650', '-subj', '/CN='+LOCAL_NAME, '-addext', 'subjectAltName=DNS:'+LOCAL_NAME)
        self.spki = spki_of(cert.read_bytes())
        report_data = hashlib.sha256(self.spki).digest() + bytes(32)
        report = tsm_report(report_data)
        if len(report) < 0x2a0 or report[0x50:0x90] != report_data:
            raise RuntimeError('SNP report does not bind the front key')
        self.measurement = report[0x90:0xc0].hex()
        self.host_data = report[0xc0:0xe0].hex()   # the deployment id the host launched this VM for (signed by the AMD-SP)
        self.root_hash = root_hash()
        doc = {'schema': 'enclave-rpc-attestation/1', 'report': base64.b64encode(report).decode(),
               'certificate': cert.read_text(), 'reportData': report_data.hex(), 'measurement': self.measurement}
        self.boot_doc = json.dumps(doc).encode()
        (STATE/'attestation.json').write_bytes(self.boot_doc)
        # A VM launched for no deployment (all-zero HOST_DATA: a smoke boot) has no app name and asks for no certificate.
        self.app_name = self.host_data[:8]+'.'+APP_ZONE if int(self.host_data, 16) else ''
        self.csr = csr_for(key, self.app_name) if self.app_name else b''
        self.local = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.local.minimum_version = ssl.TLSVersion.TLSv1_2
        self.local.load_cert_chain(cert, key)
        self.local.sni_callback = self.pick
        # The loaded context keeps the key. The PEM stays in this process alone, for the app name's context later; nothing
        # else in the guest needs it and no file holds it.
        self.key_pem = key.read_bytes()
        key.unlink()
        self.app = None            # the SSLContext for the app name, once a chain is installed
        self.app_not_after = 0
        self.installing = threading.Lock()
        self.reports = threading.Lock()
        self.waiters = threading.BoundedSemaphore(FRESH_WAITERS)
        self.health_at, self.health_doc = 0.0, b''
        self.health_lock = threading.Lock()

    def pick(self, sock, name, _ctx):
        """SNI: the app name gets its CA-issued chain once there is one; every other name the boot certificate."""
        sock.enclave_sni = (name or '').lower()
        if self.app is not None and sock.enclave_sni == self.app_name:
            sock.context = self.app

    def fresh(self, nonce_hex):
        """A report made now, binding this key to the caller's nonce. None when too many callers already wait."""
        if not self.waiters.acquire(blocking=False):
            return None
        try:
            report_data = hashlib.sha256(self.spki + bytes.fromhex(nonce_hex)).digest() + bytes(32)
            with self.reports:
                report = tsm_report(report_data)
            if len(report) < 0x2a0 or report[0x50:0x90] != report_data:
                raise RuntimeError('SNP report does not bind the nonce')
            return json.dumps({'format': FRESH_FORMAT, 'nonce': nonce_hex, 'transportKey': base64.b64encode(self.spki).decode(),
                               'appSha256': self.root_hash, 'report': base64.b64encode(report).decode(),
                               'measurement': report[0x90:0xc0].hex(), 'hostData': report[0xc0:0xe0].hex()}).encode()
        finally:
            self.waiters.release()

    def install(self, pem):
        """Serve the app name on this chain, if it is this key's, for this name, in date, and from a root this image trusts.

        Returns (True, notAfter) or (False, reason). Whoever posts it is not trusted and need not be: a chain that passes
        is one a public CA issued for this guest's own request, and a chain that does not pass changes nothing.
        """
        if not self.app_name:
            return False, 'this VM has no app name'
        certs = PEM_CERT.findall(pem)
        if not 1 <= len(certs) <= 6:
            return False, 'the body must be a PEM certificate chain'
        if not self.installing.acquire(blocking=False):
            return False, 'another chain is being installed'
        leaf, rest, full, key = (STATE/n for n in ('app-leaf.pem', 'app-chain.pem', 'app-full.pem', 'app-key.pem'))
        try:
            leaf.write_bytes(certs[0]+b'\n')
            rest.write_bytes(b'\n'.join(certs[1:])+b'\n')
            try:
                if spki_of(certs[0]) != self.spki:
                    return False, 'the certificate is not for this key'
                openssl('verify', '-CAfile', CA_FILE, *(('-untrusted', str(rest)) if certs[1:] else ()),
                        '-purpose', 'sslserver', '-verify_hostname', self.app_name, str(leaf))
                end = openssl('x509', '-noout', '-enddate', '-dateopt', 'iso_8601', data=certs[0]).decode().strip()
                not_after = calendar.timegm(time.strptime(end.split('=', 1)[1], '%Y-%m-%d %H:%M:%SZ'))
            except (subprocess.SubprocessError, ValueError, IndexError):
                return False, 'the chain does not verify for '+self.app_name
            if not_after <= self.app_not_after:
                return True, self.app_not_after   # nothing newer than what is served
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.minimum_version = ssl.TLSVersion.TLSv1_2
            full.write_bytes(b'\n'.join(certs)+b'\n')
            fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                os.write(fd, self.key_pem)
                os.close(fd)
                ctx.load_cert_chain(full, key)
            finally:
                key.unlink()
            self.app, self.app_not_after = ctx, not_after
            stage('certificate', name=self.app_name, notAfter=not_after)
            return True, not_after
        finally:
            for f in (leaf, rest, full):
                f.unlink(missing_ok=True)
            self.installing.release()

    def health(self):
        """The sync summary, shared for HEALTH_TTL: the page polls it and so may anyone else."""
        with self.health_lock:
            if time.monotonic() - self.health_at > HEALTH_TTL or not self.health_doc:
                self.health_doc, self.health_at = json.dumps(health()).encode(), time.monotonic()
            return self.health_doc


def post(url, body, timeout=30):
    req = urllib.request.Request(url, data=body, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(16 << 20)


def health():
    out = {}
    for name in ('/l1', '/base'):
        try:
            rows = json.loads(post(UPSTREAM[name], json.dumps([
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


def journal(unit, lines):
    r = subprocess.run(['/usr/bin/journalctl', '-u', unit, '-n', str(lines), '-o', 'short-iso', '--no-pager'],
                       capture_output=True, timeout=15)
    return r.stdout[-(4 << 20):]


def allowed(call):
    return isinstance(call, dict) and isinstance(call.get('method'), str) and ALLOWED.match(call['method'])


def page():
    """The web page and its Content-Security-Policy: the page's own inline style and script by hash, nothing else."""
    html = PAGE.read_bytes()
    def hashes(tag):
        return ' '.join("'sha256-%s'" % base64.b64encode(hashlib.sha256(m).digest()).decode()
                        for m in re.findall(rb'<%s>(.*?)</%s>' % (tag, tag), html, re.S))
    csp = ("default-src 'none'; style-src %s; script-src %s; connect-src 'self'; img-src data:; base-uri 'none'; "
           "form-action 'none'; frame-ancestors 'none'" % (hashes(b'style'), hashes(b'script')))
    return html, csp


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    front = None
    html, csp = b'', ''
    timeout = 30  # also bounds the lazy TLS handshake, which runs in this thread

    def log_message(self, *args):
        pass

    def reply(self, code, body, kind='application/json', headers=()):
        self.send_response(code)
        self.send_header('content-type', kind)
        self.send_header('content-length', str(len(body)))
        # Everything here is public and read-only, and nothing is keyed to a cookie: any page may call it.
        self.send_header('access-control-allow-origin', '*')
        self.send_header('x-content-type-options', 'nosniff')
        for k, v in headers:
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def local(self):
        """Did this connection ask for the local name? Only the host side does: the app zone routes the app name alone."""
        return getattr(self.connection, 'enclave_sni', '') == LOCAL_NAME

    def do_GET(self):
        path, _, query = self.path.partition('?')
        f = self.front
        if path in ('/', '/index.html'):
            self.reply(200, self.html, 'text/html; charset=utf-8', (
                ('content-security-policy', self.csp), ('referrer-policy', 'no-referrer'), ('cache-control', 'no-cache')))
        elif path == '/.well-known/enclave-attestation' and not query:
            self.reply(200, f.boot_doc)
        elif path == '/.well-known/enclave-attestation':
            m = re.fullmatch(r'nonce=([0-9a-f]{64})', query)
            if not m:
                return self.reply(400, b'{"error":"nonce must be 64 lowercase hex characters"}')
            try:
                doc = f.fresh(m.group(1))
            except Exception:
                return self.reply(500, b'{"error":"the report request failed"}')
            if doc is None:
                return self.reply(500, b'{"error":"attestation busy; retry"}', headers=(('retry-after', '2'),))
            self.reply(200, doc, headers=(('cache-control', 'no-store'),))
        elif path == '/.well-known/enclave-ready':
            self.reply(200, b'{"ready":true}')
        elif path == '/.well-known/enclave-csr':
            if not f.csr:
                return self.reply(404, b'{"error":"this VM has no app name"}')
            self.reply(200, f.csr, 'application/pkcs10', (('x-enclave-app-name', f.app_name),))
        elif path == '/health':
            self.reply(200, f.health())
        elif path.startswith('/beacon/') and BEACON_PATH.match(path[len('/beacon'):]):
            # Read-only beacon API (blob sidecars, blocks, headers, sync, spec) for L1/Base data checks.
            try:
                with urllib.request.urlopen(BEACON+self.path[len('/beacon'):], timeout=30) as r:
                    self.reply(r.status, r.read(32 << 20), r.headers.get('content-type', 'application/json'))
            except urllib.error.HTTPError as e:
                self.reply(e.code, e.read(65536))
            except Exception:
                self.reply(502, b'{"error":"beacon unavailable"}')
        elif path in LOG_UNITS and self.local():
            # Read-only operator view, on the local name only: the app name is public and gets RPC, attestation, health.
            fields = dict(x.split('=', 1) for x in query.split('&') if '=' in x)
            lines = min(max(int(fields.get('lines', '200')) if fields.get('lines', '').isdigit() else 200, 1), 2000)
            self.reply(200, journal(LOG_UNITS[path], lines), 'text/plain; charset=utf-8')
        else:
            self.reply(404, b'{"error":"not found"}')

    do_HEAD = do_GET

    def do_OPTIONS(self):
        self.reply(204, b'', headers=(('access-control-allow-methods', 'GET, POST, OPTIONS'),
                                      ('access-control-allow-headers', 'content-type'), ('access-control-max-age', '86400')))

    def do_POST(self):
        length = int(self.headers.get('content-length') or 0)
        if self.path == '/.well-known/enclave-cert':
            if not 0 < length <= MAX_CHAIN:
                return self.reply(413, b'{"error":"unsupported"}')
            ok, detail = self.front.install(self.rfile.read(length))
            return self.reply(200 if ok else 422, json.dumps({'installed': ok, **({'notAfter': detail} if ok else {'error': detail})}).encode())
        upstream = UPSTREAM.get(self.path)
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

    def handle_error(self, request, client_address):
        # A peer that leaves mid-handshake or mid-request (a scanner, a browser refusing the boot certificate) is not news.
        if not isinstance(sys.exc_info()[1], (ssl.SSLError, OSError)):
            super().handle_error(request, client_address)


def stage(event, /, **fields):
    print(json.dumps({'event': 'front-'+event, **fields}), flush=True)


def serve(front, address):
    Handler.front = front
    Handler.html, Handler.csp = page()
    srv = Server(address, Handler)
    srv.socket = front.local.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
    return srv


def main():
    stage('starting')
    front = Front()
    stage('attested')
    srv = serve(front, ('0.0.0.0', int(sys.argv[1]) if len(sys.argv) > 1 else 8443))
    stage('ready', measurement=front.measurement, app=front.app_name)
    srv.serve_forever()


if __name__ == '__main__':
    main()
