"""witness-rpc-access-stage/r2: OFFLINE tests (no node; the namespace loopback only; root runs them via jobs/).
Behavioural: the REAL r2 bridge on an ephemeral loopback port, raw client sockets, and a FAKE node IPC unix socket that records what
reaches it and can answer large, trickling, early-closing or trailing-garbage responses; the REAL original/patched wrapper _start()."""
import hashlib, importlib.util, json, os, pathlib, shutil, socket, tempfile, threading, time, tracemalloc, unittest
from unittest.mock import patch

S = pathlib.Path(__file__).resolve().parents[1]; P = S.parents[1]
ORIG = P / 'base-finality-proof-stage/r13-manifest-final/wrapper/chain_service.py'; NEW = S / 'overlay/wrapper/chain_service.py'


def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


BR = load('witness_rpc_bridge_r2', S / 'bridge/witness_rpc_bridge.py')


class FakeNode:
    def __init__(self, path, reply=b'{"jsonrpc":"2.0","id":1,"result":"0x1"}', chunk=65536, mode=0o600, close_early=False, trickle=False):
        self.path, self.reply, self.chunk, self.close_early, self.trickle, self.seen = str(path), reply, chunk, close_early, trickle, []
        self.s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); self.s.bind(self.path); os.chmod(self.path, mode); self.s.listen(8)
        threading.Thread(target=self.loop, daemon=True).start()

    def loop(self):
        while True:
            try:
                c, _ = self.s.accept()
            except OSError:
                return
            threading.Thread(target=self.one, args=(c,), daemon=True).start()

    def one(self, c):
        buf = b''
        while not buf.endswith(b'\n'):
            d = c.recv(65536)
            if not d:
                break
            buf += d
        self.seen.append(json.loads(buf))
        try:
            if self.trickle:                                   # one byte every 0.1 s, never completing
                c.sendall(b'{"jsonrpc":"2.0","id":1,"result":"')
                for _ in range(600):
                    c.sendall(b'a'); time.sleep(0.1)
            elif not self.close_early:
                for i in range(0, len(self.reply), self.chunk):
                    c.sendall(self.reply[i:i + self.chunk])
        except OSError:
            pass
        c.close()


