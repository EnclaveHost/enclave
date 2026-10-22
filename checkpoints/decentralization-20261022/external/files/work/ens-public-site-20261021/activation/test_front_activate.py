#!/usr/bin/env python3
"""Unit tests for front-activate.py's STRUCTURAL steps, with a REAL Caddy (work/custody-caddy, v2.11.x) on a synthetic
Caddyfile shaped like the fronts' enclave-bootstrap-tls config (preflight struct: an https `ipfs.enclave.host {` block with
named pin routes, many path handles, `handle /site-root`, a named @uploads route, ONE generic `handle /ipfs/* {` with a
nested handle_response fallback, a catch-all `handle`; plus a plain-http redirect block for the same name). Covered:
the insertion point, the compiled route-order proof, and every ambiguity refusal. The extractor (worker 6b's tests) and the
live health checks against the fronts are out of scope here. class H2 runs the candidate in a REAL local Caddy (127.0.0.1, a
free port, tls internal) and drives front-activate.py's own http() at it over HTTP/2: the HEAD/GET measurement health()
relies on (root review: curl -I writes the response headers into an -o body file)."""
import base64, hashlib, importlib.util, json, os, shutil, socket, subprocess, sys, tempfile, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
LOCAL_CADDY = os.path.abspath(os.path.join(HERE, '../../custody-caddy/caddy'))
ROOT = 'bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou'
SNIPPET_MARKER = '# --- trustless-gateway block serving for published sites'

