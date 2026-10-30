#!/usr/bin/env python3
"""Read-only L1 coverage gate for starting Base v1.5.1 from an extracted snapshot.

Inputs: the origin document from origin_extract.py, the paired local L1 EL (reth) and CL (Lighthouse)
HTTP endpoints (loopback only), and the kzgcheck binary (c-kzg 2.1.8 as pinned by base v1.5.1).

Required L1 range (all block numbers, never timestamps):
  need_from = safe.l1Origin.number - SEQ_WINDOW (3600)                      [rule: safe-origin-minus-seq-window]
  This is a superset of what Base v1.5.1 actually re-reads: the restart safe head is at or above the labeled
  safe (engine/src/sync/mod.rs safe walk) and derivation restarts channel_timeout (<=300) L1 blocks below its
  origin (derive/src/pipeline/core.rs initial_reset).
  Without a persisted safe label the gate REFUSES unless --accept-tip-walk-rule is given, in which case
  need_from = min(tip.l1Origin - SEQ_WINDOW - 1, finalized.l1Origin if present) - 300 (the same source rules
  applied to the unsafe tip), and the verdict records that weaker evidence class.
  to_block  = the L1 EL 'finalized' block at gate start (or --to-block, which must not exceed it).

For every L1 block in [need_from, to_block] the gate checks: the EL block exists and parent-hash links to the
previous one; eth_getBlockReceipts returns exactly one receipt per transaction in order; the beacon block at
the block's slot is canonical, parent-root links to the previous non-empty slot, and commits to this EL hash.
Empty slots between two linked beacon blocks are classified 'missedSlots' (proved by parent_root linkage);
any slot carrying an EL block whose beacon block, receipts or blobs cannot be served is 'missingData'.
For batcher blob transactions (to=batch inbox, from=batcher; or every blob with --blob-scope all) the gate
requires: the beacon block's KZG commitments hash (EIP-4844 kzg_to_versioned_hash) to exactly the EL
transactions' blobVersionedHashes, and each blob served by /eth/v1/beacon/blobs/{slot}?versioned_hashes=...
(Base's own call) recomputes via kzgcheck to a commitment hashing to a requested versioned hash.

For every block the EL's claims are recomputed by kzgcheck (alloy 2.4.1): keccak header hash, transactions root
and receipts root from the 2718 encodings; any difference is a mismatch.

Never writes chain.json / coverageVerified. Exit 0 = COVERED (safe-label rule), 4 = covered only under the explicit
tip-walk rule (root decision required, never eligible by itself), 3 = REFUSED, 2 = usage/config error.
"""
import argparse
import hashlib
import ipaddress
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FORMAT = 'enclave-base-l1-coverage-verdict/v1'
SEQ_WINDOW = 3600                 # base mainnet seq_window_size (common/chains/src/config.rs)
CHANNEL_TIMEOUT_MAX = 300         # pre-Granite channel_timeout; post-Granite is 50 (conservative)
GENESIS_TIME = 1606824023
SECONDS_PER_SLOT = 12
EL_GENESIS = '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3'
CL_GVR = '0x4b363db94e286120d76eb905340fdd4e54bfe9f06bf33ff6cf5ad27f511bfe95'
BATCH_INBOX = '0xff00000000000000000000000000000000008453'
SYSTEM_CONFIG = '0x73a79fab69143498ed3712e519a88a918e1f4072'
CONFIG_UPDATE_TOPIC = '0x1d2b0bda21d56b8bd12d4f94ebacffdfb35f5e226f84b461103bb8beab6353be'
UPDATE_TYPE_BATCHER = '0x' + '00' * 32
HARD_MAX_BLOCKS = 30000
LIST_CAP = 100
H32 = re.compile(r'0x[0-9a-f]{64}')


class Refuse(Exception):
    def __init__(self, code, detail):
        super().__init__(f'{code}: {detail}')
        self.code, self.detail = code, detail


def _loopback(url):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'http' or u.username or u.password or u.query or u.fragment:
        raise ValueError(f'{url}: only plain http://loopback:port endpoints are allowed')
    host = u.hostname or ''
    if host != 'localhost' and not ipaddress.ip_address(host).is_loopback:
        raise ValueError(f'{url}: endpoint must be loopback')
    return url.rstrip('/')


