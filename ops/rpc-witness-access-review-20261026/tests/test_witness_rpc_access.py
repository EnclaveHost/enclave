"""witness-rpc-access-stage: OFFLINE tests (no node, no network beyond the namespace's loopback; root runs them via jobs/).
Behavioural: the REAL bridge on an ephemeral loopback port against a FAKE node IPC unix socket that records what reaches it; the REAL
patched and original wrapper _start() paths with os.execve captured (only system/RPC boundaries faked) to prove the argv diff."""
import http.client, importlib.util, json, os, pathlib, shutil, socket, sys, tempfile, threading, time, unittest
from unittest.mock import patch

S = pathlib.Path(__file__).resolve().parents[1]; P = S.parent
ORIG = P / 'base-finality-proof-stage/r13-manifest-final/wrapper/chain_service.py'; NEW = S / 'overlay/wrapper/chain_service.py'


def load(name, path):
    s = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


BR = load('witness_rpc_bridge', S / 'bridge/witness_rpc_bridge.py')


class FakeNode:
    """a unix-socket stand-in for the node's IPC server: records each request, answers with `reply` in chunks"""
    def __init__(self, path, reply=b'{"jsonrpc":"2.0","id":1,"result":"0x1"}', chunk=65536, mode=0o600, hold=None, close_early=False):
        self.path, self.reply, self.chunk, self.hold, self.close_early, self.seen = str(path), reply, chunk, hold, close_early, []
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
        if self.hold:
            self.hold.wait(10)
        if not self.close_early:
            for i in range(0, len(self.reply), self.chunk):
                c.sendall(self.reply[i:i + self.chunk])
        c.close()


class Bridge(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='wb-', dir='/tmp')); self.addCleanup(shutil.rmtree, self.t, True); self.ipc = self.t / 'el.ipc'   # AF_UNIX path <= 107 bytes

    def start(self, profile='base-el', inflight=4, ipc=None):
        cfg = {**BR.PROFILES[profile], 'listen': ('127.0.0.1', 0), 'inflight': inflight}
        srv = BR.make_server(cfg, ipc=str(ipc or self.ipc)); threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown); self.port = srv.server_address[1]; return srv

    def post(self, obj=None, raw=None, method='POST'):
        c = http.client.HTTPConnection('127.0.0.1', self.port, timeout=30)
        body = raw if raw is not None else json.dumps(obj).encode()
        c.request(method, '/', body=body if method == 'POST' else None, headers={'Content-Type': 'application/json'})
        r = c.getresponse(); b = r.read(); c.close()
        return r.status, (json.loads(b) if b else None)

    def rq(self, m, i=1, params=None):
        return {'jsonrpc': '2.0', 'id': i, 'method': m, 'params': params or []}

    def test_profiles_are_exactly_the_witness_read_set(self):
        self.assertEqual(set(BR.PROFILES['base-el']['methods']), {'eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
                                                                  'eth_getProof', 'debug_executePayload', 'debug_getRawHeader', 'debug_dbGet'})
        self.assertEqual(set(BR.PROFILES['l1-el']['methods']), {'eth_chainId', 'eth_syncing', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash',
                                                                'debug_getRawHeader', 'debug_getRawReceipts'})
        for p in BR.PROFILES.values():
            self.assertIn(p['listen'][0], ('127.0.0.1', '::1'))
            self.assertLess(len(p['ipc'].encode()), 108, 'the production socket path fits sockaddr_un.sun_path')
            self.assertFalse([m for m in p['methods'] if m.startswith(('admin_', 'txpool_', 'miner_', 'personal_', 'eth_send', 'debug_trace', 'debug_set', 'debug_clear'))])

    def test_allowed_call_is_relayed_and_a_large_chunked_response_returned(self):
        big = json.dumps({'jsonrpc': '2.0', 'id': 7, 'result': {'state': ['0x' + 'ab' * 64] * 40000}}).encode()   # ~5 MB
        node = FakeNode(self.ipc, reply=big, chunk=4096); self.start()
        st, r = self.post(self.rq('debug_executePayload', 7, ['0x' + '11' * 32, {'transactions': []}]))
        self.assertEqual(st, 200); self.assertEqual(len(r['result']['state']), 40000)
        self.assertEqual([x['method'] for x in node.seen], ['debug_executePayload']); self.assertEqual(node.seen[0]['params'][0], '0x' + '11' * 32)

    def test_refused_methods_never_reach_the_node(self):
        node = FakeNode(self.ipc); self.start('base-el')
        for m in ('debug_clearTxpool', 'admin_addPeer', 'debug_traceCall', 'eth_sendRawTransaction', 'txpool_content', 'debug_getRawReceipts', 'optimism_outputAtBlock'):
            with self.subTest(m=m):
                st, r = self.post(self.rq(m)); self.assertEqual((st, r['error']['code']), (200, -32601)); self.assertIn(m, r['error']['message'])
        self.start('l1-el')
        st, r = self.post(self.rq('debug_executePayload')); self.assertEqual(r['error']['code'], -32601)     # Base-only method on the L1 bridge
        self.assertEqual(node.seen, [], 'nothing refused was relayed')

    def test_batches_and_malformed_requests(self):
        node = FakeNode(self.ipc, reply=b'[{"jsonrpc":"2.0","id":1,"result":"0x1"},{"jsonrpc":"2.0","id":2,"result":"0x2"}]'); self.start()
        st, r = self.post([self.rq('eth_chainId', 1), self.rq('debug_getRawHeader', 2, ['0x1'])]); self.assertEqual((st, len(r)), (200, 2))
        for bad, code in (([self.rq('eth_chainId', 1), self.rq('admin_peers', 2)], -32601), ([self.rq('eth_chainId', i) for i in range(33)], -32600),
                          ([], -32600), ({'id': 1, 'method': 'eth_chainId'}, -32600), ({'jsonrpc': '2.0', 'id': 1, 'method': 5}, -32600)):
            with self.subTest(bad=str(bad)[:60]):
                self.assertEqual(self.post(bad)[1]['error']['code'], code)
        self.assertEqual(self.post(raw=b'{not json')[1]['error']['code'], -32700)
        self.assertEqual(len(node.seen), 1, 'only the fully allowed batch reached the node')

    def test_http_bounds(self):
        FakeNode(self.ipc); self.start()
        self.assertEqual(self.post(method='GET')[0], 405)
        c = socket.create_connection(('127.0.0.1', self.port), timeout=10)            # declared oversize body: refused before reading it
        c.sendall(f'POST / HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {BR.MAX_REQUEST + 1}\r\n\r\n'.encode())
        self.assertIn(b' 413 ', c.recv(4096).split(b'\r\n')[0] + b' '); c.close()

    def test_ipc_guards_fail_closed(self):
        self.start(ipc=self.t / 'el.ipc')
        self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)                     # no node socket
        node = FakeNode(self.ipc, mode=0o666)
        self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502); self.assertEqual(node.seen, [], 'a group/other-accessible socket is refused')
        os.chmod(self.ipc, 0o600); node.close_early = True
        self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)                     # node closed before a complete response
        f = self.t / 'file.ipc'; f.write_text('x'); os.chmod(f, 0o600); self.start(ipc=f)
        self.assertEqual(self.post(self.rq('eth_chainId'))[0], 502)                     # not a socket

    def test_concurrency_is_bounded(self):
        hold = threading.Event(); node = FakeNode(self.ipc, hold=hold); self.start(inflight=1); out = {}
        th = threading.Thread(target=lambda: out.setdefault('first', self.post(self.rq('eth_chainId')))); th.start()
        for _ in range(100):
            if node.seen:
                break
            time.sleep(0.05)
        self.assertEqual(self.post(self.rq('eth_blockNumber'))[0], 503)
        hold.set(); th.join(10); self.assertEqual(out['first'][0], 200)

    def test_listen_is_loopback_only(self):
        with self.assertRaises(BR.Refused):
            BR.make_server({**BR.PROFILES['base-el'], 'listen': ('0.0.0.0', 0)}, ipc=str(self.ipc))


