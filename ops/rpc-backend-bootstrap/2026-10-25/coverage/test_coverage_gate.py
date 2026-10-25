"""Fixture tests for coverage_gate.py: a loopback fake L1 pair (EL JSON-RPC + beacon API) with real blobs.

KZGCHECK must point at the built kzgcheck binary; commitments in the fixture come from it, and every
mismatch case is detected by recomputing commitments, not by counting.
"""
import hashlib
import http.server
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import coverage_gate as cg  # noqa: E402

KZG = os.environ['KZGCHECK']
with open(KZG, 'rb') as _f:
    KZG_SHA = hashlib.file_digest(_f, 'sha256').hexdigest()
BATCHER = '0x5050f69a9786f081509234f1a7f4684b5e5b76c9'
OTHER = '0x1111111111111111111111111111111111111111'


def h32(tag, i):
    return '0x' + hashlib.sha256(f'{tag}:{i}'.encode()).hexdigest()


def make_blob(seed):
    out = bytearray(131072)
    for i in range(0, 131072, 32):
        out[i + 1:i + 32] = hashlib.sha256(f'{seed}-{i}'.encode()).digest()[1:]
    return '0x' + out.hex()


CURRENT = None
BLOBS = {k: make_blob(k) for k in 'ABCD'}
_k = cg.Kzg(KZG, KZG_SHA)
COMMIT = {k: _k.commitment(v)[0] for k, v in BLOBS.items()}
_k.close()
VH = {k: cg.kzg_to_versioned_hash(c) for k, c in COMMIT.items()}

FIRST, SAFE_ORIGIN, TIP_ORIGIN, FINAL, HEAD = 1000, 1004, 1006, 1008, 1010
MISSED_AFTER = 1002          # one empty slot between blocks 1002 and 1003
ZERO_BLOOM = '0x' + '00' * 256
EMPTY_OMMERS = '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347'


def make_tx(n, i, sender, to, vhs=()):
    t = {'type': '0x3' if vhs else '0x2', 'chainId': '0x1', 'nonce': hex(n * 10 + i), 'gas': '0x5208',
         'maxFeePerGas': '0x3b9aca00', 'maxPriorityFeePerGas': '0x1', 'to': to, 'value': '0x0', 'input': '0x',
         'accessList': [], 'r': '0x1', 's': '0x1', 'yParity': '0x0', 'v': '0x0', 'from': sender,
         'hash': h32('placeholder', n * 10 + i), 'blockNumber': hex(n), 'transactionIndex': hex(i)}
    if vhs:
        t.update({'maxFeePerBlobGas': '0x1', 'blobVersionedHashes': list(vhs)})
    return t


def make_receipt(t, i, logs=()):
    r = {'type': t['type'], 'status': '0x1', 'cumulativeGasUsed': hex(21000 * (i + 1)), 'logsBloom': ZERO_BLOOM,
         'logs': [dict(lg, blockNumber=t['blockNumber'], transactionIndex=hex(i), logIndex='0x0', removed=False, data='0x')
                  for lg in logs],
         'transactionHash': t['hash'], 'blockHash': h32('x', 0),
         'transactionIndex': hex(i), 'blockNumber': t['blockNumber'], 'gasUsed': '0x5208', 'effectiveGasPrice': '0x1',
         'from': t['from'], 'to': t['to'], 'contractAddress': None}
    if t['type'] == '0x3':
        r.update({'blobGasUsed': hex(131072 * len(t['blobVersionedHashes'])), 'blobGasPrice': '0x1'})
    return r


def seal(block, receipts, sealer):
    """Fill hashes/roots with values recomputed by kzgcheck block mode (alloy 2.4.1 consensus encodings)."""
    got, err = sealer.block_roots(block, receipts)
    assert got, err
    for t, h in zip(block['transactions'], got['txHashes']):
        t['hash'] = h
    for r, t in zip(receipts, block['transactions']):
        r['transactionHash'] = t['hash']
        for lg in r['logs']:
            lg['transactionHash'] = t['hash']
    block['transactionsRoot'], block['receiptsRoot'] = got['transactionsRoot'], got['receiptsRoot']
    got, err = sealer.block_roots(block, receipts)
    assert got, err
    block['hash'] = got['hash']
    for x in block['transactions'] + receipts + [lg for r in receipts for lg in r['logs']]:
        x['blockHash'] = got['hash']


