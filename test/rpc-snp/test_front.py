"""rpc/snp/front.py: one attested key served under two names, a web page, and a certificate it only takes if it verifies.

python3 -m unittest test/rpc-snp/test_front.py
"""
import base64
import contextlib
import hashlib
import http.client
import http.server
import io
import json
from pathlib import Path
import re
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import front as F  # noqa: E402

DEP = '5ff56a4d600191f13ac43e1c600965673555f229472846a9da201785d396454f'
MEASUREMENT = bytes(range(48))
JOURNAL = F.journal
APP = '5ff56a4d.app.enclave.host'
REPORTS = []


def fake_report(report_data, host_data=bytes.fromhex(DEP)):
    REPORTS.append(report_data)
    r = bytearray(0x4a0)
    r[0x50:0x90], r[0x90:0xc0], r[0xc0:0xe0] = report_data, MEASUREMENT, host_data
    return bytes(r)


def ossl(*args, data=None):
    return subprocess.run([F.OPENSSL, *args], input=data, check=True, capture_output=True).stdout


class Node(http.server.BaseHTTPRequestHandler):
    """A stand-in execution node: a synced head for the health batch, and its method name for any other call."""
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['content-length'])))
        one = lambda c: {'jsonrpc': '2.0', 'id': c['id'], 'result': {
            'eth_syncing': False, 'eth_getBlockByNumber': {'number': '0x10', 'timestamp': '0x20'}}.get(c['method'], c['method'])}
        out = json.dumps([one(c) for c in body] if isinstance(body, list) else one(body)).encode()
        self.send_response(200)
        self.send_header('content-length', str(len(out)))
        self.end_headers()
        self.wfile.write(out)