class Bridge(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='wb-', dir='/tmp')); self.addCleanup(shutil.rmtree, self.t, True)   # AF_UNIX <= 107 bytes
        self.ipc = self.t / 'el.ipc'

    def start(self, profile='base-el', ipc=None, **lim):
        b = BR.Bridge({**BR.PROFILES[profile], 'listen': ('127.0.0.1', 0)}, ipc=str(ipc or self.ipc), limits=lim)
        threading.Thread(target=b.serve_forever, daemon=True).start(); self.addCleanup(b.shutdown); self.port = b.address[1]; return b

    def http(self, raw, digest=False, timeout=30):
        """send raw bytes; read until the bridge closes; -> (status, body or (len, sha256))"""
        c = socket.create_connection(('127.0.0.1', self.port), timeout=timeout)
        if raw:
            c.sendall(raw)
        buf, h, n = b'', hashlib.sha256(), 0
        while b'\r\n\r\n' not in buf:
            d = c.recv(65536)
            if not d:
                break
            buf += d
        head, _, rest = buf.partition(b'\r\n\r\n')
        status = int(head.split(b' ')[1]) if head else None
        body = bytearray(rest) if not digest else None
        if digest:
            h.update(rest); n = len(rest)
        while True:
            try:
                d = c.recv(65536)
            except (ConnectionResetError, socket.timeout):
                break
            if not d:
                break
            if digest:
                h.update(d); n += len(d)
            else:
                body += d
        c.close()
        return status, ((n, h.hexdigest()) if digest else bytes(body))

    def post(self, obj, **kw):
        b = json.dumps(obj).encode()
        return self.http(b'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(b) + b, **kw)

    rq = staticmethod(lambda m, i=1, p=None: {'jsonrpc': '2.0', 'id': i, 'method': m, 'params': p or []})

    def test_profiles_are_exactly_the_witness_read_set(self):
        self.assertEqual(set(BR.PROFILES['base-el']['methods']), {'eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
                                                                  'eth_getProof', 'debug_executePayload', 'debug_getRawHeader', 'debug_dbGet'})
        self.assertEqual(set(BR.PROFILES['l1-el']['methods']), {'eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
                                                                'debug_getRawHeader', 'debug_getRawReceipts'})
        for p in BR.PROFILES.values():
            self.assertIn(p['listen'][0], ('127.0.0.1', '::1')); self.assertLess(len(p['ipc'].encode()), 108)
            self.assertFalse([m for m in p['methods'] if m.startswith(('admin_', 'txpool_', 'miner_', 'personal_', 'eth_send', 'debug_trace', 'debug_set', 'debug_clear'))])

    def test_permitted_requests_are_streamed_exactly_with_bounded_memory(self):
        value = json.dumps({'jsonrpc': '2.0', 'id': 7, 'result': {'s': ['{"x":"]\\"}' + 'ab' * 300] * 33000}}).encode()   # ~20 MB, braces in strings
        node = FakeNode(self.ipc, reply=value + b'\n{"trailing":"ignored"}', chunk=4096); self.start()
        tracemalloc.start()
        try:
            st, (n, h) = self.post(self.rq('debug_executePayload', 7, ['0x' + '11' * 32, {}]), digest=True)
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual((st, n, h), (200, len(value), hashlib.sha256(value).hexdigest()), 'exactly the first JSON value, streamed')
        self.assertLess(peak, 4 << 20, f'relay of {len(value)} bytes peaked at {peak} traced bytes: not O(response)')
        self.assertEqual(node.seen[0]['method'], 'debug_executePayload')
        node.reply = b'[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"result":"0x2"}]'
        st, body = self.post([self.rq('eth_chainId', 1), self.rq('debug_getRawHeader', 2, ['0x1'])]); self.assertEqual((st, len(json.loads(body))), (200, 2))

    def test_oversized_response_is_cut_not_buffered(self):
        FakeNode(self.ipc, reply=json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': 'z' * (3 << 20)}).encode()); b = self.start(max_response=1 << 20)
        st, body = self.post(self.rq('eth_getBlockByNumber', 1, ['0x1', True]))
        self.assertEqual(st, 200); self.assertLessEqual(len(body), 1 << 20)
        with self.assertRaises(ValueError):
            json.loads(body)                                                  # truncated: the client can never take it as a result
        self.assertEqual(b.stats['cut'], 1)

    def test_trickling_node_hits_the_absolute_request_deadline(self):
        FakeNode(self.ipc, trickle=True); b = self.start(request_deadline=1.0)
        t0 = time.monotonic(); st, body = self.post(self.rq('debug_executePayload')); dt = time.monotonic() - t0
        self.assertLess(dt, 3.0, f'not cut at the absolute deadline ({dt:.1f} s)'); self.assertGreaterEqual(dt, 0.9)
        with self.assertRaises(ValueError):
            json.loads(body)
        self.assertEqual(b.stats['cut'], 1)

    def test_slow_client_is_cut_at_the_header_deadline_and_admission_is_bounded(self):
        node = FakeNode(self.ipc); b = self.start(max_conn=1, header_deadline=1.0)
        slow = socket.create_connection(('127.0.0.1', self.port), timeout=10); slow.sendall(b'POST / HTTP/1.1\r\nHost: x\r\n')   # never finishes
        time.sleep(0.2)
        t0 = time.monotonic(); st, _ = self.http(b''); self.assertEqual(st, 503); self.assertLess(time.monotonic() - t0, 0.8, 'refused before reading')
        r = slow.recv(4096); slow.close(); self.assertIn(b' 408 ', r.split(b'\r\n')[0] + b' ')
        time.sleep(0.1); st, body = self.post(self.rq('eth_chainId')); self.assertEqual(st, 200)
        self.assertEqual([x['method'] for x in node.seen], ['eth_chainId']); self.assertGreaterEqual(b.stats['busy'], 1)

    def test_malformed_and_oversized_lengths_never_reach_the_node(self):
        node = FakeNode(self.ipc); self.start()
        body = json.dumps(self.rq('eth_chainId')).encode()
        cases = [(b'Content-Length: abc\r\n', 400), (b'Content-Length: -5\r\n', 400), (b'Content-Length: 1e3\r\n', 400), (b'Content-Length: \xd9\xa1\r\n', 400),
                 (b'Content-Length: 5\r\nContent-Length: 5\r\n', 411), (b'', 411), (b'Transfer-Encoding: chunked\r\nContent-Length: 5\r\n', 411),
                 (b'Content-Length: %d\r\n' % ((1 << 20) + 1), 413), (b'X-Big: ' + b'a' * 9000 + b'\r\nContent-Length: 5\r\n', 431), (b'Broken header line\r\n', 400)]
        for hdr, code in cases:
            with self.subTest(hdr=hdr[:40]):
                self.assertEqual(self.http(b'POST / HTTP/1.1\r\nHost: x\r\n' + hdr + b'\r\n' + body)[0], code)
        self.assertEqual(self.http(b'GET / HTTP/1.1\r\nHost: x\r\n\r\n')[0], 405)
        self.assertEqual(self.http(b'BROKEN\r\n\r\n')[0], 400)
        self.assertEqual(node.seen, [])

    def test_refused_methods_and_malformed_json_never_reach_the_node(self):
        node = FakeNode(self.ipc); self.start('base-el')
        for m in ('debug_clearTxpool', 'admin_addPeer', 'debug_traceCall', 'eth_sendRawTransaction', 'txpool_content', 'debug_getRawReceipts', 'optimism_outputAtBlock'):
            with self.subTest(m=m):
                st, b = self.post(self.rq(m)); self.assertEqual((st, json.loads(b)['error']['code']), (200, -32601))
        for bad, code in (([self.rq('eth_chainId', 1), self.rq('admin_peers', 2)], -32601), ([self.rq('eth_chainId', i) for i in range(33)], -32600), ([], -32600)):
            self.assertEqual(json.loads(self.post(bad)[1])['error']['code'], code)
        raw = b'{not json'; st, b = self.http(b'POST / HTTP/1.1\r\nContent-Length: %d\r\n\r\n' % len(raw) + raw); self.assertEqual(json.loads(b)['error']['code'], -32700)
        self.start('l1-el'); self.assertEqual(json.loads(self.post(self.rq('debug_executePayload'))[1])['error']['code'], -32601)
        self.assertEqual(node.seen, [])

    def test_ipc_guards_fail_closed(self):
        self.start()
        self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)
        node = FakeNode(self.ipc, mode=0o666); self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502); self.assertEqual(node.seen, [])
        os.chmod(self.ipc, 0o600); node.close_early = True; self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)
        f = self.t / 'f.ipc'; f.write_text('x'); os.chmod(f, 0o600); self.start(ipc=f); self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)

    def test_listen_is_loopback_only(self):
        with self.assertRaises(BR.Refused):
            BR.Bridge({**BR.PROFILES['base-el'], 'listen': ('0.0.0.0', 0)}, ipc=str(self.ipc))

    def test_json_end_scanner(self):
        def run(parts):
            j, off = BR.JsonEnd(), 0
            for q in parts:
                k = j.feed(q)
                if k >= 0:
                    return off + k
                off += len(q)
        for parts, want in (([b'  {"a":"}{\\"]"}', b'tail'], 15), ([b'[1,', b'{"x":[2]}', b']garbage'], 13), ([b'{"s":"\\\\"}x'], 10),
                            ([b'{"s":"a\\', b'""}x'], 11), ([b'{"s":"a\\', b'"}', b'}x'], None)):          # an escape split across chunks
            self.assertEqual(run(parts), want, parts)
        v = json.dumps({'k': ['{"x":"]\\"}' + 'ab', {'n': [1, '}']}]}).encode()
        for step in (1, 2, 3, 7, 64):
            self.assertEqual(run([v[i:i + step] for i in range(0, len(v), step)] + [b'zz']), len(v), step)
        with self.assertRaises(BR.Refused):
            BR.JsonEnd().feed(b'"not an object"')