class Chain:
    def __init__(self, logs_at=None):
        now = int(time.time())
        head_slot = (now - cg.GENESIS_TIME) // 12 - 1
        self.el, self.receipts, self.headers, self.blinded, self.blobs = {}, {}, {}, {}, {}
        slots, s = {}, head_slot
        for n in range(HEAD, FIRST - 1, -1):
            slots[n] = s
            s -= 2 if n == MISSED_AFTER + 1 else 1
        blob_keys = {1002: 'ABC', 1005: 'D'}
        sealer = cg.Kzg(KZG, KZG_SHA, 'block')
        parent = h32('el', FIRST - 1)
        for n in sorted(slots):
            sl = slots[n]
            txs = [make_tx(n, 0, OTHER, OTHER)]
            if n == 1002:
                txs += [make_tx(n, 1, BATCHER, cg.BATCH_INBOX, [VH['A'], VH['B']]), make_tx(n, 2, OTHER, OTHER, [VH['C']])]
            if n == 1005:
                txs += [make_tx(n, 1, BATCHER, cg.BATCH_INBOX, [VH['D']])]
            rcpts = [make_receipt(t, i, (logs_at or {}).get(n, []) if i == 0 else ()) for i, t in enumerate(txs)]
            blk = {'parentHash': parent, 'sha3Uncles': EMPTY_OMMERS, 'miner': '0x' + '00' * 20,
                   'stateRoot': h32('state', n), 'transactionsRoot': h32('x', 0), 'receiptsRoot': h32('x', 0),
                   'logsBloom': ZERO_BLOOM, 'difficulty': '0x0', 'number': hex(n), 'gasLimit': '0x2aea540',
                   'gasUsed': hex(21000 * len(txs)), 'timestamp': hex(cg.GENESIS_TIME + 12 * sl), 'extraData': '0x',
                   'mixHash': h32('mix', n), 'nonce': '0x0000000000000000', 'baseFeePerGas': '0x7',
                   'withdrawalsRoot': h32('wd', n), 'blobGasUsed': '0x0', 'excessBlobGas': '0x0',
                   'parentBeaconBlockRoot': h32('pbr', n), 'requestsHash': h32('req', n),
                   'hash': h32('x', 0), 'uncles': [], 'transactions': txs, 'size': '0x0'}
            seal(blk, rcpts, sealer)
            parent = blk['hash']
            self.el[n], self.receipts[n] = blk, rcpts
            self.headers[sl] = {'execution_optimistic': False, 'data': {'root': h32('cl', sl), 'canonical': True}}
            prev = slots.get(n - 1)
            self.blinded[sl] = {'data': {'message': {
                'slot': str(sl), 'parent_root': h32('cl', prev) if prev is not None else h32('cl', 'pre'),
                'body': {'execution_payload_header': {'block_hash': blk['hash']},
                         'blob_kzg_commitments': [COMMIT[k] for k in blob_keys.get(n, '')]}}}}
            self.blobs[sl] = {VH[k]: BLOBS[k] for k in blob_keys.get(n, '')}
        sealer.close()
        self.slots = slots
        self.syncing = {'is_syncing': False, 'is_optimistic': False, 'el_offline': False}
        self.el_syncing, self.cgc, self.head_optimistic = False, '64', False
        self.blob_status = {}

    def h(self, n):
        return self.el[n]['hash']

    def rpc(self, method, params):
        if method == 'eth_chainId':
            return '0x1'
        if method == 'eth_syncing':
            return self.el_syncing
        if method == 'eth_getBlockByNumber':
            tag = params[0]
            if tag == '0x0':
                return {'hash': cg.EL_GENESIS}
            n = {'latest': HEAD, 'finalized': FINAL}.get(tag) or int(tag, 16)
            b = self.el.get(n)
            return b if b is None or params[1] else dict(b, transactions=[t['hash'] for t in b['transactions']])
        if method == 'eth_getBlockReceipts':
            return self.receipts.get(int(params[0], 16))
        raise KeyError(method)

    def get(self, path, query):
        if path == '/eth/v1/beacon/genesis':
            return 200, {'data': {'genesis_validators_root': cg.CL_GVR, 'genesis_time': str(cg.GENESIS_TIME)}}
        if path == '/eth/v1/config/spec':
            return 200, {'data': {'DEPOSIT_CHAIN_ID': '1', 'SECONDS_PER_SLOT': '12', 'FULU_FORK_EPOCH': '411392'}}
        if path == '/eth/v1/node/syncing':
            return 200, {'data': self.syncing}
        if path == '/eth/v1/node/identity':
            return 200, {'data': {'metadata': {'custody_group_count': self.cgc}}}
        if path == '/eth/v2/beacon/blocks/head':
            return 200, {'execution_optimistic': self.head_optimistic, 'data': {'message': {'body': {
                'execution_payload': {'block_number': str(HEAD), 'block_hash': self.h(HEAD)}}}}}
        parts = path.strip('/').split('/')
        slot = int(parts[-1]) if parts[-1].isdigit() else None
        if path.startswith('/eth/v1/beacon/headers/') and slot in self.headers:
            return 200, self.headers[slot]
        if path.startswith('/eth/v1/beacon/blinded_blocks/') and slot in self.blinded:
            return 200, self.blinded[slot]
        if path.startswith('/eth/v1/beacon/blobs/') and slot in self.blobs:
            if slot in self.blob_status:
                return self.blob_status[slot]
            want = query.get('versioned_hashes', [])
            return 200, {'data': [self.blobs[slot][h] for h in want if h in self.blobs[slot]]}
        return 404, {'code': 404, 'message': 'NOT_FOUND'}


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, status, doc):
        body = json.dumps(doc).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self._send(200, {'jsonrpc': '2.0', 'id': 1, 'result': self.server.chain.rpc(req['method'], req['params'])})

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        st, doc = self.server.chain.get(u.path, urllib.parse.parse_qs(u.query))
        self._send(st, doc)