class Client:
    """Bounded HTTP: per-request timeout, response byte cap, request budget and minimum spacing."""

    def __init__(self, el, beacon, timeout, max_requests, rps, max_body):
        self.el, self.beacon = _loopback(el), _loopback(beacon)
        self.timeout, self.max_requests, self.max_body = timeout, max_requests, max_body
        self.interval = 1.0 / rps
        self.requests, self.bytes, self._last = 0, 0, 0.0
        self._opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _fetch(self, req):
        if self.requests >= self.max_requests:
            raise Refuse('request-budget-exhausted', f'more than {self.max_requests} requests needed')
        wait = self._last + self.interval - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()
        self.requests += 1
        try:
            with self._opener.open(req, timeout=self.timeout) as r:
                status, body = r.status, r.read(self.max_body + 1)
        except urllib.error.HTTPError as e:
            with e:
                status, body = e.code, e.read(65536)
        except (urllib.error.URLError, OSError) as e:
            raise Refuse('endpoint-unreachable', f'{req.full_url}: {e}')
        self.bytes += len(body)
        if len(body) > self.max_body:
            raise Refuse('response-too-large', f'{req.full_url}: over {self.max_body} bytes')
        return status, body

    def rpc(self, method, params):
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode()
        st, raw = self._fetch(urllib.request.Request(self.el, body, {'Content-Type': 'application/json'}))
        try:
            doc = json.loads(raw)
        except ValueError:
            raise Refuse('el-bad-response', f'{method}: HTTP {st}, not JSON')
        if st != 200 or 'error' in doc or 'result' not in doc:
            return False, doc.get('error') if isinstance(doc, dict) else st
        return True, doc['result']

    def must(self, method, params):
        ok, res = self.rpc(method, params)
        if not ok:
            raise Refuse('el-rpc-error', f'{method}{params}: {res}')
        return res

    def bn(self, path):
        st, raw = self._fetch(urllib.request.Request(self.beacon + path, headers={'Accept': 'application/json'}))
        try:
            doc = json.loads(raw) if raw else {}
        except ValueError:
            doc = {'message': raw[:200].decode('utf-8', 'replace')}
        return st, doc


def kzg_to_versioned_hash(commitment_hex):
    c = bytes.fromhex(commitment_hex[2:])
    if len(c) != 48:
        raise ValueError('commitment is not 48 bytes')
    return '0x01' + hashlib.sha256(c).hexdigest()[2:]