_rt = pathlib.Path.read_text
def _boot(self, *a, **k):
    if str(self) == '/opt/enclave-rpc/manifest.json':
        return json.dumps({'mounts': {'l1': '/srv/enclave-l1-pair', 'base': '/srv/enclave-base-holder'}, 'binaries': {}})
    if str(self) == '/etc/enclave-rpc/chain.json':
        return '{}'
    if str(self) == '/etc/enclave-rpc-vm/disks.json':
        return json.dumps({'disks': [{'role': r, 'mount': m, 'uuid': 'u'} for r, m in (('l1', '/srv/enclave-l1-pair'), ('base', '/srv/enclave-base-holder'))]})
    return _rt(self, *a, **k)


class Wrapper(unittest.TestCase):
    class Exec(Exception):
        pass

    def argv(self, path, side):
        with patch.object(pathlib.Path, 'read_text', _boot):
            W = load(f'cs_{side}_{path.parent.parent.name}', path)
        origin = {'snapshot': {'block': 10}, 'safeL1Origin': {'number': 1, 'hash': '0xab'}, 'toBlock': 1, 'l1Block': 1, 'blobSlot': 2}
        got = {}
        def execve(p, a, env):
            got['argv'] = list(a); raise self.Exec()
        ps = [patch.object(W, 'mount', lambda role, side: '/srv/enclave-l1-pair' if role == 'l1' else '/srv/enclave-base-holder'),
              patch.object(pathlib.Path, 'is_file', return_value=True),
              patch.object(pathlib.Path, 'read_text', return_value='[static_files]\nblocks_per_file = 500000\n'),
              patch.object(W, 'prune_args', return_value=['--prune.fixture']), patch.object(W, 'binary', lambda n: f'/opt/enclave-rpc/bin/{n}'),
              patch.object(W, 'CONFIG', {}), patch.object(W, 'coverage_activation', return_value=origin),
              patch.object(W, 'history_from_block', return_value=0), patch.object(W, 'state_history_from_block', return_value=0),
              patch.object(W, 'history_files_present'), patch.object(W, 'segment_files_present'), patch.object(W, 'l1_ready', return_value={'l1Finalized': 10}),
              patch.object(W, 'rpc', side_effect=lambda port, m, p: {'hash': '0xab'} if m == 'eth_getBlockByNumber' else []),
              patch.object(W, 'beacon', side_effect=lambda q: {'message': {'body': {'blob_kzg_commitments': ['x']}}} if 'blocks' in q else ['x']),
              patch.object(W, 'base_release', return_value=None), patch.object(W.os, 'execve', side_effect=execve)]
        for q in ps:
            q.start()
        try:
            with self.assertRaises(self.Exec):
                W._start(side, None)
        finally:
            for q in reversed(ps):
                q.stop()
        return got['argv']

    def test_the_overlay_only_swaps_ipcdisable_for_a_private_ipc_socket_and_keeps_http_api(self):
        for side, mount in (('el', '/srv/enclave-l1-pair'), ('base', '/srv/enclave-base-holder')):
            with self.subTest(side=side):
                old, new = self.argv(ORIG, side), self.argv(NEW, side)
                i = old.index('--ipcdisable')
                self.assertEqual(new, old[:i] + ['--ipcpath', f'{mount}/tmp/witness-el.ipc', '--ipc.permissions', '0600'] + old[i + 1:])
                self.assertEqual(new[new.index('--http.api') + 1], 'eth,net,web3')
                self.assertFalse([a for a in new if 'debug' in a or a.startswith(('--ws', '--rpc.enable-admin', '--proofs-history'))], new)
        self.assertEqual(BR.PROFILES['base-el']['ipc'], '/srv/enclave-base-holder/tmp/witness-el.ipc')
        self.assertEqual(BR.PROFILES['l1-el']['ipc'], '/srv/enclave-l1-pair/tmp/witness-el.ipc')