def origin(status='SAFE_HEAD_PERSISTED', safe=True, safe_origin_hash=None, tip_origin=TIP_ORIGIN):
    def lab(n, o, hsh=None):
        return {'number': n, 'hash': h32('l2', n), 'layout': 'jovian', 'sequenceNumber': 0, 'timestamp': 0,
                'batcher': BATCHER, 'l1Origin': {'number': o, 'hash': hsh or (CURRENT.h(o) if o in CURRENT.el else h32('el', o))}}
    return {'format': 'enclave-base-snapshot-origin/v1', 'status': status, 'chain': 'base-mainnet',
            'labels': {'tip': lab(600, tip_origin), 'safe': lab(500, SAFE_ORIGIN, safe_origin_hash) if safe else None,
                       'finalized': None},
            'source': {'tool': 'base reth db get (AccessRights::RO)', 'datadirReadOnlyMount': True}}


class GateTest(unittest.TestCase):
    def setUp(self):
        cg.SEQ_WINDOW, cg.CHANNEL_TIMEOUT_MAX = 4, 1   # fixture-sized windows; production constants are 3600/300
        self.rechain()
        self.srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.srv.chain = self.chain
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.srv.server_address[1]}'
        self.tmp = tempfile.TemporaryDirectory()

    def rechain(self, **kw):
        global CURRENT
        self.chain = CURRENT = Chain(**kw)
        if hasattr(self, 'srv'):
            self.srv.chain = self.chain

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()
        self.tmp.cleanup()

    def gate(self, doc=None, *extra):
        o = os.path.join(self.tmp.name, f'origin{time.monotonic_ns()}.json')
        out = os.path.join(self.tmp.name, f'verdict{time.monotonic_ns()}.json')
        with open(o, 'w') as f:
            json.dump(origin() if doc is None else doc, f)
        rc = cg.main(['--origin', o, '--el', self.url, '--beacon', self.url, '--kzg', KZG, '--kzg-sha256', KZG_SHA,
                      '--out', out, '--rps', '500', *extra])
        with open(out) as f:
            return rc, json.load(f)

    def refused(self, code, *args):
        rc, v = self.gate(*args)
        self.assertEqual((rc, v['verdict'], v['refusal']['code']), (3 if code != 'config' else 2, 'REFUSED', code), v.get('refusal'))
        self.assertIs(v['coverageVerifiedWritten'], False)
        return v

    def test_covered_with_missed_slot_and_commitment_matching(self):
        rc, v = self.gate()
        self.assertEqual((rc, v['verdict']), (0, 'COVERED'), v.get('refusal'))
        self.assertEqual((v['needFromBlock'], v['toBlock'], v['rule']), (FIRST, FINAL, 'safe-origin-minus-seq-window'))
        self.assertEqual(v['counts']['blocks'], FINAL - FIRST + 1)
        self.assertEqual(v['counts']['blobsVerified'], 3)          # A, B, D: batcher blobs only
        self.assertEqual(v['missedSlots'], [self.chain.slots[MISSED_AFTER] + 1])
        self.assertEqual(v['counts']['missingData'], 0)
        self.assertEqual(v['proposedBaseBootstrap']['blobSlot'], self.chain.slots[1002])
        self.assertEqual(v['proposedBaseBootstrap']['l1Block'], FIRST)
        self.assertEqual((v['proposedBaseBootstrap']['coverageVerifiedEligible'], v['proposedBaseBootstrap']['rootReviewRequired']), (True, True))

    def test_all_scope_checks_non_batcher_blobs(self):
        rc, v = self.gate(None, '--blob-scope', 'all')
        self.assertEqual((rc, v['counts']['blobsVerified']), (0, 4))

    def test_beacon_gap_is_missing_data_not_missed_slot(self):
        del self.chain.headers[self.chain.slots[1001]]
        v = self.refused('missing-data')
        self.assertEqual(v['missingData'][0]['kind'], 'beacon-block')
        self.assertNotIn(self.chain.slots[1001], v['missedSlots'])

    def test_blobs_unavailable(self):
        self.chain.blob_status[self.chain.slots[1005]] = (404, {'message': 'Insufficient data columns'})
        v = self.refused('missing-data')
        self.assertEqual(v['missingData'][0]['kind'], 'blobs')

    def test_right_count_wrong_blob_is_rejected(self):
        sl = self.chain.slots[1002]
        self.chain.blobs[sl] = {VH['A']: BLOBS['A'], VH['B']: BLOBS['C']}   # count matches, content does not
        self.refused('data-mismatch')

    def test_commitments_not_matching_el_versioned_hashes(self):
        self.chain.blinded[self.chain.slots[1005]]['data']['message']['body']['blob_kzg_commitments'] = [COMMIT['A']]
        self.refused('data-mismatch')

    def test_receipts_missing_or_mismatched(self):
        self.chain.receipts[1003] = None
        self.assertEqual(self.refused('missing-data')['missingData'][0]['kind'], 'receipts')
        self.chain.receipts[1003] = []                       # fewer receipts than transactions
        # The recomputed receipts root is checked before the count binding, so it is what fires.
        self.assertEqual(self.refused('data-mismatch')['mismatches'][0]['kind'], 'receipts-root')
        self.chain.receipts[1003] = [{'transactionHash': h32('x', 1), 'blockHash': h32('el', 1003), 'logs': []}]
        self.refused('data-mismatch')

    def test_stale_optimistic_syncing_and_custody(self):
        self.chain.syncing = {'is_syncing': False, 'is_optimistic': True, 'el_offline': False}
        self.refused('cl-optimistic')
        self.chain.syncing['is_optimistic'] = False
        self.chain.head_optimistic = True
        self.refused('cl-optimistic')
        self.chain.head_optimistic = False
        self.chain.el_syncing = {'currentBlock': '0x1'}
        self.refused('el-syncing')
        self.chain.el_syncing = False
        self.chain.cgc = '4'
        self.refused('insufficient-custody')
        self.chain.cgc = '64'
        self.chain.el[HEAD]['timestamp'] = hex(int(time.time()) - 600)
        self.refused('stale-head')

    def test_unsafe_only_origin_refused_unless_tip_rule(self):
        doc = origin('NO_PERSISTED_SAFE_HEAD', safe=False)
        self.refused('no-persisted-safe-head', doc)
        rc, v = self.gate(doc, '--accept-tip-walk-rule')
        self.assertEqual((rc, v['verdict'], v['needFromBlock']),
                         (4, 'COVERED_UNDER_TIP_WALK_RULE_ROOT_DECISION_REQUIRED', TIP_ORIGIN - 4 - 1 - 1))
        self.assertIs(v['proposedBaseBootstrap']['coverageVerifiedEligible'], False)
        self.assertIsNone(doc['labels']['safe'])
        self.assertTrue(v['rule'].startswith('tip-walk-rule'))
        self.refused('origin-format', origin('SAFE_HEAD_PERSISTED', safe=False))
        bad = origin()
        bad['source']['datadirReadOnlyMount'] = False
        self.refused('origin-provenance', bad)

    def test_origin_not_canonical_or_not_finalized(self):
        self.refused('origin-not-canonical', origin(safe_origin_hash=h32('fork', SAFE_ORIGIN)))
        self.refused('origin-not-finalized', origin(tip_origin=FINAL + 1) | {'labels': origin()['labels'] | {
            'safe': origin()['labels']['safe'] | {'l1Origin': {'number': FINAL + 1, 'hash': h32('el', FINAL + 1)}},
            'tip': origin()['labels']['tip'] | {'l1Origin': {'number': FINAL + 1, 'hash': h32('el', FINAL + 1)}}}})
        self.refused('range-not-finalized', None, '--to-block', str(HEAD))

    def test_discontinuities(self):
        self.chain.el[1004]['parentHash'] = h32('fork', 1003)
        self.refused('el-discontinuity')
        self.chain.el[1004]['parentHash'] = self.chain.h(1003)
        self.chain.blinded[self.chain.slots[1004]]['data']['message']['parent_root'] = h32('fork', 0)
        self.refused('cl-discontinuity')
        self.chain.blinded[self.chain.slots[1004]]['data']['message']['parent_root'] = h32('cl', self.chain.slots[1003])
        self.chain.blinded[self.chain.slots[1006]]['data']['message']['body']['execution_payload_header']['block_hash'] = h32('x', 0)
        self.refused('el-cl-mismatch')

    def test_batcher_change_in_range(self):
        self.rechain(logs_at={1003: [{'address': cg.SYSTEM_CONFIG, 'topics': [
            cg.CONFIG_UPDATE_TOPIC, '0x' + '00' * 32, cg.UPDATE_TYPE_BATCHER]}]})
        self.refused('batcher-changed-in-range')

    def test_receipt_content_tamper_fails_receipts_root(self):
        self.chain.receipts[1004][0]['status'] = '0x0'           # same count, same hashes, different content
        self.assertEqual(self.refused('data-mismatch')['mismatches'][0]['kind'], 'receipts-root')

    def test_consistent_blob_swap_fails_transactions_root(self):
        # EL tx claims, beacon commitments and served blob all agree on C: only the tx root exposes the lie.
        sl = self.chain.slots[1005]
        self.chain.el[1005]['transactions'][1]['blobVersionedHashes'] = [VH['C']]
        self.chain.blinded[sl]['data']['message']['body']['blob_kzg_commitments'] = [COMMIT['C']]
        self.chain.blobs[sl] = {VH['C']: BLOBS['C']}
        self.assertEqual(self.refused('data-mismatch')['mismatches'][0]['kind'], 'transactions-root')

    def test_header_field_tamper_fails_header_hash(self):
        self.chain.el[1006]['stateRoot'] = h32('evil', 1)
        self.assertEqual(self.refused('data-mismatch')['mismatches'][0]['kind'], 'header-hash')

    def test_bounds(self):
        self.refused('range-too-large', None, '--max-blocks', '3')
        self.refused('request-budget-exhausted', None, '--max-requests', '20')
        self.chain.blob_status[self.chain.slots[1002]] = (200, {'data': [BLOBS['A']] * 5})
        rc, v = self.gate(None, '--max-body', str(1 << 20))
        self.assertEqual(v['refusal']['code'], 'response-too-large')   # 5 blobs of 256 KiB hex exceed 1 MiB
        with self.assertRaises(SystemExit):
            self.gate(None, '--max-blocks', str(cg.HARD_MAX_BLOCKS + 1))

    def test_endpoint_policy_and_kzg_pin(self):
        o = os.path.join(self.tmp.name, 'o.json')
        with open(o, 'w') as f:
            json.dump(origin(), f)
        for el, sha in (('http://192.0.2.1:8545', KZG_SHA), ('https://127.0.0.1:1', KZG_SHA), (self.url, '0' * 64)):
            out = os.path.join(self.tmp.name, f'v{time.monotonic_ns()}.json')
            rc = cg.main(['--origin', o, '--el', el, '--beacon', self.url, '--kzg', KZG, '--kzg-sha256', sha, '--out', out])
            with open(out) as f:
                self.assertEqual((rc, json.load(f)['refusal']['code']), (2, 'config'))


if __name__ == '__main__':
    unittest.main()
