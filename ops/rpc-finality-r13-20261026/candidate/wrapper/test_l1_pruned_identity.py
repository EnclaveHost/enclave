"""l1_ready with a pruned L1 EL genesis (reth EIP-4444), exercised through the wrapper's REAL rpc()/beacon()/beacon_doc()
parsing: only urllib.request.urlopen is faked, as a loopback EL (18645) and Lighthouse (15052) serving JSON documents.

Offline unit evidence only. It is not a live startup and not an L1 holder readiness observation."""
import io
import json
import time
import unittest
import urllib.error
from unittest.mock import patch

import test_chain_service as T   # the existing wrapper suite's module fixture: loads ./chain_service.py

c = T.c
# Verbatim refusal from our own guest EL 18645 (root 08:24), eth_getBlockByNumber(0).
LIVE_PRUNED = 'pruned history unavailable: requested 0, earliest available 26100000'
GENESIS = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
GVR = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'


def h32(n, tag='a'):
    return '0x' + (tag + format(n, 'x')).rjust(64, '0')


class Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        self.close()


class World:
    """Mainnet-shaped L1 pair: EL earliest 26100000, finalized 26100500 (~13 min old), head 26100564 (~24 s old)."""

    def __init__(self, earliest=26100000, genesis_reply=None):
        now = int(time.time())
        self.fin, self.head = 26100500, 26100564
        self.blocks = {n: {'number': hex(n), 'hash': h32(n), 'parentHash': h32(n - 1),
                           'timestamp': hex(now - 24 - 12 * (self.head - n))} for n in range(self.fin - 2, self.head + 1)}
        self.genesis_reply = genesis_reply or {'error': {'code': 4444, 'message':
                                                         f'pruned history unavailable: requested 0, earliest available {earliest}'}}
        self.el = {'eth_chainId': {'result': '0x1'}, 'eth_syncing': {'result': False}}
        fb = self.blocks[self.fin]
        self.finalized_doc = {'execution_optimistic': False, 'finalized': True, 'data': {'message': {'slot': '13000000', 'body': {
            'execution_payload_header': {'block_number': str(self.fin), 'block_hash': fb['hash'], 'parent_hash': fb['parentHash'],
                                         'timestamp': str(int(fb['timestamp'], 16))}}}}}
        self.cl = {
            '/eth/v1/beacon/genesis': {'data': {'genesis_validators_root': GVR, 'genesis_time': '1606824023'}},
            '/eth/v1/config/spec': {'data': {'DEPOSIT_CHAIN_ID': '1', 'SECONDS_PER_SLOT': '12', 'FULU_FORK_EPOCH': '411392'}},
            '/eth/v1/node/version': {'data': {'version': 'Lighthouse/v8.3.2-abcdef0/x86_64-linux'}},
            '/eth/v1/node/syncing': {'data': {'is_syncing': False, 'is_optimistic': False, 'el_offline': False}},
            '/eth/v1/beacon/blinded_blocks/finalized': self.finalized_doc,
            '/eth/v2/beacon/blocks/head': {'data': {'message': {'body': {'execution_payload': {
                'block_number': str(self.head), 'block_hash': self.blocks[self.head]['hash']}}}}},
            '/eth/v1/node/identity': {'data': {'metadata': {'custody_group_count': '64'}}},
            '/eth/v1/beacon/headers/head': {'data': {'header': {'message': {'slot': '13000064'}}}},
            '/eth/v2/beacon/blocks/13000063': {'data': {'message': {'body': {'blob_kzg_commitments': ['0x01', '0x02']}}}},
            '/eth/v1/beacon/blobs/13000063': {'data': ['b1', 'b2']}}
        self.calls = []

    def el_reply(self, method, params):
        if method in self.el:
            return self.el[method]
        assert method == 'eth_getBlockByNumber', method
        tag = params[0]
        if tag == '0x0':
            return self.genesis_reply
        n = {'latest': self.head, 'finalized': self.fin}.get(tag)
        n = int(tag, 16) if n is None else n
        return {'result': self.blocks.get(n)}

    def urlopen(self, req, timeout=None):
        if isinstance(req, str):
            assert req.startswith('http://127.0.0.1:15052/'), req
            path = req[len('http://127.0.0.1:15052'):]
            self.calls.append(('cl', path))
            if path not in self.cl:
                raise urllib.error.HTTPError(req, 404, 'not found', {}, None)
            return Resp(json.dumps(self.cl[path]).encode())
        assert req.full_url == 'http://127.0.0.1:18645', req.full_url
        body = json.loads(req.data)
        self.calls.append(('el', body['method'], body['params']))
        return Resp(json.dumps({'jsonrpc': '2.0', 'id': 1, **self.el_reply(body['method'], body['params'])}).encode())

    def ready(self):
        with patch.object(c.urllib.request, 'urlopen', side_effect=self.urlopen):
            return c.l1_ready()


