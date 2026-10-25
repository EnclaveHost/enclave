#!/usr/bin/env python3
"""Behaviour tests for readiness_sampler.py against synthetic loopback EL / beacon / Base EL / rollup servers.

The fake chain advances one step per sample, on the L1 EL's eth_syncing call (the sampler makes exactly one per
sample, before any head read), so every lookup within a sample sees one consistent step and L1 keeps advancing
even when the Base endpoints are down.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import readiness_sampler as rs  # noqa: E402

ORIGIN_EXTRACT = os.environ.get(
    'ORIGIN_EXTRACT', os.path.join(HERE, '..', 'coverage', 'origin_extract.py'))
SNAP = 'aa' * 32
CFG = 'bb' * 32
BATCHER = '0x5050f69a9786f081509234f1a7f4684b5e5b76c9'
ROLES = ('el', 'beacon', 'base', 'rollup')


class Raw:
    def __init__(self, status=200, body=b'', headers=(), delay=0.0, drip=None):
        self.status, self.body, self.headers, self.delay, self.drip = status, body, dict(headers), delay, drip


class RpcError:
    pass


def _h(tag):
    return '0x' + hashlib.sha256(tag.encode()).hexdigest()


class Chain:
    """Deterministic synthetic L1 + Base. Step k advances once per sample (on L1 eth_syncing)."""

    def __init__(self, samples, patch=None, **o):
        self.k, self.S, self.t0, self.o = 0, samples, time.time(), o
        self.patch = patch or (lambda role, key, res: res)
        self.lock = threading.Lock()

    # L1
    def l1hash(self, n):
        return rs.EL_GENESIS if n == 0 else _h(f'l1:{n}')

    def l1ts(self, n):
        return int(self.t0 + (n - 5000 - self.S) * 12 + self.o.get('l1_shift', 0))

    def l1_head(self):
        return 5000 + (0 if self.o.get('l1_stuck') else self.k)

    def l1_fin(self):
        return self.l1_head() - 64

    def l1_block(self, n):
        if n > self.l1_head():
            return None
        return {'number': hex(n), 'hash': self.l1hash(n), 'parentHash': self.l1hash(n - 1) if n else '0x' + '00' * 32,
                'timestamp': hex(self.l1ts(n)), 'transactions': []}

    def payload(self, n, finalized):
        return {'version': 'fulu', 'execution_optimistic': False, 'finalized': finalized,
                'data': {'message': {'slot': str(9_000_000 + n), 'parent_root': _h(f'root:{n - 1}'),
                                     'body': {'execution_payload_header': {
                                         'block_number': str(n), 'block_hash': self.l1hash(n),
                                         'parent_hash': self.l1hash(n - 1), 'timestamp': str(self.l1ts(n))}}}}}

    # Base
    def bhash(self, n):
        if n == 0:
            return rs.BASE_L2_GENESIS
        rewritten = self.o.get('rewrite') and self.k >= 3 and n <= 49932
        return _h(f'base{"rw" if rewritten else ""}:{n}')

    def bts(self, n):
        return int(self.t0 + (n - 50000 - self.S) * 2)

    def unsafe(self):
        return 50000 + self.k

    def safe(self):
        return 49980 + (0 if self.o.get('safe_stuck') else self.k)

    def fin(self):
        return 49930 + (0 if self.o.get('finalized_stuck') else self.k)

    @staticmethod
    def origin(n):
        return n - 45000

    def l1info(self, n):
        o = self.origin(n)
        h = self.o.get('deposit_origin_hash') or self.l1hash(o)
        r = (bytes.fromhex('440a5e20') + (1).to_bytes(4, 'big') + (2).to_bytes(4, 'big') + (n % 7).to_bytes(8, 'big')
             + self.l1ts(o).to_bytes(8, 'big') + o.to_bytes(8, 'big') + bytes(32) + bytes(32)
             + bytes.fromhex(h[2:]) + bytes(12) + bytes.fromhex(BATCHER[2:]))
        return '0x' + r.hex()

    def b_block(self, n):
        if n > self.unsafe():
            return None
        return {'number': hex(n), 'hash': self.bhash(n), 'parentHash': self.bhash(n - 1) if n else '0x' + '00' * 32,
                'timestamp': hex(self.bts(n)), 'transactions': []}

    def l2ref(self, n):
        return {'hash': self.bhash(n), 'number': n, 'parentHash': self.bhash(n - 1), 'timestamp': self.bts(n),
                'l1origin': {'hash': self.l1hash(self.origin(n)), 'number': self.origin(n)}, 'sequenceNumber': n % 7}

    def blockinfo(self, n):
        return {'hash': self.l1hash(n), 'number': n, 'parentHash': self.l1hash(n - 1), 'timestamp': self.l1ts(n)}

    def sync_status(self):
        zero = {'hash': rs.ZERO32, 'number': 0, 'parentHash': rs.ZERO32, 'timestamp': 0,
                'l1origin': {'hash': rs.ZERO32, 'number': 0}, 'sequenceNumber': 0}
        unsafe_only = self.o.get('unsafe_only')
        return {'current_l1': self.blockinfo(self.l1_head() - 2), 'current_l1_finalized': self.blockinfo(self.l1_fin()),
                'head_l1': self.blockinfo(self.l1_head()), 'safe_l1': self.blockinfo(self.l1_head() - 32),
                'finalized_l1': self.blockinfo(self.l1_fin()), 'unsafe_l2': self.l2ref(self.unsafe()),
                'safe_l2': zero if unsafe_only else self.l2ref(self.safe()),
                'finalized_l2': zero if unsafe_only else self.l2ref(self.fin()),
                'local_safe_l2': zero if unsafe_only else self.l2ref(self.safe())}

    def rollup_config(self):
        return {'genesis': {'l1': dict(rs.BASE_L1_GENESIS), 'l2': {'hash': rs.BASE_L2_GENESIS, 'number': 0},
                            'l2_time': rs.BASE_L2_TIME, 'system_config': {'batcherAddress': BATCHER}},
                'block_time': 2, 'max_sequencer_drift': 600, 'seq_window_size': 3600, 'channel_timeout': 300,
                'granite_channel_timeout': 50, 'l1_chain_id': 1, 'l2_chain_id': 8453,
                'batch_inbox_address': '0xff00000000000000000000000000000000008453',
                'deposit_contract_address': '0x49048044D57e1C92A77f79988d21Fa8fAF74E97e',
                'l1_system_config_address': '0x73a79Fab69143498Ed3712e519A88a918e1f4072',
                'protocol_versions_address': '0x8062AbC286f5e7D9428a0Ccb9AbD71e50d93b935'}

    def _tag(self, tag, head, named):
        if tag in named:
            return named[tag]
        return int(tag, 16) if tag.startswith('0x') else head

    def rpc(self, role, method, params):
        with self.lock:
            res = self._rpc(role, method, params)
            return self.patch(role, method, res)

    def _rpc(self, role, method, params):
        if role == 'el':
            if method == 'eth_chainId':
                return '0x1'
            if method == 'web3_clientVersion':
                return 'reth/v2.8.0-synthetic'
            if method == 'eth_syncing':
                self.k += 1
                return False
            if method == 'eth_getBlockByNumber':
                lag = 32 if self.o.get('el_finalized_lag') else 0
                return self.l1_block(self._tag(params[0], self.l1_head(),
                                               {'latest': self.l1_head(), 'finalized': self.l1_fin() - lag}))
        if role == 'base':
            if method == 'eth_chainId':
                return '0x2105'
            if method == 'eth_syncing':
                return False
            if method == 'eth_getBlockByNumber':
                return self.b_block(self._tag(params[0], self.unsafe(), {
                    'latest': self.unsafe(), 'safe': self.safe(), 'finalized': self.fin()}))
            if method == 'eth_getTransactionByBlockNumberAndIndex':
                n = int(params[0], 16)
                if n > self.unsafe() or params[1] != '0x0':
                    return None
                return {'type': '0x7e', 'input': self.l1info(n), 'hash': _h(f'dep:{n}'), 'blockNumber': hex(n)}
        if role == 'rollup':
            if method == 'optimism_syncStatus':
                return self.sync_status()
            if method == 'optimism_rollupConfig':
                return self.rollup_config()
            if method == 'optimism_version':
                return '1.5.1'
        return RpcError()

    def rest(self, role, path):
        with self.lock:
            res = self._rest(path) if role == 'beacon' else Raw(404, b'{}')
            return self.patch(role, path, res)

    def _rest(self, path):
        if path == '/eth/v1/beacon/genesis':
            return {'data': {'genesis_time': str(rs.CL_GENESIS_TIME), 'genesis_validators_root': rs.CL_GVR,
                             'genesis_fork_version': '0x00000000'}}
        if path == '/eth/v1/config/spec':
            return {'data': {'DEPOSIT_CHAIN_ID': '1', 'SECONDS_PER_SLOT': '12', 'FULU_FORK_EPOCH': '411392'}}
        if path == '/eth/v1/node/version':
            return {'data': {'version': 'Lighthouse/v8.3.2-synthetic/x86_64-linux'}}
        if path == '/eth/v1/node/syncing':
            return {'data': {'head_slot': str(9_000_000 + self.l1_head()), 'sync_distance': '0', 'is_syncing': False,
                             'is_optimistic': False, 'el_offline': False}}
        if path == '/eth/v1/node/identity':
            return {'data': {'peer_id': 'synthetic', 'metadata': {'seq_number': '1', 'custody_group_count': '64'}}}
        if path == '/eth/v1/beacon/blinded_blocks/head':
            return self.payload(self.l1_head(), False)
        if path == '/eth/v1/beacon/blinded_blocks/finalized':
            return self.payload(self.l1_fin(), True)
        return Raw(404, b'{"code":404,"message":"NOT_FOUND"}')


def make_handler(chain, role, hits):
    class H(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *a):
            pass

        def do_POST(self):
            hits[role] = hits.get(role, 0) + 1
            req = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            res = chain.rpc(role, req['method'], req['params'])
            if isinstance(res, RpcError):
                res = {'jsonrpc': '2.0', 'id': req.get('id'), 'error': {'code': -32601, 'message': 'not found'}}
            elif not isinstance(res, Raw):
                res = {'jsonrpc': '2.0', 'id': req.get('id'), 'result': res}
            self.send(res)

        def do_GET(self):
            hits[role] = hits.get(role, 0) + 1
            self.send(chain.rest(role, self.path))

        def send(self, res):
            raw = res if isinstance(res, Raw) else Raw(200, json.dumps(res).encode())
            if raw.delay:
                time.sleep(raw.delay)
            try:   # the sampler may already have hung up (timeout/bound tests)
                self.send_response(raw.status)
                self.send_header('Content-Type', 'application/json')
                for k, v in raw.headers.items():
                    self.send_header(k, v)
                self.send_header('Content-Length', str(len(raw.body)))
                self.end_headers()
                if raw.drip:
                    for b in raw.body:
                        self.wfile.write(bytes([b]))
                        self.wfile.flush()
                        time.sleep(raw.drip)
                else:
                    self.wfile.write(raw.body)
            except OSError:
                pass
    return H


class Server(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False


def closed_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Env:
    def __init__(self, samples=4, closed=(), patch=None, **o):
        self.samples = samples
        self.chain = Chain(samples, patch, **o)
        self.hits, self.servers, self.ports = {}, [], {}
        for role in ROLES:
            if role in closed:
                self.ports[role] = closed_port()
                continue
            srv = Server(('127.0.0.1', 0), make_handler(self.chain, role, self.hits))
            threading.Thread(target=srv.serve_forever, daemon=True).start()
            self.servers.append(srv)
            self.ports[role] = srv.server_address[1]
        self.tmp = tempfile.TemporaryDirectory()

    def close(self):
        for s in self.servers:
            s.shutdown()
            s.server_close()
        self.tmp.cleanup()

    def argv(self, *extra, out='report.json'):
        a = ['--out', os.path.join(self.tmp.name, out), '--samples', str(self.samples), '--interval', '0.05',
             '--min-window', '0', '--timeout', '2']
        for role in ROLES:
            a += [f'--{role}-port', str(self.ports[role])]
        return a + list(extra)

    def run(self, *extra):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = rs.main(self.argv(*extra))
        with open(os.path.join(self.tmp.name, 'report.json')) as f:
            return rc, json.load(f)

    # coverage evidence (bytes written exactly as hashed by the receipt)
    def coverage(self, origin_mut=None, verdict_mut=None, receipt_mut=None, tamper_verdict=False, expect=True):
        c = self.chain
        safe_n = 49500
        o = c.origin(safe_n)
        origin = {'format': rs.ORIGIN_FORMAT, 'chain': 'base-mainnet', 'status': 'SAFE_HEAD_PERSISTED',
                  'labels': {'tip': {'number': 49600, 'hash': c.bhash(49600), 'l1Origin': {'number': o + 100, 'hash': c.l1hash(o + 100)}},
                             'safe': {'number': safe_n, 'hash': c.bhash(safe_n), 'l1Origin': {'number': o, 'hash': c.l1hash(o)},
                                      'batcher': BATCHER, 'layout': 'ecotone', 'sequenceNumber': 0},
                             'finalized': None},
                  'source': {'tool': 'base reth db get (AccessRights::RO)', 'binarySha256': rs.BASE_BINARY_SHA256,
                             'datadirReadOnlyMount': True}}
        need, to = o - 3600, o + 400
        verdict = {'format': rs.VERDICT_FORMAT, 'verdict': 'COVERED', 'rule': 'safe-origin-minus-seq-window',
                   'needFromBlock': need, 'toBlock': to, 'batcher': BATCHER, 'blobScope': 'batcher',
                   'counts': {'blocks': to - need + 1, 'transactions': 9000, 'receipts': 9000, 'blobTxs': 6,
                              'blobsVerified': 12, 'missedSlots': 3, 'missingData': 0, 'mismatches': 0},
                   'missingData': [], 'mismatches': [], 'missedSlots': [1, 2, 3],
                   'proposedBaseBootstrap': {'l1Block': need, 'blobSlot': 9_001_234, 'rootReviewRequired': True,
                                             'coverageVerifiedEligible': True, 'note': 'x'},
                   'coverageVerifiedWritten': False, 'http': {'requests': 1, 'bytes': 1}}
        for doc, mut in ((origin, origin_mut), (verdict, verdict_mut)):
            if mut:
                mut(doc)
        ob, vb = json.dumps(origin).encode(), json.dumps(verdict).encode()
        receipt = {'format': rs.RECEIPT_FORMAT, 'decision': 'accepted',
                   'verdictSha256': hashlib.sha256(vb).hexdigest(), 'originSha256': hashlib.sha256(ob).hexdigest(),
                   'snapshotManifestSha256': SNAP, 'chainConfigSha256': CFG,
                   'kzgcheckSha256': rs.KZGCHECK_SHA256, 'baseBinarySha256': rs.BASE_BINARY_SHA256,
                   'baseBootstrap': {'l1Block': need, 'blobSlot': 9_001_234},
                   'review': {'reviewer': 'root-independent-review', 'gateRunner': 'coverage-operator',
                              'reviewedAt': '2026-10-25T15:00:00Z'}}
        if receipt_mut:
            receipt_mut(receipt)
        if tamper_verdict:
            vb = vb.replace(b'"blobsVerified": 12', b'"blobsVerified": 13')
        paths = {}
        for name, data in (('origin', ob), ('verdict', vb), ('receipt', json.dumps(receipt).encode())):
            paths[name] = os.path.join(self.tmp.name, name + '.json')
            with open(paths[name], 'wb') as f:
                f.write(data)
        args = ['--coverage-receipt', paths['receipt'], '--coverage-verdict', paths['verdict'],
                '--coverage-origin', paths['origin']]
        if expect:
            args += ['--expect-snapshot-manifest-sha256', SNAP, '--expect-chain-config-sha256', CFG]
        return args


def patch_for(role_key, value):
    def p(role, key, res):
        return value(res) if callable(value) and (role, key) == role_key else value if (role, key) == role_key else res
    return p


class Base(unittest.TestCase):
    samples = 4

    def env(self, **kw):
        kw.setdefault('samples', self.samples)
        e = Env(**kw)
        self.addCleanup(e.close)
        return e

    def gate(self, report, name):
        return report['gates'][name]

    def assertNotReady(self, rc, report):
        self.assertNotEqual(rc, 0)
        self.assertIs(report['acceptance'], False)
        self.assertIs(report['activationAuthorized'], False)
        self.assertIs(report['coverageVerifiedWritten'], False)

    def assertFailed(self, rc, report, gate, code):
        self.assertNotReady(rc, report)
        self.assertEqual(rc, 3, report['gates'])
        self.assertEqual(report['overall'], 'FAIL')
        g = self.gate(report, gate)
        self.assertEqual((g['status'], g.get('code')), ('fail', code), g)

    def assertIncomplete(self, rc, report, gate, code):
        self.assertNotReady(rc, report)
        self.assertEqual(rc, 4, report['gates'])
        self.assertEqual(report['overall'], 'INCOMPLETE')
        self.assertFalse([k for k, v in report['gates'].items() if v['status'] == 'fail'], report['gates'])
        g = self.gate(report, gate)
        self.assertEqual((g['status'], g.get('code')), ('incomplete', code), g)


class TestHealthy(Base):
    def test_healthy_chain_without_coverage_is_incomplete_not_ready(self):
        e = self.env()
        rc, r = e.run()
        self.assertIncomplete(rc, r, 'historical-coverage', 'coverage-receipt-absent')
        others = {k: v['status'] for k, v in r['gates'].items() if k != 'historical-coverage'}
        self.assertEqual(set(others.values()), {'pass'}, r['gates'])
        self.assertEqual(len(r['samples']), self.samples)
        self.assertTrue(all(u.startswith('http://127.0.0.1:') for u in r['endpoints'].values()))
        self.assertEqual(r['gates']['base-safe-advancing']['info']['to'] - r['gates']['base-safe-advancing']['info']['from'],
                         self.samples - 1)

    def test_healthy_chain_with_valid_reviewed_coverage_is_ready(self):
        e = self.env()
        rc, r = e.run(*e.coverage())
        self.assertEqual((rc, r['overall'], r['acceptance']), (0, 'READY', True), r['gates'])
        self.assertIs(r['activationAuthorized'], False)
        self.assertEqual(r['coverage']['snapshotSafe']['number'], 49500)

    def test_out_is_never_overwritten(self):
        e = self.env(samples=2)
        open(os.path.join(e.tmp.name, 'report.json'), 'w').close()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            rs.main(e.argv())
        self.assertEqual(cm.exception.code, 2)


class TestL1Negative(Base):
    def test_stale_l1_head(self):
        e = self.env(l1_shift=-1000)
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-head-paired-fresh', 'l1-head-stale')
        self.assertEqual(r['gates']['sampling-complete']['code'], 'stopped-on-fail')

    def test_cl_optimistic(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/node/syncing'),
                                     lambda d: {'data': dict(d['data'], is_optimistic=True)}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-consensus-nonoptimistic', 'cl-optimistic')

    def test_head_block_optimistic(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/beacon/blinded_blocks/head'),
                                     lambda d: dict(d, execution_optimistic=True)))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-head-paired-fresh', 'cl-optimistic')

    def test_finalized_block_optimistic(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/beacon/blinded_blocks/finalized'),
                                     lambda d: dict(d, execution_optimistic=True)))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-finalized-paired', 'cl-optimistic')

    def test_el_syncing(self):
        e = self.env(patch=patch_for(('el', 'eth_syncing'), {'startingBlock': '0x0', 'currentBlock': '0x1', 'highestBlock': '0x9'}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-execution-synced', 'el-syncing')

    def test_wrong_l1_chain(self):
        e = self.env(patch=patch_for(('el', 'eth_chainId'), '0x5'))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-identity', 'wrong-chain')

    def test_wrong_cl_genesis(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/beacon/genesis'),
                                     lambda d: {'data': dict(d['data'], genesis_validators_root='0x' + '11' * 32)}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-identity', 'wrong-chain')

    def test_cl_el_head_payload_mismatch(self):
        def p(role, key, res):
            if (role, key) == ('beacon', '/eth/v1/beacon/blinded_blocks/head'):
                res['data']['message']['body']['execution_payload_header']['block_hash'] = '0x' + '22' * 32
            return res
        rc, r = self.env(patch=p).run()
        self.assertFailed(rc, r, 'l1-head-paired-fresh', 'el-cl-head-mismatch')

    def test_cl_el_head_timestamp_mismatch(self):
        def p(role, key, res):
            if (role, key) == ('beacon', '/eth/v1/beacon/blinded_blocks/head'):
                h = res['data']['message']['body']['execution_payload_header']
                h['timestamp'] = str(int(h['timestamp']) + 12)
            return res
        rc, r = self.env(patch=p).run()
        self.assertFailed(rc, r, 'l1-head-paired-fresh', 'el-cl-head-mismatch')

    def test_el_finalized_tag_diverges_from_beacon(self):
        rc, r = self.env(el_finalized_lag=True).run()
        self.assertFailed(rc, r, 'l1-finalized-paired', 'el-cl-finalized-diverge')

    def test_nonadvancing_l1_head(self):
        e = self.env(l1_stuck=True)
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'l1-head-advancing', 'l1-head-not-advancing')
        self.assertEqual(r['gates']['l1-head-paired-fresh']['status'], 'pass')

    def test_low_custody(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/node/identity'),
                                     lambda d: {'data': {'metadata': {'custody_group_count': '4'}}}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-custody', 'insufficient-custody')

    def test_wrong_lighthouse_version(self):
        e = self.env(patch=patch_for(('beacon', '/eth/v1/node/version'), {'data': {'version': 'Lighthouse/v8.2.0'}}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'l1-identity', 'wrong-client')


class TestBaseNegative(Base):
    def test_wrong_base_chain_in_rollup_config(self):
        e = self.env(patch=patch_for(('rollup', 'optimism_rollupConfig'), lambda d: dict(d, l2_chain_id=84532)))
        rc, r = e.run()
        self.assertFailed(rc, r, 'base-identity', 'wrong-chain')

    def test_wrong_base_el_chain(self):
        e = self.env(patch=patch_for(('base', 'eth_chainId'), '0x14a34'))
        rc, r = e.run()
        self.assertFailed(rc, r, 'base-identity', 'wrong-chain')

    def test_unsafe_latest_alone_is_never_ready(self):
        e = self.env()
        e.chain.o['unsafe_only'] = True
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-safe-not-derived')
        self.assertEqual(r['gates']['base-safe-advancing']['status'], 'incomplete')

    def test_nonadvancing_safe(self):
        e = self.env(safe_stuck=True)
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-safe-advancing', 'base-safe-not-advancing')
        self.assertEqual(r['gates']['base-unsafe-fresh']['status'], 'pass')

    def test_nonadvancing_finality(self):
        e = self.env(finalized_stuck=True)
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-finalized-advancing', 'base-finalized-not-advancing')
        self.assertEqual(r['gates']['base-safe-advancing']['status'], 'pass')

    def test_safe_hash_mismatch_with_base_el(self):
        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                res['safe_l2']['hash'] = '0x' + '33' * 32
            return res
        rc, r = self.env(patch=p).run()
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-el-rollup-mismatch')

    def test_reported_l1origin_disagrees_with_deposit(self):
        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                res['finalized_l2']['l1origin']['number'] -= 1
            return res
        rc, r = self.env(patch=p).run()
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-l1-origin-mismatch')

    def test_l1origin_not_canonical_on_our_l1(self):
        fake = '0x' + '44' * 32

        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                for k in ('unsafe_l2', 'safe_l2', 'finalized_l2'):
                    res[k]['l1origin']['hash'] = fake
            return res
        rc, r = self.env(patch=p, deposit_origin_hash=fake).run()
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-l1-origin-not-canonical')

    def test_rollup_finalized_l1_ahead_of_our_finality(self):
        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                n = res['head_l1']['number']
                res['finalized_l1'] = {'hash': _h(f'l1:{n}'), 'number': n, 'parentHash': _h(f'l1:{n - 1}'), 'timestamp': 1}
            return res
        rc, r = self.env(patch=p).run()
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-l1-finality-ahead')

    def test_base_finality_rewritten_between_samples(self):
        e = self.env(rewrite=True)
        rc, r = e.run()
        self.assertFailed(rc, r, 'base-heads-consistent', 'base-finality-violated')

    def test_base_el_syncing(self):
        e = self.env(patch=patch_for(('base', 'eth_syncing'), {'currentBlock': '0x1'}))
        rc, r = e.run()
        self.assertFailed(rc, r, 'base-execution-synced', 'base-el-syncing')

    def test_stale_safe_head(self):
        e = self.env()
        rc, r = e.run('--max-safe-age', '10')
        self.assertFailed(rc, r, 'base-safe-fresh', 'base-safe-stale')


class TestUnavailable(Base):
    def test_rollup_http_500_is_incomplete_not_negative(self):
        def p(role, key, res):
            return Raw(500, b'oops') if role == 'rollup' else res
        rc, r = self.env(patch=p).run()
        self.assertIncomplete(rc, r, 'base-heads-consistent', 'http-500')
        self.assertEqual(r['gates']['base-identity']['code'], 'http-500')
        self.assertEqual(r['gates']['base-safe-advancing']['code'], 'insufficient-samples')

    def test_rollup_port_closed(self):
        rc, r = self.env(closed=('rollup',)).run()
        self.assertIncomplete(rc, r, 'base-heads-consistent', 'endpoint-unreachable')

    def test_el_port_closed(self):
        rc, r = self.env(closed=('el',)).run()
        self.assertIncomplete(rc, r, 'l1-identity', 'endpoint-unreachable')

    def test_jsonrpc_error_is_unavailable(self):
        def p(role, key, res):
            return RpcError() if (role, key) == ('rollup', 'optimism_syncStatus') else res
        rc, r = self.env(patch=p).run()
        self.assertIncomplete(rc, r, 'base-heads-consistent', 'rpc-error')

    def test_malformed_sync_status_is_unavailable(self):
        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                res['safe_l2']['number'] = hex(res['safe_l2']['number'])   # wrong type for u64
            return res
        rc, r = self.env(patch=p).run()
        self.assertIncomplete(rc, r, 'base-heads-consistent', 'malformed-response')

    def test_beacon_404_head_is_unavailable(self):
        rc, r = self.env(patch=patch_for(('beacon', '/eth/v1/beacon/blinded_blocks/head'), Raw(404, b'{}'))).run()
        self.assertIncomplete(rc, r, 'l1-head-paired-fresh', 'http-404')


class TestBounds(Base):
    samples = 2

    def test_oversized_response_is_cut(self):
        big = Raw(200, b'{"data":"' + b'x' * 200_000 + b'"}')
        rc, r = self.env(patch=patch_for(('beacon', '/eth/v1/node/identity'), big)).run('--max-body', '65536')
        self.assertIncomplete(rc, r, 'l1-custody', 'response-too-large')

    def test_slow_response_times_out(self):
        slow = Raw(200, b'{"data":{"version":"Lighthouse/v8.3.2"}}', delay=1.5)
        t = time.monotonic()
        rc, r = self.env(patch=patch_for(('beacon', '/eth/v1/node/version'), slow)).run('--timeout', '0.5')
        self.assertIncomplete(rc, r, 'l1-identity', 'endpoint-unreachable')
        self.assertLess(time.monotonic() - t, 10)

    def test_slow_drip_body_is_cut_by_wall_timeout(self):
        drip = Raw(200, b'{"data":{"metadata":{"custody_group_count":"64"}},"pad":"' + b'y' * 200 + b'"}', drip=0.05)
        t = time.monotonic()
        rc, r = self.env(patch=patch_for(('beacon', '/eth/v1/node/identity'), drip)).run('--timeout', '0.5')
        self.assertIncomplete(rc, r, 'l1-custody', 'response-timeout')
        self.assertLess(time.monotonic() - t, 10)

    def test_redirect_is_not_followed(self):
        e = self.env()
        target_hits = {}
        tgt = Server(('127.0.0.1', 0), make_handler(e.chain, 'beacon', target_hits))
        threading.Thread(target=tgt.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (tgt.shutdown(), tgt.server_close()))
        loc = f'http://127.0.0.1:{tgt.server_address[1]}/eth/v1/beacon/genesis'
        e.chain.patch = patch_for(('beacon', '/eth/v1/beacon/genesis'), Raw(302, b'', {'Location': loc}))
        rc, r = e.run()
        self.assertIncomplete(rc, r, 'l1-identity', 'http-302')
        self.assertEqual(target_hits, {})

    def test_request_budget(self):
        rc, r = self.env().run('--max-requests', '10')
        self.assertNotReady(rc, r)
        self.assertEqual(r['overall'], 'INCOMPLETE')
        self.assertLessEqual(r['http']['requests'], 10)
        codes = {v.get('code') for v in r['gates'].values()}
        self.assertIn('request-budget-exhausted', codes)

    def test_window_too_short_is_incomplete(self):
        e = self.env()
        rc, r = e.run('--min-window', '3600', *e.coverage())
        self.assertIncomplete(rc, r, 'base-safe-advancing', 'window-too-short')

    def test_cli_bounds_rejected(self):
        e = self.env()
        for bad in (['--samples', '1'], ['--samples', '33'], ['--timeout', '60'], ['--interval', '700'],
                    ['--max-body', '1'], ['--max-requests', '5000'], ['--samples', '32', '--interval', '600'],
                    ['--max-duration', '99999'], ['--el-port', '0'], ['--expect-chain-config-sha256', 'XYZ']):
            with self.subTest(bad=bad), self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
                rs.main(e.argv(*bad, out='never.json'))
            self.assertEqual(cm.exception.code, 2)
            self.assertFalse(os.path.exists(os.path.join(e.tmp.name, 'never.json')))

    def test_no_url_option_exists(self):
        e = self.env()
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
            rs.main(e.argv('--el-url', 'https://example.invalid'))


class TestCoverage(Base):
    samples = 3

    def test_absent_identity_pins_is_incomplete(self):
        e = self.env()
        rc, r = e.run(*e.coverage(expect=False))
        self.assertIncomplete(rc, r, 'historical-coverage', 'expected-identity-absent')

    def test_receipt_without_verdict_is_incomplete(self):
        e = self.env()
        args = e.coverage()
        i = args.index('--coverage-verdict')
        rc, r = e.run(*(args[:i] + args[i + 2:]))
        self.assertIncomplete(rc, r, 'historical-coverage', 'coverage-evidence-absent')

    def test_boolean_flag_is_not_evidence(self):
        e = self.env()
        args = e.coverage()
        with open(args[1], 'w') as f:
            json.dump({'coverageVerified': True}, f)
        rc, r = e.run(*args)
        self.assertFailed(rc, r, 'historical-coverage', 'receipt-format')

    def test_tampered_verdict_bytes(self):
        e = self.env()
        rc, r = e.run(*e.coverage(tamper_verdict=True))
        self.assertFailed(rc, r, 'historical-coverage', 'verdict-hash-mismatch')

    def test_refused_verdict(self):
        def m(v):
            v.update(verdict='REFUSED', refusal={'code': 'missing-data', 'detail': 'x'})
        e = self.env()
        rc, r = e.run(*e.coverage(verdict_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'verdict-not-covered')

    def test_tip_walk_verdict_not_eligible(self):
        def m(v):
            v['rule'] = 'tip-walk-rule (no persisted safe; source-derived)'
            v['proposedBaseBootstrap']['coverageVerifiedEligible'] = False
        e = self.env()
        rc, r = e.run(*e.coverage(verdict_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'verdict-not-eligible')

    def test_missing_data_counts(self):
        def m(v):
            v['counts']['missingData'] = 2
        e = self.env()
        rc, r = e.run(*e.coverage(verdict_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'verdict-incomplete')

    def test_partial_range(self):
        def m(v):
            v['counts']['blocks'] -= 1
        e = self.env()
        rc, r = e.run(*e.coverage(verdict_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'verdict-incomplete')

    def test_no_persisted_safe_origin(self):
        def m(o):
            o['status'] = 'NO_PERSISTED_SAFE_HEAD'
            o['labels']['safe'] = None
        e = self.env()
        rc, r = e.run(*e.coverage(origin_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'origin-not-safe-labeled')

    def test_snapshot_identity_mismatch(self):
        e = self.env()
        rc, r = e.run(*e.coverage(receipt_mut=lambda rc_: rc_.update(snapshotManifestSha256='cc' * 32)))
        self.assertFailed(rc, r, 'historical-coverage', 'snapshot-identity-mismatch')

    def test_config_identity_mismatch(self):
        e = self.env()
        rc, r = e.run(*e.coverage(receipt_mut=lambda rc_: rc_.update(chainConfigSha256='cc' * 32)))
        self.assertFailed(rc, r, 'historical-coverage', 'config-identity-mismatch')

    def test_tool_pin_mismatch(self):
        e = self.env()
        rc, r = e.run(*e.coverage(receipt_mut=lambda rc_: rc_.update(kzgcheckSha256='dd' * 32)))
        self.assertFailed(rc, r, 'historical-coverage', 'tool-pin-mismatch')

    def test_self_review_rejected(self):
        e = self.env()
        rc, r = e.run(*e.coverage(receipt_mut=lambda rc_: rc_['review'].update(reviewer='coverage-operator')))
        self.assertFailed(rc, r, 'historical-coverage', 'review-not-independent')

    def test_binding_mismatch(self):
        e = self.env()
        rc, r = e.run(*e.coverage(receipt_mut=lambda rc_: rc_['baseBootstrap'].update(blobSlot=1)))
        self.assertFailed(rc, r, 'historical-coverage', 'coverage-binding-mismatch')

    def test_snapshot_not_ancestor_of_running_chain(self):
        def m(o):
            o['labels']['safe']['hash'] = '0x' + '55' * 32
        e = self.env()
        rc, r = e.run(*e.coverage(origin_mut=m))
        self.assertFailed(rc, r, 'historical-coverage', 'snapshot-not-ancestor')

    def test_snapshot_block_pruned_is_incomplete(self):
        def p(role, key, res):
            return None if (role, key) == ('base', 'eth_getBlockByNumber') and res and int(res['number'], 16) == 49500 else res
        e = self.env(patch=p)
        rc, r = e.run(*e.coverage())
        self.assertIncomplete(rc, r, 'historical-coverage', 'snapshot-block-unavailable')


def tag_patch(env, fn):
    """Rewrite only Base EL eth_getBlockByNumber('safe'|'finalized') results (root probe technique)."""
    original = env.chain._rpc

    def wrapped(role, method, params):
        res = original(role, method, params)
        if role == 'base' and method == 'eth_getBlockByNumber' and params[0] in ('safe', 'finalized'):
            res = fn(params[0], res)
        return res
    env.chain._rpc = wrapped


class TestElLabels(Base):
    samples = 3

    def run_tags(self, fn, *extra):
        e = self.env()
        tag_patch(e, fn)
        return e.run(*e.coverage(), *extra), e

    def test_root_probe_both_tags_contradict_canonical(self):
        (rc, r), _ = self.run_tags(lambda tag, b: dict(b, hash='0x' + 'ab' * 32))
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_safe_tag_hash_contradicts(self):
        (rc, r), _ = self.run_tags(lambda tag, b: dict(b, hash='0x' + 'ab' * 32) if tag == 'safe' else b)
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_finalized_tag_hash_contradicts(self):
        (rc, r), _ = self.run_tags(lambda tag, b: dict(b, hash='0x' + 'ab' * 32) if tag == 'finalized' else b)
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_finalized_tag_parent_contradicts(self):
        (rc, r), _ = self.run_tags(lambda tag, b: dict(b, parentHash='0x' + 'cd' * 32) if tag == 'finalized' else b)
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_safe_tag_timestamp_contradicts(self):
        (rc, r), _ = self.run_tags(lambda tag, b: dict(b, timestamp=hex(int(b['timestamp'], 16) + 2)) if tag == 'safe' else b)
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_ahead_tag_with_wrong_hash(self):
        e = self.env()
        tag_patch(e, lambda tag, b: dict(e.chain.b_block(int(b['number'], 16) + 1), hash='0x' + 'ef' * 32))
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-noncanonical')

    def test_ahead_tag_canonical_race_is_allowed(self):
        e = self.env()
        tag_patch(e, lambda tag, b: e.chain.b_block(int(b['number'], 16) + 1))
        rc, r = e.run(*e.coverage())
        self.assertEqual((rc, r['overall']), (0, 'READY'), r['gates'])

    def test_ahead_tag_beyond_bound_is_incoherent(self):
        e = self.env()
        tag_patch(e, lambda tag, b: e.chain.b_block(e.chain.safe()) if tag == 'finalized' else b)
        old = rs.LABEL_AHEAD_MAX
        rs.LABEL_AHEAD_MAX = 10
        self.addCleanup(setattr, rs, 'LABEL_AHEAD_MAX', old)
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-ahead-incoherent')

    def test_finalized_tag_ahead_of_safe_tag(self):
        e = self.env()
        tag_patch(e, lambda tag, b: e.chain.b_block(e.chain.safe() + 1) if tag == 'finalized' else b)
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'base-el-labels', 'base-el-label-order')

    def test_behind_tag_is_incomplete(self):
        e = self.env()
        tag_patch(e, lambda tag, b: e.chain.b_block(int(b['number'], 16) - 1) if tag == 'safe' else b)
        rc, r = e.run(*e.coverage())
        self.assertIncomplete(rc, r, 'base-el-labels', 'base-el-label-behind')

    def test_same_height_tag_must_equal_validated_rollup_ref(self):
        blk = {'number': 10, 'hash': '0x' + '01' * 32, 'parentHash': '0x' + '02' * 32, 'timestamp': 100}
        s = rs.Sampler(None, None)
        s.el_block = lambda name, tag, fresh=False: dict(blk, number=11) if tag == 'latest' else dict(blk)
        ref = {'number': 10, 'hash': '0x' + '09' * 32, 'parentHash': blk['parentHash'], 'timestamp': 100}
        with self.assertRaises(rs.Negative) as cm:
            s.base_el_labels({'base': {'safe_l2': ref, 'finalized_l2': ref}})
        self.assertEqual(cm.exception.code, 'base-el-label-mismatch')


class TestJsonRpcEnvelope(Base):
    samples = 2

    def check(self, body):
        rc, r = self.env(patch=patch_for(('rollup', 'optimism_syncStatus'), Raw(200, json.dumps(body).encode()))).run()
        self.assertIncomplete(rc, r, 'base-heads-consistent', 'malformed-response')

    def test_missing_jsonrpc_version(self):
        self.check({'id': 1, 'result': {}})

    def test_wrong_request_id(self):
        self.check({'jsonrpc': '2.0', 'id': 2, 'result': {}})

    def test_result_and_error(self):
        self.check({'jsonrpc': '2.0', 'id': 1, 'result': {}, 'error': {'code': 1, 'message': 'x'}})

    def test_missing_result(self):
        self.check({'jsonrpc': '2.0', 'id': 1})


# Verbatim live refusal from our pruned reth (root readiness window 19:34, eth_getBlockByNumber 0).
LIVE_PRUNED = 'pruned history unavailable: requested 0, earliest available 26100000'


def rpc_error_raw(code, message):
    return Raw(200, json.dumps({'jsonrpc': '2.0', 'id': 1, 'error': {'code': code, 'message': message}}).encode())


def prune_genesis(*roles, code=4444, message=None, earliest=None):
    """The client refuses block 0 exactly as reth does once genesis bodies are pruned."""
    def p(role, key, res):
        if role in roles and key == 'eth_getBlockByNumber' and isinstance(res, dict) and res.get('number') == '0x0':
            n = earliest or (4000 if role == 'el' else 40000)   # below the synthetic finalized heads
            return rpc_error_raw(code, message or f'pruned history unavailable: requested 0, earliest available {n}')
        return res
    return p


def chained(*ps):
    def p(role, key, res):
        for f in ps:
            res = f(role, key, res)
        return res
    return p


class TestPrunedIdentity(Base):
    samples = 3

    def test_live_refusal_text_is_matched_exactly(self):
        self.assertEqual(rs.PRUNED_MSG.fullmatch(LIVE_PRUNED).groups(), ('0', '26100000'))
        for bad in (LIVE_PRUNED + ' ', 'Pruned history unavailable: requested 0, earliest available 26100000',
                    'pruned history unavailable: requested 0, earliest available 0',
                    'pruned history unavailable: requested 00, earliest available 5', 'header not found'):
            self.assertIsNone(rs.PRUNED_MSG.fullmatch(bad), bad)

    def test_pruned_l1_and_base_genesis_compensated_ready_only_with_coverage(self):
        e = self.env(patch=prune_genesis('el', 'base'))
        rc, r = e.run()
        self.assertIncomplete(rc, r, 'historical-coverage', 'coverage-receipt-absent')
        self.assertEqual({v['status'] for k, v in r['gates'].items() if k != 'historical-coverage'}, {'pass'}, r['gates'])
        l1 = r['gates']['l1-identity']['info']['identity']
        self.assertEqual((l1['basis'], l1['elEarliestAvailable']), ('pruned-el-genesis+mainnet-cl-paired-finalized', 4000))
        self.assertEqual(l1['pairedFinalized']['hash'], e.chain.l1hash(l1['pairedFinalized']['number']))
        base = r['gates']['base-identity']['info']['identity']
        self.assertEqual((base['basis'], base['elEarliestAvailable']),
                         ('pruned-base-genesis+mainnet-rollupConfig-derived-finalized', 40000))
        e2 = self.env(patch=prune_genesis('el', 'base'))
        rc, r = e2.run(*e2.coverage())
        self.assertEqual((rc, r['overall']), (0, 'READY'), r['gates'])
        self.assertIs(r['activationAuthorized'], False)

    def test_served_genesis_keeps_block_basis(self):
        rc, r = self.env().run()
        self.assertEqual(r['gates']['l1-identity']['info']['identity'], {'basis': 'el-genesis-block'})
        self.assertEqual(r['gates']['base-identity']['info']['identity'], {'basis': 'base-genesis-block'})

    def test_pruned_l1_still_requires_mainnet_identity(self):
        cases = {
            'chain id': patch_for(('el', 'eth_chainId'), '0x5'),
            'cl genesis': patch_for(('beacon', '/eth/v1/beacon/genesis'),
                                    lambda d: {'data': dict(d['data'], genesis_validators_root='0x' + '11' * 32)}),
            'cl spec': patch_for(('beacon', '/eth/v1/config/spec'), lambda d: {'data': dict(d['data'], DEPOSIT_CHAIN_ID='17000')}),
        }
        for name, p in cases.items():
            with self.subTest(name):
                rc, r = self.env(patch=chained(p, prune_genesis('el'))).run()
                self.assertFailed(rc, r, 'l1-identity', 'wrong-chain')

    def test_pruned_l1_el_not_serving_beacon_finalized_fails(self):
        p = patch_for(('beacon', '/eth/v1/beacon/blinded_blocks/finalized'), lambda d: {**d, 'data': {'message': {
            **d['data']['message'], 'body': {'execution_payload_header': {
                **d['data']['message']['body']['execution_payload_header'], 'block_hash': _h('other-chain')}}}}})
        rc, r = self.env(patch=chained(p, prune_genesis('el'))).run()
        self.assertFailed(rc, r, 'l1-identity', 'el-cl-finalized-mismatch')

    def test_pruned_l1_optimistic_finalized_fails(self):
        p = patch_for(('beacon', '/eth/v1/beacon/blinded_blocks/finalized'), lambda d: dict(d, execution_optimistic=True))
        rc, r = self.env(patch=chained(p, prune_genesis('el'))).run()
        self.assertFailed(rc, r, 'l1-identity', 'cl-optimistic')

    def test_finalized_below_live_earliest_is_incomplete(self):
        rc, r = self.env(patch=prune_genesis('el', message=LIVE_PRUNED)).run()
        self.assertIncomplete(rc, r, 'l1-identity', 'identity-pairing-unavailable')

    def test_other_rpc_errors_are_never_accepted(self):
        for code, msg in ((4444, 'pruned history unavailable: requested 0, earliest available 0'),
                          (4444, 'pruned history unavailable: requested 5, earliest available 4000'),
                          (4444, 'header not found'),
                          (4444, 'pruned history unavailable: requested 0, earliest available 4000; retry'),
                          (-32000, 'pruned history unavailable: requested 0, earliest available 4000'),
                          (-32601, 'the method eth_getBlockByNumber does not exist')):
            with self.subTest(code=code, msg=msg):
                rc, r = self.env(samples=2, patch=prune_genesis('el', code=code, message=msg)).run()
                self.assertIncomplete(rc, r, 'l1-identity', 'rpc-error')
                self.assertNotIn('info', r['gates']['l1-identity'])

    def test_null_genesis_is_incomplete_not_accepted(self):
        def p(role, key, res):
            return None if (role, key) == ('el', 'eth_getBlockByNumber') and isinstance(res, dict) and res['number'] == '0x0' else res
        rc, r = self.env(patch=p).run()
        self.assertIncomplete(rc, r, 'l1-identity', 'genesis-unavailable')

    def test_served_wrong_genesis_still_fails(self):
        for role, gate in (('el', 'l1-identity'), ('base', 'base-identity')):
            def p(r_, key, res, role=role):
                if (r_, key) == (role, 'eth_getBlockByNumber') and isinstance(res, dict) and res['number'] == '0x0':
                    return dict(res, hash=_h('other-genesis'))
                return res
            with self.subTest(role):
                rc, r = self.env(patch=p).run()
                self.assertFailed(rc, r, gate, 'wrong-chain')

    def test_pruned_identity_downgraded_when_pairing_later_fails(self):
        holder = {}

        def p(role, key, res):
            if (role, key) == ('beacon', '/eth/v1/beacon/blinded_blocks/finalized') and holder['chain'].k >= 3:
                h = res['data']['message']['body']['execution_payload_header']
                h['block_hash'] = _h('fork')
            return res
        e = self.env(samples=4, patch=chained(p, prune_genesis('el', 'base')))
        holder['chain'] = e.chain
        rc, r = e.run('--continue-on-fail', *e.coverage())
        self.assertFailed(rc, r, 'l1-finalized-paired', 'el-cl-finalized-mismatch')
        self.assertEqual((r['gates']['l1-identity']['status'], r['gates']['l1-identity'].get('code')),
                         ('incomplete', 'identity-basis-unconfirmed'))
        self.assertEqual(r['gates']['base-identity']['code'], 'identity-basis-unconfirmed')   # Base relies on L1

    def test_pruned_base_downgraded_when_l1_identity_fails(self):
        p = patch_for(('beacon', '/eth/v1/beacon/genesis'),
                      lambda d: {'data': dict(d['data'], genesis_validators_root='0x' + '11' * 32)})
        e = self.env(patch=chained(p, prune_genesis('el', 'base')))
        rc, r = e.run(*e.coverage())
        self.assertFailed(rc, r, 'l1-identity', 'wrong-chain')
        self.assertEqual((r['gates']['base-identity']['status'], r['gates']['base-identity'].get('code')),
                         ('incomplete', 'identity-basis-unconfirmed'))

    def test_pruned_base_still_requires_mainnet_identity(self):
        cases = {
            'chain id': patch_for(('base', 'eth_chainId'), '0x14a34'),
            'rollup l2 genesis': patch_for(('rollup', 'optimism_rollupConfig'),
                                           lambda d: {**d, 'genesis': {**d['genesis'], 'l2': {'hash': _h('sepolia'), 'number': 0}}}),
            'rollup chain id': patch_for(('rollup', 'optimism_rollupConfig'), lambda d: dict(d, l2_chain_id=84532)),
        }
        for name, p in cases.items():
            with self.subTest(name):
                rc, r = self.env(patch=chained(p, prune_genesis('base'))).run()
                self.assertFailed(rc, r, 'base-identity', 'wrong-chain')

    def test_pruned_base_el_not_serving_derived_finalized_fails(self):
        def p(role, key, res):
            if (role, key) == ('rollup', 'optimism_syncStatus'):
                res['finalized_l2']['hash'] = _h('not-ours')
            return res
        rc, r = self.env(patch=chained(p, prune_genesis('base'))).run()
        self.assertFailed(rc, r, 'base-identity', 'base-el-rollup-mismatch')

    def test_pruned_base_without_derived_heads_is_not_accepted(self):
        e = self.env(patch=prune_genesis('base'))
        e.chain.o['unsafe_only'] = True
        rc, r = e.run(*e.coverage())
        self.assertNotReady(rc, r)
        self.assertEqual((r['gates']['base-identity']['status'], r['gates']['base-identity']['code']),
                         ('incomplete', 'identity-pairing-unavailable'))
        rc, r = self.env(closed=('rollup',), patch=prune_genesis('base')).run()
        self.assertIncomplete(rc, r, 'base-identity', 'endpoint-unreachable')


class TestDecoderParity(unittest.TestCase):
    def test_matches_origin_extract(self):
        spec = importlib.util.spec_from_file_location('origin_extract', ORIGIN_EXTRACT)
        oe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(oe)
        c = Chain(2)
        for n in (49930, 49981, 50001):
            self.assertEqual(rs.decode_l1_info(c.l1info(n)), oe.decode_l1_info(c.l1info(n)))
        for bad in ('0x' + '00' * 164, c.l1info(49930)[:-2], 'zz'):
            with self.assertRaises(rs.Negative):
                rs.decode_l1_info(bad)
            with self.assertRaises(oe.Refusal):
                oe.decode_l1_info(bad)


if __name__ == '__main__':
    unittest.main(verbosity=2)