@unittest.skipUnless(Path(F.OPENSSL).exists(), 'needs /usr/bin/openssl')
class FrontTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix='front-test-'))
        F.STATE = cls.dir/'state'
        F.tsm_report = fake_report
        # the real function, quietly: a stage whose fields the function cannot take must fail here as it would in the guest
        cls.stages, real = [], F.stage
        def stage(*a, **k):
            with contextlib.redirect_stdout(io.StringIO()) as out:
                real(*a, **k)
            cls.stages.append(json.loads(out.getvalue()))
        F.stage = stage
        F.journal = lambda unit, lines: ('%s %d' % (unit, lines)).encode()
        cls.node = http.server.HTTPServer(('127.0.0.1', 0), Node)
        threading.Thread(target=cls.node.serve_forever, daemon=True).start()
        F.UPSTREAM = {k: 'http://127.0.0.1:%d' % cls.node.server_port for k in F.UPSTREAM}
        # a test root, and an intermediate under it, standing in for the public CA
        (cls.dir/'ca.cnf').write_text('[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=Test Root\n'
                                      '[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n')
        for name in ('root', 'other'):
            ossl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '30',
                 '-config', str(cls.dir/'ca.cnf'), '-keyout', str(cls.dir/(name+'.key')), '-out', str(cls.dir/(name+'.pem')))
        ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN=Test Issuer',
             '-keyout', str(cls.dir/'mid.key'), '-out', str(cls.dir/'mid.csr'))
        (cls.dir/'mid.ext').write_text('basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n')
        ossl('x509', '-req', '-in', str(cls.dir/'mid.csr'), '-CA', str(cls.dir/'root.pem'), '-CAkey', str(cls.dir/'root.key'),
             '-CAcreateserial', '-days', '30', '-extfile', str(cls.dir/'mid.ext'), '-out', str(cls.dir/'mid.pem'))
        F.CA_FILE = str(cls.dir/'root.pem')
        cls.front = F.Front()
        cls.srv = F.serve(cls.front, ('127.0.0.1', 0))
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.node.shutdown()
        shutil.rmtree(cls.dir, ignore_errors=True)

    def connect(self, sni, ca=None):
        ctx = ssl.create_default_context(cafile=ca) if ca else ssl._create_unverified_context()
        raw = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        return ctx.wrap_socket(raw, server_hostname=sni)

    def call(self, method, path, body=None, sni=F.LOCAL_NAME, headers=None):
        with self.connect(sni) as s:
            c = http.client.HTTPConnection('127.0.0.1')
            c.sock = s
            c.request(method, path, body=body, headers=headers or {})
            r = c.getresponse()
            return r.status, dict((k.lower(), v) for k, v in r.getheaders()), r.read(), s.getpeercert(True)

    def issue(self, csr, ca='mid', days='30', name=APP):
        (self.dir/'leaf.csr').write_bytes(csr)
        (self.dir/'leaf.ext').write_text('subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n' % name)
        return ossl('x509', '-req', '-in', str(self.dir/'leaf.csr'), '-CA', str(self.dir/(ca+'.pem')),
                    '-CAkey', str(self.dir/(ca+'.key')), '-CAcreateserial', '-days', days, '-extfile', str(self.dir/'leaf.ext'))

    def test_1_boot_document_binds_the_served_key_and_no_key_file_remains(self):
        status, _, body, der = self.call('GET', '/.well-known/enclave-attestation')
        doc = json.loads(body)
        self.assertEqual(status, 200)
        spki = F.spki_of(ssl.DER_cert_to_PEM_cert(der).encode())
        self.assertEqual(spki, F.spki_of(doc['certificate'].encode()))
        report = base64.b64decode(doc['report'])
        self.assertEqual(report[0x50:0x90], hashlib.sha256(spki).digest() + bytes(32))
        self.assertEqual(doc['measurement'], MEASUREMENT.hex())
        self.assertEqual(self.front.app_name, APP)
        self.assertFalse(any('key' in p.name for p in F.STATE.iterdir()), 'the key lives in the process only')

    def test_2_fresh_report_binds_the_callers_nonce(self):
        nonce = 'ab' * 32
        status, headers, body, der = self.call('GET', '/.well-known/enclave-attestation?nonce='+nonce, sni=APP)
        doc = json.loads(body)
        spki = F.spki_of(ssl.DER_cert_to_PEM_cert(der).encode())
        self.assertEqual((status, doc['format'], doc['nonce'], doc['hostData']), (200, 'sev-snp-vm-v1', nonce, DEP))
        self.assertEqual(base64.b64decode(doc['transportKey']), spki)
        self.assertEqual(base64.b64decode(doc['report'])[0x50:0x70], hashlib.sha256(spki + bytes.fromhex(nonce)).digest())
        self.assertEqual(self.call('GET', '/.well-known/enclave-attestation?nonce=AB')[0], 400)
        self.assertEqual(self.call('GET', '/.well-known/enclave-ready')[2], b'{"ready":true}')

    def test_3_a_saturated_report_queue_answers_busy_in_the_words_the_probe_waits_out(self):
        held = [self.front.waiters.acquire(blocking=False) for _ in range(F.FRESH_WAITERS)]
        try:
            status, _, body, _ = self.call('GET', '/.well-known/enclave-attestation?nonce=' + 'cd' * 32)
        finally:
            for _ in held:
                self.front.waiters.release()
        self.assertEqual(status, 500)
        self.assertRegex(body.decode(), r'attestation busy; retry')

    def test_4_request_is_exactly_what_the_certificate_service_accepts(self):
        status, headers, csr, _ = self.call('GET', '/.well-known/enclave-csr')
        self.assertEqual((status, headers['x-enclave-app-name']), (200, APP))
        text = ossl('req', '-noout', '-text', '-verify', data=csr).decode()
        self.assertRegex(text, r'Subject: CN ?= ?' + re.escape(APP))
        self.assertRegex(text, r'Subject Alternative Name: *\n\s+DNS:' + re.escape(APP) + r'\n')
        self.assertEqual(ossl('pkey', '-pubin', '-outform', 'DER', data=ossl('req', '-noout', '-pubkey', data=csr)), self.front.spki)
        node = shutil.which('node')
        if node:   # the relay's own strict parser, when this checkout can run it
            js = ("import('%s').then(m=>{let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const c=m.parseCsr(s,'%s');"
                  "console.log(c.spkiHash,c.keyType)})})" % (ROOT/'relay/certs.js', APP))
            out = subprocess.run([node, '-e', js], input=csr, capture_output=True, check=True, timeout=60).stdout.decode().split()
            self.assertEqual(out[0], hashlib.sha256(self.front.spki).hexdigest())

    def test_5_only_a_chain_that_verifies_for_this_key_and_name_is_served(self):
        csr = self.front.csr
        post = lambda pem: self.call('POST', '/.well-known/enclave-cert', body=pem, sni=APP)
        mid = (self.dir/'mid.pem').read_bytes()
        # before any chain: the app name still gets the boot certificate
        with self.connect(APP) as s:
            self.assertEqual(F.spki_of(ssl.DER_cert_to_PEM_cert(s.getpeercert(True)).encode()), self.front.spki)
        with self.assertRaises(ssl.SSLCertVerificationError):
            self.connect(APP, ca=str(self.dir/'root.pem'))
        # refused: not a chain, an untrusted issuer, another name, another key
        self.assertEqual(post(b'hello')[0], 422)
        self.assertEqual(post(self.issue(csr, ca='other'))[0], 422)
        self.assertEqual(post(self.issue(csr, name='deadbeef.app.enclave.host') + mid)[0], 422)
        ossl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-subj', '/CN='+APP,
             '-keyout', str(self.dir/'x.key'), '-out', str(self.dir/'x.csr'))
        status, _, body, _ = post(self.issue((self.dir/'x.csr').read_bytes()) + mid)
        self.assertEqual((status, json.loads(body)['error']), (422, 'the certificate is not for this key'))
        self.assertIsNone(self.front.app)
        # accepted: leaf + intermediate under the trusted root
        status, _, body, _ = post(self.issue(csr) + mid)
        self.assertEqual((status, json.loads(body)['installed']), (200, True))
        self.assertIn({'event': 'front-certificate', 'name': APP, 'notAfter': self.front.app_not_after}, self.stages)
        with self.connect(APP, ca=str(self.dir/'root.pem')) as s:   # full WebPKI-style validation, name included
            self.assertEqual(F.spki_of(ssl.DER_cert_to_PEM_cert(s.getpeercert(True)).encode()), self.front.spki)
        # the local name is still the boot certificate, on the same key
        doc = json.loads(self.call('GET', '/.well-known/enclave-attestation')[2])
        with self.connect(F.LOCAL_NAME) as s:
            self.assertEqual(ssl.DER_cert_to_PEM_cert(s.getpeercert(True)).strip(), doc['certificate'].strip())
        # an older chain does not replace a newer one
        not_after = self.front.app_not_after
        self.assertEqual(json.loads(post(self.issue(csr, days='5') + mid)[2])['notAfter'], not_after)
        self.assertFalse(any('key' in p.name for p in F.STATE.iterdir()))

    def test_6_page_headers_cors_and_logs(self):
        status, headers, body, _ = self.call('GET', '/', sni=APP)
        self.assertEqual((status, headers['content-type']), (200, 'text/html; charset=utf-8'))
        self.assertIn(b'<title>Enclave RPC</title>', body)
        for tag in (b'style', b'script'):
            inline = re.findall(rb'<%s>(.*?)</%s>' % (tag, tag), body, re.S)
            self.assertEqual(len(inline), 1)
            self.assertIn("'sha256-%s'" % base64.b64encode(hashlib.sha256(inline[0]).digest()).decode(), headers['content-security-policy'])
        self.assertIn("default-src 'none'", headers['content-security-policy'])
        self.assertNotIn(b'innerHTML', body)
        status, headers, body, _ = self.call('HEAD', '/')
        self.assertEqual((status, body), (200, b''))
        status, headers, body, _ = self.call('OPTIONS', '/base')
        self.assertEqual((status, headers['access-control-allow-origin']), (204, '*'))
        # logs: the local name only
        self.assertEqual(self.call('GET', '/logs/el?lines=7')[2], b'enclave-rpc-el.service 7')
        self.assertEqual(self.call('GET', '/logs/el', sni=APP)[0], 404)
        self.assertEqual(self.call('GET', '/logs/el', sni=None)[0], 404)

    def test_7_rpc_proxy_and_method_allowlist(self):
        rpc = lambda path, method: self.call('POST', path, body=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method}), sni=APP)
        for path in ('/l1', '/ethereum', '/base'):
            status, headers, body, _ = rpc(path, 'eth_blockNumber')
            self.assertEqual((status, json.loads(body)['result'], headers['access-control-allow-origin']), (200, 'eth_blockNumber', '*'))
        self.assertEqual(rpc('/base', 'eth_sendTransaction')[0], 403)
        self.assertEqual(rpc('/base', 'admin_peers')[0], 403)
        self.assertEqual(rpc('/nope', 'eth_blockNumber')[0], 404)
        health = json.loads(self.call('GET', '/health', sni=APP)[2])
        self.assertEqual(sorted(health), ['base', 'beacon', 'l1'])
        self.assertEqual(health['l1'], {'syncing': False, 'head': 16, 'headTimestamp': 32})

    def test_8_a_vm_launched_for_no_deployment_has_no_app_name(self):
        F.tsm_report = lambda rd: fake_report(rd, bytes(32))
        F.STATE = self.dir/'state-zero'
        try:
            f = F.Front()
        finally:
            F.tsm_report, F.STATE = fake_report, self.dir/'state'
        self.assertEqual((f.app_name, f.csr), ('', b''))
        self.assertEqual(f.install(b'x')[0], False)

    def test_9_memory_is_the_guests_own_account_on_the_local_name_only(self):
        proc, groups, logs = self.dir/'proc', self.dir/'cgroup', self.dir/'log'
        clients = groups/'enclave.slice/enclave-rpc.slice/enclave-rpc-clients.slice'
        self.assertEqual(F.cgroup_dir('enclave-rpc-clients.slice/enclave-rpc-base.service').relative_to(F.CGROUPS),
                         Path('enclave.slice/enclave-rpc.slice/enclave-rpc-clients.slice/enclave-rpc-base.service'))
        self.assertEqual(F.cgroup_dir('system.slice/enclave-rpc-front.service').relative_to(F.CGROUPS),
                         Path('system.slice/enclave-rpc-front.service'))
        (proc/'pressure').mkdir(parents=True)
        (proc/'meminfo').write_text('MemTotal:       65829000 kB\nMemFree:          412000 kB\nMemAvailable:   30100200 kB\n'
                                    'Shmem:           2400000 kB\nHugePages_Total:       0\nVmallocUsed:      50000 kB\n')
        (proc/'pressure/memory').write_text('some avg10=0.00 avg60=0.12 avg300=0.05 total=123456\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=99\n')
        for d, current, high in ((clients, 60 << 30, 59392 << 20), (clients/'enclave-rpc-base.service', 31 << 30, 'max')):
            d.mkdir(parents=True)
            (d/'memory.current').write_text('%d\n' % current)
            (d/'memory.peak').write_text('%d\n' % (current + 5))
            (d/'memory.high').write_text('%s\n' % high)
            (d/'memory.max').write_text('max\n')
            (d/'memory.stat').write_text('anon 100\nfile 200\nunlisted 7\nworkingset_refault_file 3\n')
            (d/'memory.events').write_text('low 0\nhigh 12\nmax 0\noom 0\noom_kill 0\n')
            (d/'memory.pressure').write_text('some avg10=1.50 avg60=0.40 avg300=0.10 total=5\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=1\n')
        (logs/'journal/abc').mkdir(parents=True)
        (logs/'journal/abc/system.journal').write_bytes(b'j' * 8192)
        (logs/'syslog').write_bytes(b's' * 4096)
        (self.dir/'probe.json').write_text(json.dumps({'phase': 'measuring', 'asked': 3}))
        old = F.PROC, F.CGROUPS, F.RAM_MOUNTS, F.RAM_TREES, F.PROBE_STATE
        F.PROC, F.CGROUPS, F.RAM_MOUNTS, F.RAM_TREES, F.PROBE_STATE = proc, groups, (str(self.dir),), (str(logs), str(logs/'journal'), str(logs/'none')), self.dir/'probe.json'
        try:
            status, headers, body, _ = self.call('GET', '/memory')
            self.assertEqual((status, headers['content-type'], headers['cache-control']), (200, 'application/json', 'no-store'))
            m = json.loads(body)
            self.assertEqual(m['meminfo'], {'MemTotal': 65829000 << 10, 'MemFree': 412000 << 10, 'MemAvailable': 30100200 << 10, 'Shmem': 2400000 << 10})
            self.assertEqual(m['pressure']['some'], {'avg10': 0.0, 'avg60': 0.12, 'avg300': 0.05, 'total': 123456.0})
            self.assertEqual(sorted(m['groups']), ['base', 'clients'])       # a unit that is not running is left out
            self.assertEqual(m['groups']['clients'], {
                'current': 60 << 30, 'peak': (60 << 30) + 5, 'high': 59392 << 20, 'max': None,
                'stat': {'anon': 100, 'file': 200, 'workingset_refault_file': 3},
                'events': {'low': 0, 'high': 12, 'max': 0, 'oom': 0, 'oom_kill': 0},
                'pressure': {'some': {'avg10': 1.5, 'avg60': 0.4, 'avg300': 0.1, 'total': 5.0}, 'full': {'avg10': 0.0, 'avg60': 0.0, 'avg300': 0.0, 'total': 1.0}}})
            self.assertIsNone(m['groups']['base']['high'])
            self.assertGreater(m['mounts'][str(self.dir)]['size'], m['mounts'][str(self.dir)]['used'])
            self.assertEqual(m['trees'][str(logs/'none')], None)
            self.assertGreaterEqual(m['trees'][str(logs/'journal')], 8192)
            self.assertGreaterEqual(m['trees'][str(logs)], m['trees'][str(logs/'journal')] + 4096)
            self.assertEqual(m['probe'], {'phase': 'measuring', 'asked': 3})
            # the app name is public: it gets no view of the guest's internals
            self.assertEqual(self.call('GET', '/memory', sni=APP)[0], 404)
            self.assertEqual(self.call('GET', '/memory', sni=None)[0], 404)
            # a guest without the probe, the cgroups or PSI still answers
            F.PROC, F.CGROUPS, F.PROBE_STATE = self.dir/'no-proc', self.dir/'no-cgroup', self.dir/'no-probe'
            m = json.loads(self.call('GET', '/memory')[2])
            self.assertEqual((m['meminfo'], m['pressure'], m['groups'], m['probe']), ({}, None, {}, None))
        finally:
            F.PROC, F.CGROUPS, F.RAM_MOUNTS, F.RAM_TREES, F.PROBE_STATE = old

    def test_10_the_log_tail_reads_every_journal_namespace(self):
        seen, real = [], F.subprocess.run
        F.subprocess.run = lambda argv, **k: seen.append(argv) or subprocess.CompletedProcess(argv, 0, b'x' * (5 << 20), b'')
        try:
            out = JOURNAL('enclave-rpc-base.service', 9)
        finally:
            F.subprocess.run = real
        self.assertEqual(seen, [['/usr/bin/journalctl', '--namespace=*', '-u', 'enclave-rpc-base.service', '-n', '9', '-o', 'short-iso', '--no-pager']])
        self.assertEqual(len(out), 4 << 20)


if __name__ == '__main__':
    unittest.main()