class Kzg:
    """kzgcheck (c-kzg 2.1.8 + alloy 2.4.1 as pinned by base v1.5.1): blob commitments and block roots."""

    def __init__(self, path, sha256, mode='blob'):
        with open(path, 'rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != sha256:
                raise ValueError('kzgcheck binary differs from --kzg-sha256')
        self.p = subprocess.Popen([path, mode], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  env={'PATH': '/usr/bin:/bin'})

    def _ask(self, payload, limit):
        self.p.stdin.write(payload + b'\n')
        self.p.stdin.flush()
        return self.p.stdout.readline(limit).decode().strip()

    def commitment(self, blob_hex):
        line = self._ask(blob_hex.encode(), 256)
        if not line.startswith('OK 0x'):
            return None, line or 'kzgcheck exited'
        return line[3:], None

    def block_roots(self, block, receipts):
        """Header hash, transactions root, receipts root and tx hashes recomputed from consensus encodings."""
        line = self._ask(json.dumps({'block': block, 'receipts': receipts}).encode(), 4 << 20)
        if not line.startswith('OK {'):
            return None, line[:200] or 'kzgcheck exited'
        return json.loads(line[3:]), None

    def close(self):
        self.p.stdin.close()
        self.p.wait(10)
        self.p.stdout.close()


def _h(v):
    return int(v, 16) if isinstance(v, str) else int(v)


def required_range(origin, accept_tip_rule):
    if not isinstance(origin, dict) or origin.get('format') != 'enclave-base-snapshot-origin/v1':
        raise Refuse('origin-format', 'origin document is not enclave-base-snapshot-origin/v1')
    src = origin.get('source') or {}
    if src.get('datadirReadOnlyMount') is not True or not str(src.get('tool', '')).startswith('base reth db get'):
        raise Refuse('origin-provenance', 'origin was not extracted read-only with the pinned client tooling')
    labels = origin.get('labels') or {}
    tip, safe, fin = labels.get('tip'), labels.get('safe'), labels.get('finalized')
    for name, lab in (('tip', tip), ('safe', safe), ('finalized', fin)):
        if lab is None:
            continue
        o = lab.get('l1Origin') or {}
        if not (isinstance(o.get('number'), int) and isinstance(o.get('hash'), str) and H32.fullmatch(o['hash'])):
            raise Refuse('origin-format', f'{name}.l1Origin malformed')
    if tip is None:
        raise Refuse('origin-format', 'tip label missing')
    if origin.get('status') == 'SAFE_HEAD_PERSISTED':
        if safe is None:
            raise Refuse('origin-format', 'status claims a persisted safe head but labels.safe is absent')
        if safe['number'] > tip['number'] or safe['l1Origin']['number'] > tip['l1Origin']['number']:
            raise Refuse('origin-inconsistent', 'safe label is above the tip')
        return safe['l1Origin']['number'] - SEQ_WINDOW, 'safe-origin-minus-seq-window', safe
    if origin.get('status') != 'NO_PERSISTED_SAFE_HEAD' or safe is not None:
        raise Refuse('origin-format', f'unknown origin status {origin.get("status")!r}')
    if not accept_tip_rule:
        raise Refuse('no-persisted-safe-head',
                     'snapshot persists no safe label; an unsafe tip alone is not accepted without --accept-tip-walk-rule')
    lo = tip['l1Origin']['number'] - SEQ_WINDOW - 1
    if fin is not None:
        lo = min(lo, fin['l1Origin']['number'])
    return lo - CHANNEL_TIMEOUT_MAX, 'tip-walk-rule (no persisted safe; source-derived)', tip


def l1_ready(c, now, max_head_age, max_final_age, min_cgc):
    if c.must('eth_chainId', []) != '0x1':
        raise Refuse('wrong-chain', 'EL chainId is not 1')
    g = c.must('eth_getBlockByNumber', ['0x0', False])
    if not g or g.get('hash') != EL_GENESIS:
        raise Refuse('wrong-chain', 'EL genesis hash mismatch')
    st, gen = c.bn('/eth/v1/beacon/genesis')
    if st != 200 or gen.get('data', {}).get('genesis_validators_root') != CL_GVR \
            or int(gen['data'].get('genesis_time', -1)) != GENESIS_TIME:
        raise Refuse('wrong-chain', 'CL genesis mismatch')
    st, spec = c.bn('/eth/v1/config/spec')
    sd = spec.get('data', {}) if st == 200 else {}
    if sd.get('DEPOSIT_CHAIN_ID') != '1' or sd.get('SECONDS_PER_SLOT') != '12' or sd.get('FULU_FORK_EPOCH') != '411392':
        raise Refuse('wrong-chain', 'CL spec is not mainnet/Fulu')
    if c.must('eth_syncing', []) is not False:
        raise Refuse('el-syncing', 'L1 execution client still syncing')
    st, sy = c.bn('/eth/v1/node/syncing')
    sy = sy.get('data', {}) if st == 200 else {}
    if sy.get('is_optimistic') is not False:
        raise Refuse('cl-optimistic', 'L1 consensus head is optimistic (execution not validated)')
    if sy.get('is_syncing') is not False or sy.get('el_offline') is not False:
        raise Refuse('cl-not-synced', 'L1 consensus syncing or EL offline')
    head = c.must('eth_getBlockByNumber', ['latest', False])
    if not head or not (-15 <= now - _h(head['timestamp']) < max_head_age):
        raise Refuse('stale-head', 'L1 EL head is stale')
    fin = c.must('eth_getBlockByNumber', ['finalized', False])
    if not fin or not (-15 <= now - _h(fin['timestamp']) < max_final_age):
        raise Refuse('stale-finality', 'L1 finalized block is stale')
    st, bh = c.bn('/eth/v2/beacon/blocks/head')
    if st != 200 or bh.get('execution_optimistic') is not False:
        raise Refuse('cl-optimistic', 'beacon head response is optimistic or unavailable')
    payload = bh['data']['message']['body']['execution_payload']
    paired = c.must('eth_getBlockByNumber', [hex(int(payload['block_number'])), False])
    if not paired or paired['hash'] != payload['block_hash']:
        raise Refuse('el-cl-mismatch', 'beacon head payload is not the EL block at that height')
    st, ident = c.bn('/eth/v1/node/identity')
    cgc = int(ident.get('data', {}).get('metadata', {}).get('custody_group_count', 0) or 0) if st == 200 else 0
    if cgc < min_cgc:
        raise Refuse('insufficient-custody', f'custody_group_count {cgc} < {min_cgc}: cannot reconstruct blobs')
    return {'head': _h(head['number']), 'finalized': _h(fin['number']), 'finalizedHash': fin['hash'],
            'custodyGroupCount': cgc}


def run(a, origin, report):
    now = a.now if a.now is not None else time.time()
    need_from, rule, label = required_range(origin, a.accept_tip_walk_rule)
    c = Client(a.el, a.beacon, a.timeout, a.max_requests, a.rps, a.max_body)
    report['http'] = c
    report.update({'rule': rule, 'needFromBlock': need_from, 'missedSlots': [], 'missingData': [],
              'mismatches': [], 'counts': {'blocks': 0, 'transactions': 0, 'receipts': 0, 'blobTxs': 0,
                                           'blobsVerified': 0, 'missedSlots': 0, 'missingData': 0, 'mismatches': 0}})

    def note(kind, entry):
        report['counts'][kind] += 1
        if len(report[kind]) < LIST_CAP:
            report[kind].append(entry)

    ready = l1_ready(c, now, a.max_head_age, a.max_final_age, a.min_custody_groups)
    report['l1'] = ready
    to_block = ready['finalized'] if a.to_block is None else a.to_block
    if to_block > ready['finalized']:
        raise Refuse('range-not-finalized', f'--to-block {to_block} is above L1 finalized {ready["finalized"]}')
    origin_n = label['l1Origin']['number']
    if origin_n > to_block:
        raise Refuse('origin-not-finalized', f'L1 origin {origin_n} is above the checked finalized range end {to_block}')
    if need_from < 0 or to_block - need_from + 1 > a.max_blocks:
        raise Refuse('range-too-large', f'{to_block - need_from + 1} blocks exceeds --max-blocks {a.max_blocks}')
    for name in ('tip', 'safe', 'finalized'):
        lab = (origin.get('labels') or {}).get(name)
        if lab is None or lab['l1Origin']['number'] > ready['finalized']:
            continue
        b = c.must('eth_getBlockByNumber', [hex(lab['l1Origin']['number']), False])
        if not b or b['hash'] != lab['l1Origin']['hash']:
            raise Refuse('origin-not-canonical', f'{name} L1 origin {lab["l1Origin"]["number"]} is not canonical on this L1')
    report['toBlock'] = to_block
    report['batcher'], report['blobScope'] = (label.get('batcher') or '').lower() or None, a.blob_scope
    kzg = Kzg(a.kzg, a.kzg_sha256)
    roots = Kzg(a.kzg, a.kzg_sha256, 'block')
    prev_hash, prev_root, prev_slot = None, None, None
    first_blob_slot = None
    try:
        for n in range(need_from, to_block + 1):
            report['counts']['blocks'] += 1
            blk = c.must('eth_getBlockByNumber', [hex(n), True])
            if not blk:
                note('missingData', {'block': n, 'kind': 'el-block'})
                prev_hash = None
                continue
            if prev_hash is not None and blk['parentHash'] != prev_hash:
                raise Refuse('el-discontinuity', f'block {n} parentHash does not link to block {n - 1}')
            prev_hash = blk['hash']
            txs = blk.get('transactions') or []
            report['counts']['transactions'] += len(txs)
            ok, rc = c.rpc('eth_getBlockReceipts', [hex(n)])
            if not ok or rc is None:
                note('missingData', {'block': n, 'kind': 'receipts'})
            elif (got := roots.block_roots(blk, rc))[0] is None:
                note('mismatches', {'block': n, 'kind': 'commitments-unverifiable', 'detail': got[1]})
            elif got[0]['hash'] != blk['hash']:
                note('mismatches', {'block': n, 'kind': 'header-hash'})
            elif got[0]['transactionsRoot'] != blk.get('transactionsRoot') or got[0]['txHashes'] != [t.get('hash') for t in txs]:
                note('mismatches', {'block': n, 'kind': 'transactions-root'})
            elif got[0]['receiptsRoot'] != blk.get('receiptsRoot'):
                note('mismatches', {'block': n, 'kind': 'receipts-root'})
            elif len(rc) != len(txs) or any(r.get('transactionHash') != t.get('hash') or r.get('blockHash') != blk['hash']
                                            for r, t in zip(rc, txs)):
                note('mismatches', {'block': n, 'kind': 'receipts-do-not-match-block'})
            else:
                report['counts']['receipts'] += len(rc)
                for r in rc:
                    for lg in r.get('logs') or []:
                        t = lg.get('topics') or []
                        if (lg.get('address') or '').lower() == SYSTEM_CONFIG and t[:1] == [CONFIG_UPDATE_TOPIC] \
                                and len(t) > 2 and t[2] == UPDATE_TYPE_BATCHER:
                            raise Refuse('batcher-changed-in-range', f'SystemConfig batcher update in L1 block {n}')
            ts = _h(blk['timestamp'])
            if (ts - GENESIS_TIME) % SECONDS_PER_SLOT:
                raise Refuse('el-cl-mismatch', f'block {n} timestamp is not slot-aligned')
            slot = (ts - GENESIS_TIME) // SECONDS_PER_SLOT
            st, hdr = c.bn(f'/eth/v1/beacon/headers/{slot}')
            if st == 404:
                note('missingData', {'block': n, 'slot': slot, 'kind': 'beacon-block'})
                prev_root = None
                continue
            if st != 200:
                raise Refuse('beacon-error', f'headers/{slot}: HTTP {st}')
            hd = hdr.get('data', {})
            if hd.get('canonical') is not True or hdr.get('execution_optimistic') is not False:
                raise Refuse('cl-optimistic', f'slot {slot} header not canonical or optimistic')
            root = hd.get('root')
            st, bb = c.bn(f'/eth/v1/beacon/blinded_blocks/{slot}')
            if st != 200:
                note('missingData', {'block': n, 'slot': slot, 'kind': 'beacon-block'})
                prev_root = None
                continue
            msg = bb['data']['message']
            if int(msg['slot']) != slot or msg['body']['execution_payload_header']['block_hash'] != blk['hash']:
                raise Refuse('el-cl-mismatch', f'slot {slot} does not commit to EL block {n}')
            if prev_root is not None:
                if msg['parent_root'] != prev_root:
                    raise Refuse('cl-discontinuity', f'slot {slot} parent_root does not link to slot {prev_slot}')
                for s in range(prev_slot + 1, slot):
                    note('missedSlots', s)
            prev_root, prev_slot = root, slot
            commitments = msg['body'].get('blob_kzg_commitments') or []
            el_hashes = [h for t in txs for h in (t.get('blobVersionedHashes') or [])]
            if [kzg_to_versioned_hash(x) for x in commitments] != el_hashes:
                note('mismatches', {'block': n, 'slot': slot, 'kind': 'commitments-vs-el-versioned-hashes'})
                continue
            # Every blob sent to the batch inbox: a superset of Base's (inbox, batcher-sender) filter that does
            # not rely on the RPC's unverified `from` field (tx bodies are bound by transactionsRoot above).
            wanted = [h for t in txs if t.get('type') == '0x3' and (
                a.blob_scope == 'all' or (t.get('to') or '').lower() == BATCH_INBOX)
                for h in t.get('blobVersionedHashes') or []]
            if not wanted:
                continue
            report['counts']['blobTxs'] += sum(1 for t in txs if t.get('type') == '0x3' and set(t.get('blobVersionedHashes') or []) & set(wanted))
            q = '&'.join('versioned_hashes=' + h for h in wanted)
            st, bl = c.bn(f'/eth/v1/beacon/blobs/{slot}?{q}')
            blobs = bl.get('data') if st == 200 else None
            if not isinstance(blobs, list) or len(blobs) != len(wanted):
                note('missingData', {'block': n, 'slot': slot, 'kind': 'blobs', 'http': st,
                                     'served': len(blobs) if isinstance(blobs, list) else 0, 'wanted': len(wanted),
                                     'message': str(bl.get('message', ''))[:160]})
                continue
            got = []
            for b in blobs:
                com, err = kzg.commitment(b if isinstance(b, str) else '')
                got.append(kzg_to_versioned_hash(com) if com else 'ERR ' + str(err)[:80])
            if sorted(got) != sorted(wanted):
                note('mismatches', {'block': n, 'slot': slot, 'kind': 'blob-commitment'})
                continue
            report['counts']['blobsVerified'] += len(got)
            first_blob_slot = first_blob_slot if first_blob_slot is not None else slot
    finally:
        kzg.close()
        roots.close()
    if report['counts']['missingData']:
        raise Refuse('missing-data', f'{report["counts"]["missingData"]} slots/blocks lack EL, receipt, beacon or blob data')
    if report['counts']['mismatches']:
        raise Refuse('data-mismatch', f'{report["counts"]["mismatches"]} blocks failed commitment/receipt matching')
    if a.blob_scope == 'batcher' and first_blob_slot is None:
        raise Refuse('no-batcher-blobs', 'no batcher blob transaction found in range; cannot prove blob availability')
    tip_rule = rule.startswith('tip-walk-rule')
    report['proposedBaseBootstrap'] = {
        'l1Block': need_from, 'blobSlot': first_blob_slot, 'rootReviewRequired': True,
        'coverageVerifiedEligible': not tip_rule,
        'note': ('snapshot persisted NO safe label: range derived from the unsafe tip by source rule; root must decide '
                 'whether to accept it, this gate does not mark it eligible') if tip_rule else
                ('eligible only after root reviews this verdict; the gate never writes coverageVerified')}
    return report


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--origin', required=True)
    ap.add_argument('--el', default='http://127.0.0.1:18645')
    ap.add_argument('--beacon', default='http://127.0.0.1:15052')
    ap.add_argument('--kzg', required=True)
    ap.add_argument('--kzg-sha256', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--to-block', type=int)
    ap.add_argument('--blob-scope', choices=('batcher', 'all'), default='batcher')
    ap.add_argument('--accept-tip-walk-rule', action='store_true')
    ap.add_argument('--max-blocks', type=int, default=12000)
    ap.add_argument('--max-requests', type=int, default=80000)
    ap.add_argument('--rps', type=float, default=100.0)
    ap.add_argument('--timeout', type=float, default=15.0)
    ap.add_argument('--max-body', type=int, default=32 << 20)
    ap.add_argument('--max-head-age', type=int, default=120)
    ap.add_argument('--max-final-age', type=int, default=3600)
    ap.add_argument('--min-custody-groups', type=int, default=64)
    ap.add_argument('--now', type=float, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if not (1 <= a.max_blocks <= HARD_MAX_BLOCKS and 0 < a.rps <= 500 and 0 < a.timeout <= 60
            and 1 << 20 <= a.max_body <= 64 << 20 and a.min_custody_groups >= 64):
        ap.error('bounds outside the allowed envelope')
    if os.path.exists(a.out):
        ap.error('--out exists; refusing to overwrite evidence')
    report = {'format': FORMAT}
    try:
        with open(a.origin) as f:
            origin = json.load(f)
        run(a, origin, report)
        if report['proposedBaseBootstrap']['coverageVerifiedEligible']:
            report['verdict'], rc = 'COVERED', 0
        else:
            report['verdict'], rc = 'COVERED_UNDER_TIP_WALK_RULE_ROOT_DECISION_REQUIRED', 4
    except Refuse as e:
        report.update({'verdict': 'REFUSED', 'refusal': {'code': e.code, 'detail': e.detail}})
        rc = 3
    except (ValueError, OSError) as e:
        report.update({'verdict': 'REFUSED', 'refusal': {'code': 'config', 'detail': str(e)}})
        rc = 2
    if isinstance(report.get('http'), Client):
        report['http'] = {'requests': report['http'].requests, 'bytes': report['http'].bytes}
    report['coverageVerifiedWritten'] = False
    with open(a.out, 'x') as f:
        json.dump(report, f, indent=1, sort_keys=True)
    print(json.dumps({'verdict': report['verdict'], 'refusal': report.get('refusal'), 'out': a.out}))
    return rc


if __name__ == '__main__':
    sys.exit(main())