def load(tmp):
    for f in os.listdir(os.path.join(HERE, 'stage')): shutil.copy(os.path.join(HERE, 'stage', f), tmp)
    pins = json.load(open(os.path.join(tmp, 'pins.json')))
    pins['hosts'][socket.gethostname()] = pins['hosts']['us-west']          # the test machine stands in for a front
    json.dump(pins, open(os.path.join(tmp, 'pins.json'), 'w'))
    spec = importlib.util.spec_from_file_location('fa', os.path.join(tmp, 'front-activate.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    m.CADDY = LOCAL_CADDY
    return m

def caddyfile(tmp, extra_https='', generic=1, https_blocks=1, named_after_generic=False):
    pins = '\n'.join(f'''\thandle /ipfs/bafybeiaa{n:050d}aaa {{\n\t\tredir /ipfs/bafybeiaa{n:050d}aaa/ permanent\n\t}}\n\thandle_path /ipfs/bafybeiaa{n:050d}aaa/* {{\n\t\troot * /opt/enclave-site/x{n}/site\n\t\tfile_server\n\t}}''' for n in range(40))
    gen = '\n'.join('''\thandle /ipfs/* {\n\t\treverse_proxy 127.0.0.1:8189 {\n\t\t\t@missing status 403 404 500 502 503 504\n\t\t\thandle_response @missing {\n\t\t\t\treverse_proxy 127.0.0.1:9 \n\t\t\t}\n\t\t}\n\t}''' for _ in range(generic))
    late = '\t@late path_regexp ^/ipfs/baf[ky][a-z2-7]{55}$\n\thandle @late {\n\t\trespond 204\n\t}' if named_after_generic else ''
    https = f'''ipfs.enclave.host {{
\tbind 127.0.0.1
\ttls internal
\theader {{
\t\tAccess-Control-Allow-Origin *
\t}}
\t@pinRaw {{
\t\tpath /ipfs/{ROOT}
\t\tquery format=raw
\t}}
\thandle @pinRaw {{
\t\troot * /opt/enclave-site/{ROOT}
\t\trewrite * /site-root.block
\t\tfile_server
\t}}
{pins}
\thandle /site-root {{
\t\trespond "x"
\t}}
\t@uploads path /add-wasm /add-json /healthz
\thandle @uploads {{
\t\trespond 200
\t}}
{extra_https}
{gen}
{late}
\thandle {{
\t\trespond 404
\t}}
}}
'''
    text = f'''{{
\tadmin off
\tauto_https disable_redirects
\tskip_install_trust
\tstorage file_system {tmp}/caddy-data
}}
enclave.host {{
\tbind 127.0.0.1
\ttls internal
\trespond "apex"
}}
{https * https_blocks}http://enclave.host, http://www.enclave.host, http://ipfs.enclave.host {{
\tbind 127.0.0.1
\tredir https://{{host}}{{uri}} permanent
}}
'''
    return text

class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(dir=os.path.join(HERE)); self.m = load(self.tmp)
    def tearDown(self): shutil.rmtree(self.tmp, ignore_errors=True)
    def write(self, text):
        p = os.path.join(self.tmp, 'Caddyfile.candidate'); open(p, 'w').write(text); return p

    def test_inserted_exactly_before_the_generic_handle_and_compiled_first(self):
        base = caddyfile(self.tmp)
        cand = self.m.candidate(base)
        lines = cand.split('\n')
        marker = next(i for i, l in enumerate(lines) if SNIPPET_MARKER in l)
        generic = next(i for i, l in enumerate(lines) if l.strip() == 'handle /ipfs/* {')
        self.assertLess(marker, generic)
        self.assertEqual(cand.replace(open(os.path.join(self.tmp, 'snippet.caddy')).read().rstrip('\n') + '\n', ''), base, 'only the snippet was added')
        order = self.m.validate_and_order(self.write(cand))
        kinds = dict((k, i) for k, i in order if k != 'siteBlock')
        self.assertTrue(all(i < kinds['generic'] for k, i in order if k != 'generic'), order)

    def test_the_order_proof_refuses_a_shadowed_snippet(self):
        # the base as it would compile if the snippet's routes sat AFTER the generic one: the proof must refuse
        base = caddyfile(self.tmp)
        snippet = open(os.path.join(self.tmp, 'snippet.caddy')).read()
        moved = base.replace('\thandle {\n\t\trespond 404\n\t}', snippet + '\n\thandle {\n\t\trespond 404\n\t}', 1)
        self.assertIn(SNIPPET_MARKER, moved)
        with self.assertRaisesRegex(self.m.Refused, 'NOT before the generic'):
            self.m.validate_and_order(self.write(moved))

    def test_ambiguity_refuses(self):
        for kw, why in [({'generic': 2}, 'exactly one depth-1'), ({'generic': 0}, 'exactly one depth-1'), ({'https_blocks': 2}, 'exactly one https')]:
            with self.assertRaisesRegex(self.m.Refused, why, msg=str(kw)):
                self.m.candidate(caddyfile(self.tmp, **kw))
        with self.assertRaisesRegex(self.m.Refused, 'already inside'):
            self.m.candidate(caddyfile(self.tmp, extra_https='\t' + SNIPPET_MARKER))
        with self.assertRaisesRegex(self.m.Refused, 'do not balance'):
            self.m.candidate(caddyfile(self.tmp) + '\nfoo {\n')

    def test_an_invalid_candidate_is_refused_by_caddy_validate(self):
        with self.assertRaisesRegex(self.m.Refused, 'caddy validate failed'):
            self.m.validate_and_order(self.write(caddyfile(self.tmp).replace('respond 404', 'respond_wrong 404')))

    def test_pins_and_staged_bytes(self):
        self.m.staged_ok()
        p = json.load(open(os.path.join(self.tmp, 'pins.json')))
        self.assertEqual(p['blocks'], 487); self.assertEqual(p['root'], ROOT)
        self.assertEqual(set(p['hosts']) - {socket.gethostname()}, {'us-west', 'ca-east', 'ap-southeast', 'eu-central'})
        open(os.path.join(self.tmp, 'snippet.caddy'), 'a').write('# changed\n')
        with self.assertRaisesRegex(self.m.Refused, 'staged snippet.caddy is not the pinned'):
            self.m.staged_ok()

def free_port():
    with socket.socket() as k: k.bind(('127.0.0.1', 0)); return k.getsockname()[1]

def raw_cid(data):  # CIDv1, raw codec, sha2-256, base32 multibase: the form the snippet's regex admits
    return 'b' + base64.b32encode(bytes([1, 0x55, 0x12, 0x20]) + hashlib.sha256(data).digest()).decode().lower().rstrip('=')

class H2(unittest.TestCase):
    """The candidate (synthetic base + the staged snippet, its block root pointed at a temp dir) served by a real Caddy."""
    BLOCK = b'enclave block bytes\n' * 100
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(dir=HERE); cls.m = m = load(cls.tmp)
        cls.blocks = os.path.join(cls.tmp, 'blocks'); os.makedirs(os.path.join(cls.blocks, 'ipfs'))
        cls.cid = raw_cid(cls.BLOCK); open(os.path.join(cls.blocks, 'ipfs', cls.cid), 'wb').write(cls.BLOCK)
        text = m.candidate(caddyfile(cls.tmp)).replace('/opt/enclave-site-blocks', cls.blocks)
        cls.port = free_port()
        text = text.replace('\tadmin off\n', f'\tadmin off\n\thttps_port {cls.port}\n\thttp_port {free_port()}\n', 1)
        cf = os.path.join(cls.tmp, 'Caddyfile.h2'); open(cf, 'w').write(text)
        env = dict(os.environ, HOME=cls.tmp, XDG_CONFIG_HOME=os.path.join(cls.tmp, 'cfg'), XDG_DATA_HOME=os.path.join(cls.tmp, 'data'))
        cls.log = open(os.path.join(cls.tmp, 'caddy.log'), 'w')
        cls.caddy = subprocess.Popen([LOCAL_CADDY, 'run', '--config', cf, '--adapter', 'caddyfile'], env=env, stdout=cls.log, stderr=cls.log)
        cls.ca = os.path.join(cls.tmp, 'caddy-data', 'pki', 'authorities', 'local', 'root.crt')
        m.H = {'publicIp': '127.0.0.1'}; m.HTTPS_PORT = cls.port; m.CURL_TLS = ['--cacert', cls.ca]
        for _ in range(100):
            if cls.caddy.poll() is not None: raise RuntimeError('caddy exited: ' + open(cls.log.name).read()[-2000:])
            if os.path.exists(cls.ca) and m.http('/site-root')['status'] == 200: break
            time.sleep(0.2)
        else: raise RuntimeError('caddy did not serve: ' + open(cls.log.name).read()[-2000:])
    @classmethod
    def tearDownClass(cls):
        cls.caddy.terminate(); cls.caddy.wait(10); cls.log.close(); shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_root_review_curl_I_with_o_writes_headers_into_the_body_file(self):
        # the defect root found in the previous http(): -I plus -o <file> -> the file holds the response headers
        with tempfile.NamedTemporaryFile() as body:
            subprocess.run(['curl', '-sS', '--http2', '-I', '--cacert', self.ca, '--resolve', f'ipfs.enclave.host:{self.port}:127.0.0.1', '-o', body.name,
                            '-H', 'Accept: application/vnd.ipld.raw', f'https://ipfs.enclave.host:{self.port}/ipfs/bafkqaaa?format=raw'], check=True)
            got = open(body.name, 'rb').read()
        self.assertTrue(got.startswith(b'HTTP/2 200'), got[:80])

    def test_the_boxo_probe_head_and_get_measure_200_http2_empty_raw(self):
        for meth in ('HEAD', 'GET'):
            r = self.m.http('/ipfs/bafkqaaa?format=raw', meth, 'application/vnd.ipld.raw')
            self.assertEqual((r['status'], r['http'], r['bytes'], r['ctype']), (200, '2', 0, 'application/vnd.ipld.raw'), (meth, r))
            self.assertIn(r['contentLength'], ('0', ''), (meth, r))
            self.assertEqual(r['sha256'], hashlib.sha256(b'').hexdigest())

    def test_a_site_block_by_format_and_by_accept_and_its_head(self):
        want = hashlib.sha256(self.BLOCK).hexdigest()
        for path, acc in ((f'/ipfs/{self.cid}?format=raw', 'application/vnd.ipld.raw'), (f'/ipfs/{self.cid}', 'application/vnd.ipld.raw')):
            r = self.m.http(path, 'GET', acc)
            self.assertEqual((r['status'], r['http'], r['bytes'], r['sha256'], r['ctype']), (200, '2', len(self.BLOCK), want, 'application/vnd.ipld.raw'), (path, r))
        r = self.m.http(f'/ipfs/{self.cid}?format=raw', 'HEAD', 'application/vnd.ipld.raw')
        self.assertEqual((r['status'], r['http'], r['bytes'], r['contentLength']), (200, '2', 0, str(len(self.BLOCK))), r)

    def test_an_absent_block_still_goes_to_the_generic_route(self):
        # the generic /ipfs/* upstream (127.0.0.1:8189) is not running here: Caddy's 502 proves the request reached it
        r = self.m.http(f"/ipfs/{raw_cid(b'not here')}?format=raw", 'GET', 'application/vnd.ipld.raw')
        self.assertEqual((r['status'], r['http']), (502, '2'), r)

if __name__ == '__main__':
    unittest.main(verbosity=2)