_rt = pathlib.Path.read_text
def _boot(self, *a, **k):                                           # the wrapper's three import-time reads (as the finality suites stub)
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
                self.assertEqual(new[new.index('--http.addr') + 1], '127.0.0.1')
        self.assertEqual(BR.PROFILES['base-el']['ipc'], '/srv/enclave-base-holder/tmp/witness-el.ipc')
        self.assertEqual(BR.PROFILES['l1-el']['ipc'], '/srv/enclave-l1-pair/tmp/witness-el.ipc')


class Units(unittest.TestCase):
    def test_bridge_units_are_opt_in_loopback_unprivileged_bounded_and_never_forwarded(self):
        for name, user, prof, port in (('base', 'rpcbase', 'base-el', 18547), ('l1', 'rpcl1el', 'l1-el', 18647)):
            t = (S / f'units/enclave-witness-bridge-{name}.service').read_text()
            kv = [l for l in t.splitlines() if l and not l.startswith('#')]
            self.assertNotIn('[Install]', kv, 'never started at boot / by a consumer')
            for want in (f'User={user}', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'CapabilityBoundingSet=', 'IPAddressDeny=any',
                         'IPAddressAllow=localhost', 'MemoryMax=512M', f'ExecStart=/usr/bin/python3 -I -B /opt/enclave-rpc/witness/witness_rpc_bridge.py {prof}'):
                self.assertIn(want, kv, (name, want))
            self.assertEqual(BR.PROFILES[prof]['listen'], ('127.0.0.1', port))
        for f in S.rglob('*'):                                            # this stage adds no forward for the bridge ports
            if f.is_file() and f.suffix in ('.socket', '.service', '.conf'):
                code = '\n'.join(l for l in f.read_text().splitlines() if not l.lstrip().startswith('#'))
                self.assertNotRegex(code, r'ListenStream=.*(18547|18647)|socket-proxyd.*(18547|18647)')


if __name__ == '__main__':
    unittest.main(verbosity=2)