class PrunedIdentityTests(unittest.TestCase):
    def refused(self, w, pattern):
        with self.assertRaisesRegex(AssertionError, pattern):
            w.ready()

    # ---- the production blocker -------------------------------------------------------------------------------------
    def test_live_pruned_refusal_ready_on_compensated_basis(self):
        w = World()
        self.assertEqual(w.genesis_reply['error']['message'], LIVE_PRUNED)
        r = w.ready()
        self.assertEqual((r['l1Block'], r['l1Finalized'], r['blobSlot']), (26100564, 26100500, 13000063))
        self.assertEqual(r['l1Identity'], {'basis': 'pruned-el-genesis+mainnet-cl-paired-finalized',
                                           'elEarliestAvailable': 26100000,
                                           'pairedFinalized': {'number': 26100500, 'hash': h32(26100500)}})
        # every pre-existing gate still ran: syncing, head/finalized tags, node syncing, head pairing, custody, blobs
        seen = {x[1] for x in w.calls}
        for p in ('eth_chainId', 'eth_syncing', '/eth/v1/beacon/genesis', '/eth/v1/config/spec', '/eth/v1/node/version',
                  '/eth/v1/node/syncing', '/eth/v1/beacon/blinded_blocks/finalized', '/eth/v2/beacon/blocks/head',
                  '/eth/v1/node/identity', '/eth/v1/beacon/blobs/13000063'):
            self.assertIn(p, seen)
        self.assertIn(('el', 'eth_getBlockByNumber', [hex(26100500), False]), w.calls)

    def test_served_genesis_block_keeps_original_basis(self):
        w = World(genesis_reply={'result': {'hash': GENESIS, 'number': '0x0'}})
        r = w.ready()
        self.assertEqual(r['l1Identity'], {'basis': 'el-genesis-block'})
        self.assertNotIn(('cl', '/eth/v1/beacon/blinded_blocks/finalized'), w.calls)

    def test_main_prints_pruned_readiness(self):
        w = World()
        with patch.object(c.urllib.request, 'urlopen', side_effect=w.urlopen), patch('builtins.print') as out:
            c.main(['l1-ready'])
        self.assertEqual(json.loads(out.call_args.args[0])['l1Identity']['elEarliestAvailable'], 26100000)

    # ---- strict refusal recognition ---------------------------------------------------------------------------------
    def test_only_exact_pruned_genesis_refusal_is_recognised(self):
        for code, msg in ((4444, 'pruned history unavailable: requested 0, earliest available 0'),
                          (4444, 'pruned history unavailable: requested 00, earliest available 26100000'),
                          (4444, 'pruned history unavailable: requested 5, earliest available 26100000'),
                          (4444, LIVE_PRUNED + '; retry'), (4444, ' ' + LIVE_PRUNED), (4444, LIVE_PRUNED.upper()),
                          (4444, 'pruned history unavailable: requested 0, earliest available 026100000'),
                          (4444, 'header not found'), (-32000, LIVE_PRUNED), (-32602, LIVE_PRUNED), (44440, LIVE_PRUNED)):
            with self.subTest(code=code, msg=msg):
                self.refused(World(genesis_reply={'error': {'code': code, 'message': msg}}), 'local RPC failed')

    def test_malformed_error_objects_are_plain_refusals(self):
        for err in ({'code': True, 'message': LIVE_PRUNED}, {'code': '4444', 'message': LIVE_PRUNED},
                    {'code': 4444.0, 'message': LIVE_PRUNED}, {'code': 4444}, {'code': 4444, 'message': None}, 'pruned', None):
            with self.subTest(err=err):
                w = World(genesis_reply={'error': err})
                with self.assertRaisesRegex(AssertionError, 'local RPC failed') as cm:
                    w.ready()
                self.assertNotIsInstance(cm.exception, c.RpcError)
        # an envelope with BOTH result and error is not an error object to match on
        self.refused(World(genesis_reply={'result': None, 'error': {'code': 4444, 'message': LIVE_PRUNED}}), 'local RPC failed')

    def test_null_or_wrong_genesis_refused(self):
        for reply in ({'result': None}, {'result': {'hash': h32(0)}}, {'result': {}}, {'result': GENESIS}):
            with self.subTest(reply=reply):
                self.refused(World(genesis_reply=reply), 'wrong EL genesis')

    def test_pruned_refusal_does_not_affect_other_calls(self):
        # the same 4444 refusal anywhere else (here: the EL 'latest' tag) is still just a failed local RPC
        w = World()
        w.el_reply, orig = (lambda m, p: {'error': {'code': 4444, 'message': LIVE_PRUNED}} if p[:1] == ['latest'] else orig(m, p)), w.el_reply
        self.refused(w, 'local RPC failed')

    # ---- pinned mainnet identity still required ---------------------------------------------------------------------
    def test_pruned_still_requires_chain_and_cl_identity(self):
        cases = (('el', 'eth_chainId', {'result': '0x2105'}, ''),
                 ('cl', '/eth/v1/beacon/genesis', {'data': {'genesis_validators_root': h32(1), 'genesis_time': '1606824023'}}, 'wrong CL genesis'),
                 ('cl', '/eth/v1/beacon/genesis', {'data': {'genesis_validators_root': GVR, 'genesis_time': '1606824024'}}, 'wrong CL genesis'),
                 ('cl', '/eth/v1/beacon/genesis', {'data': {'genesis_validators_root': GVR}}, 'wrong CL genesis'),
                 ('cl', '/eth/v1/config/spec', {'data': {'DEPOSIT_CHAIN_ID': '17000', 'SECONDS_PER_SLOT': '12', 'FULU_FORK_EPOCH': '411392'}}, 'wrong mainnet spec'),
                 ('cl', '/eth/v1/node/version', {'data': {'version': 'Lighthouse/v8.3.1'}}, 'wrong CL version'))
        for side, key, val, pat in cases:
            with self.subTest(key=key, val=val):
                w = World()
                (w.el if side == 'el' else w.cl)[key] = val
                self.refused(w, pat)

    # ---- compensating basis: non-optimistic, finalized, fresh, retained, paired --------------------------------------
    def test_optimistic_or_unflagged_cl_finalized_refused(self):
        for k, v, pat in (('execution_optimistic', True, 'optimistic'), ('execution_optimistic', None, 'optimistic'),
                          ('execution_optimistic', 'false', 'optimistic'), ('finalized', False, 'not flagged finalized'),
                          ('finalized', None, 'not flagged finalized'), ('finalized', 1, 'not flagged finalized')):
            with self.subTest(k=k, v=v):
                w = World()
                if v is None:
                    del w.finalized_doc[k]
                else:
                    w.finalized_doc[k] = v
                self.refused(w, pat)

    def test_unpaired_finalized_refused(self):
        for field, val in (('block_hash', h32(1, 'b')), ('parent_hash', h32(2, 'b')), ('timestamp', str(int(time.time()) - 600))):
            with self.subTest(field=field):
                w = World()
                w.finalized_doc['data']['message']['body']['execution_payload_header'][field] = val
                self.refused(w, 'finalized mismatch')
        w = World()                              # our EL serves its finalized tag but no block at that height by number
        w.el_reply, orig = (lambda m, p: {'result': None} if p[:1] == [hex(w.fin)] else orig(m, p)), w.el_reply
        self.refused(w, 'finalized mismatch')
        w = World()
        w.blocks[w.fin]['number'] = hex(w.fin + 1)
        self.refused(w, 'finalized mismatch')

    def test_malformed_cl_finalized_refused(self):
        for mutate in (lambda h: h.pop('block_hash'), lambda h: h.update(block_number='0x18e5c14'),
                       lambda h: h.update(block_number=26100500), lambda h: h.update(block_hash='0xabc'),
                       lambda h: h.update(timestamp='-1')):
            w = World()
            mutate(w.finalized_doc['data']['message']['body']['execution_payload_header'])
            with self.subTest(header=w.finalized_doc['data']['message']['body']['execution_payload_header']):
                self.refused(w, 'malformed')
        w = World()
        w.finalized_doc['data'] = {'message': {'body': {}}}
        self.refused(w, 'malformed beacon finalized')
        w = World()
        w.cl['/eth/v1/beacon/blinded_blocks/finalized'] = {'execution_optimistic': False, 'finalized': True, 'data': []}
        self.refused(w, 'malformed beacon response')

    def test_earliest_above_cl_finalized_refused(self):
        self.refused(World(earliest=26100501), 'below EL earliest available')
        self.assertEqual(World(earliest=26100500).ready()['l1Identity']['elEarliestAvailable'], 26100500)

    def test_cl_finalized_above_el_finalized_refused(self):
        w = World()
        w.el_reply, orig = (lambda m, p: {'result': w.blocks[w.fin - 1]} if p[:1] == ['finalized'] else orig(m, p)), w.el_reply
        self.refused(w, 'above EL finalized')

    def test_stale_cl_finalized_refused(self):
        # the beacon finalized payload (paired, below a fresh EL finalized tag) is itself over an hour old
        w = World()
        stale, b = int(time.time()) - 3700, w.blocks[w.fin - 1]
        b['timestamp'] = hex(stale)
        w.finalized_doc['data']['message']['body']['execution_payload_header'].update(
            block_number=str(w.fin - 1), block_hash=b['hash'], parent_hash=b['parentHash'], timestamp=str(stale))
        self.refused(w, 'finalized stale')
        b['timestamp'] = hex(stale + 200)        # the same shape, fresh: accepted (the refusal above is the age)
        w.finalized_doc['data']['message']['body']['execution_payload_header']['timestamp'] = str(stale + 200)
        self.assertEqual(w.ready()['l1Identity']['pairedFinalized']['number'], w.fin - 1)

    # ---- every pre-existing freshness/sync/pairing/blob gate still applies under the pruned basis ---------------------
    def test_existing_gates_still_apply_when_pruned(self):
        def el_syncing(w): w.el['eth_syncing'] = {'result': {'currentBlock': '0x1'}}
        def head_stale(w): w.blocks[w.head]['timestamp'] = hex(int(time.time()) - 600)
        def el_fin_stale(w):
            w.el_reply, orig = (lambda m, p: {'result': dict(w.blocks[w.fin], timestamp=hex(int(time.time()) - 4000))}
                                if p[:1] == ['finalized'] else orig(m, p)), w.el_reply
        def cl_optimistic(w): w.cl['/eth/v1/node/syncing']['data']['is_optimistic'] = True
        def cl_syncing(w): w.cl['/eth/v1/node/syncing']['data']['is_syncing'] = True
        def el_offline(w): w.cl['/eth/v1/node/syncing']['data']['el_offline'] = True
        def head_unpaired(w): w.cl['/eth/v2/beacon/blocks/head']['data']['message']['body']['execution_payload']['block_hash'] = h32(9, 'c')
        def custody(w): w.cl['/eth/v1/node/identity']['data']['metadata']['custody_group_count'] = '4'
        def blobs(w): w.cl['/eth/v1/beacon/blobs/13000063']['data'] = ['b1']
        def no_blobs(w): del w.cl['/eth/v2/beacon/blocks/13000063']
        for f, pat in ((el_syncing, 'still syncing'), (head_stale, 'head stale'), (el_fin_stale, 'finality stale'),
                       (cl_optimistic, 'consensus not ready'), (cl_syncing, 'consensus not ready'), (el_offline, 'consensus not ready'),
                       (head_unpaired, 'execution/consensus mismatch'), (custody, 'cannot reconstruct blobs'),
                       (blobs, 'blob data unavailable'), (no_blobs, 'no recent blob-carrying block')):
            with self.subTest(gate=f.__name__):
                w = World()
                f(w)
                self.refused(w, pat)


if __name__ == '__main__':
    unittest.main()