class Units(unittest.TestCase):
    def test_bridge_units_are_opt_in_loopback_unprivileged_bounded_and_never_forwarded(self):
        for name, user, prof, port in (('base', 'rpcbase', 'base-el', 18547), ('l1', 'rpcl1el', 'l1-el', 18647)):
            kv = [l for l in (S / f'units/enclave-witness-bridge-{name}.service').read_text().splitlines() if l and not l.startswith('#')]
            self.assertNotIn('[Install]', kv)
            for want in (f'User={user}', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'CapabilityBoundingSet=', 'IPAddressDeny=any',
                         'IPAddressAllow=localhost', 'MemoryMax=512M', f'ExecStart=/usr/bin/python3 -I -B /opt/enclave-rpc/witness/witness_rpc_bridge.py {prof}'):
                self.assertIn(want, kv, (name, want))
            self.assertEqual(BR.PROFILES[prof]['listen'], ('127.0.0.1', port))
        for f in S.rglob('*'):
            if f.is_file() and f.suffix in ('.socket', '.service', '.conf'):
                code = '\n'.join(l for l in f.read_text().splitlines() if not l.lstrip().startswith('#'))
                self.assertNotRegex(code, r'ListenStream=.*(18547|18647)|socket-proxyd.*(18547|18647)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
