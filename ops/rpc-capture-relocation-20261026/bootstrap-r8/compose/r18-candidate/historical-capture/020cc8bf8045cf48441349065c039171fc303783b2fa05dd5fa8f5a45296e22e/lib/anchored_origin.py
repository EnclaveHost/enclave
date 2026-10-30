#!/usr/bin/env python3
"""anchored_origin.py: read-only extraction of the L1 origin of the EXACT first-launch anchor block N (not LastSafeBlock).

The first anchored launch unwinds the DB to N = the source-pinned original A1 receipt's block (b9a90847: N 52866960) and re-derives
from there, so the L1 range it needs starts at l1Origin(N) - SEQ_WINDOW, not at the snapshot's persisted safe head.

Reuses, unmodified and sha-pinned, coverage/origin_extract.py (6b63b901): its read-only-mount + RocksDB-secondary-scratch rules and its
Reader (`base reth db get static-file headers|transactions`, `mdbx BlockBodyIndices|StageCheckpoints`, AccessRights::RO) plus its
L1-attributes decoder (bedrock/ecotone/isthmus/jovian, base-v1.5.1 crates/common/consensus/src/info). Then BINDS the DB header of N to the
AUTHENTICATED anchor: the pinned vendor/anchor-bootstrap.mjs (90a8afba) `authenticateAnchor({rootClaim, l2BlockNumber}, header, keccak)`
recomputes keccak(RLP(Isthmus header)) and OutputRootV0 and must reproduce the receipt's outputRoot; the recomputed hash must equal the DB's
BlockHash. Only then is l1Origin(N) emitted, labelled as read from THIS anchor-bound block; it is never an authenticated L1 fact by itself:
the coverage segments re-check it is canonical on our L1 (gate `origin-not-canonical`) and that the L1 block there carries the anchor
header's mixHash and parentBeaconBlockRoot (segments.py `origin-not-bound-to-anchor-header`).

usage: anchored_origin.py --base-bin P --base-sha256 H --datadir D --scratch EMPTY --receipt R --node NODE --out F
Exit 0 = document written; 2 = refusal (JSON {refused} on stdout)."""
import argparse, hashlib, json, os, subprocess, sys, types

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))   # relocatable bundle root: <ROOT>/lib/anchored_origin.py
W = ROOT
PINS = {
    'origin_extract': (f'{ROOT}/vendor/coverage/origin_extract.py',
                       '6b63b901ea07375ea273fd828cb0d0e97baa0859c1b83490c1cb60e15cb3c86c'),
    'anchor_bootstrap': (f'{ROOT}/vendor/anchor-bootstrap.mjs',
                         '90a8afba31e7c7029a0fa860f97153cd40665f1d1b2ae87bb0a56fd98c25e8f8'),
    'noble_sha3': (f'{ROOT}/vendor/node_modules/@noble/hashes/sha3.js', '313da3570150e80b02c3631508ba99099438d2daff641b9cadb2198e0f1d18ec'),
    'receipt': (f'{ROOT}/receipt/a1-evidence.json',
                'b9a90847bb3f779262681cabc35af64d7c3b785c9ad5cd2b99e9700b9725256c'),
}
FORMAT = 'enclave-base-anchored-origin/v1'
SEQ_WINDOW = 3600                                  # base mainnet seq_window_size (coverage_gate.py SEQ_WINDOW, same source)
BIND = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'bind_anchor.mjs')


class Refused(Exception):
    pass


def sha(b):
    return hashlib.sha256(b).hexdigest()


def pinned_bytes(key, pins):
    path, want = pins[key]
    b = open(path, 'rb').read()
    if sha(b) != want:
        raise Refused(f'{key}: {path} is not the pinned {want[:12]}')
    return path, b


def load_origin_extract(pins):
    path, b = pinned_bytes('origin_extract', pins)
    m = types.ModuleType('origin_extract_pinned'); m.__file__ = path
    exec(compile(b, path, 'exec'), m.__dict__)
    return m


def bind(node, pins, header, root_claim, number):
    """the pinned authenticateAnchor over the DB header -> {blockHash, stateRoot, messagePasserStorageRoot}"""
    ab, _ = pinned_bytes('anchor_bootstrap', pins)
    k, _ = pinned_bytes('noble_sha3', pins)
    bind_b = open(BIND, 'rb').read()
    p = subprocess.run([node, BIND], input=json.dumps({'header': header, 'rootClaim': root_claim, 'l2BlockNumber': number}),
                       capture_output=True, text=True, timeout=60,
                       env={'PATH': '/usr/bin:/bin', 'AB': 'file://' + ab, 'K': 'file://' + k})
    try:
        r = json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise Refused(f'anchor binding produced no result: {p.stderr[-300:]}')
    if p.returncode != 0 or r.get('ok') is not True:
        raise Refused(f'header N does not bind to the authenticated anchor: {r.get("code")}: {r.get("error")}')
    return {**r['anchor'], 'method': 'vendor/anchor-bootstrap.mjs authenticateAnchor', 'moduleSha256': pins['anchor_bootstrap'][1],
            'bindScriptSha256': sha(bind_b)}


def extract_anchored(base_bin, base_sha256, datadir, receipt, scratch, node, timeout=300, pins=PINS):
    OE = load_origin_extract(pins)
    rpath, rb = pinned_bytes('receipt', {**pins, 'receipt': (receipt, pins['receipt'][1])})
    rec = json.loads(rb)
    if rec.get('verdict') != 'A1-authenticated' or not str(rec.get('N', '')).isdigit():
        raise Refused('receipt is not an A1-authenticated anchor receipt')
    n, root = int(rec['N']), str(rec.get('outputRoot', '')).lower()
    try:
        with open(base_bin, 'rb') as f:
            if hashlib.file_digest(f, 'sha256').hexdigest() != base_sha256:
                raise Refused('base binary differs from its pinned sha256')
        if not os.path.isdir(os.path.join(datadir, 'db')):
            raise Refused('datadir has no db/ (snapshot not extracted?)')
        if not (OE.read_only_mount(datadir) and OE.read_only_mount(os.path.join(datadir, 'db'))):
            raise Refused('datadir is not on a read-only mount; bind-mount it read-only first')
        scratch = OE.prepare_scratch(datadir, scratch)
        rd = OE.Reader(base_bin, datadir, timeout, scratch)
        finish = rd.get('mdbx', 'StageCheckpoints', json.dumps('Finish'))
        if finish is None:
            raise Refused('StageCheckpoints[Finish] absent: no completed pipeline tip')
        tip = OE._int(finish.get('block_number'), 'Finish.block_number')
        if tip < n:
            raise Refused(f'DB tip {tip} is below the anchor {n}: the DB does not hold N')
        lab = rd.block(n, 'anchor', {})                       # the pinned per-block rule: header number, BlockHash, deposit, L1 info
        header = rd.get('static-file', 'headers', str(n), marker='Header')   # the same row, now whole, for the binding
        if not isinstance(header, dict):
            raise Refused(f'anchor block {n}: header unreadable')
    except OE.Refusal as e:
        raise Refused(str(e))
    b = bind(node, pins, header, root, n)
    if b['blockHash'] != lab['hash'] or b['number'] != n or str(header.get('parentHash', '')).lower() != str(lab['parentHash']).lower():
        raise Refused('the anchor-bound header hash differs from the DB BlockHash')
    o = lab['l1Origin']
    return {'format': FORMAT, 'chain': 'base-mainnet',
            'anchor': {'N': n, 'outputRoot': root, 'game': rec.get('game'), 'receiptSha256': sha(rb), 'receiptPinned': pins['receipt'][1]},
            # mixHash / parentBeaconBlockRoot of N are the L1 origin header's mix_hash / parent_beacon_block_root (base-v1.5.1
            # crates/consensus/derive/src/attributes/stateful.rs prepare_payload_attributes); bound here by the header hash, they
            # let the segment holding l1Origin check the DB-decoded origin against the authenticated header.
            'header': {'number': n, 'hash': b['blockHash'], 'stateRoot': b['stateRoot'], 'messagePasserStorageRoot': b['messagePasserStorageRoot'],
                       'timestamp': lab['timestamp'], 'parentHash': str(lab['parentHash']).lower(),
                       'mixHash': str(header.get('mixHash', '')).lower(), 'parentBeaconBlockRoot': str(header.get('parentBeaconBlockRoot', '')).lower(),
                       'raw': header},
            'binding': {**b, 'ok': True},
            'l1Origin': {'number': o['number'], 'hash': o['hash'].lower(),
                         'evidence': 'UNAUTHENTICATED: decoded from the DB L1-attributes deposit of block N (the tx body is not bound by this '
                                     'tool); every coverage segment re-checks it is canonical on our L1, and the segment holding it must show '
                                     'that L1 block\'s mixHash and parentBeaconBlockRoot equal the anchor-bound header\'s'},
            'layout': lab['layout'], 'sequenceNumber': lab['sequenceNumber'], 'batcher': lab['batcher'].lower(),
            'needFrom': o['number'] - SEQ_WINDOW, 'rule': 'anchor-origin-minus-seq-window',
            'source': {'tool': 'base reth db get (AccessRights::RO)', 'binarySha256': base_sha256, 'datadirReadOnlyMount': True,
                       'originExtractSha256': pins['origin_extract'][1], 'calls': rd.calls}}


def main(argv=None):
    ap = argparse.ArgumentParser()
    for k in ('base-bin', 'base-sha256', 'datadir', 'scratch', 'receipt', 'node', 'out'):
        ap.add_argument('--' + k, required=True)
    ap.add_argument('--timeout', type=int, default=300)
    a = ap.parse_args(argv)
    if os.path.exists(a.out):
        ap.error('--out exists; refusing to overwrite evidence')
    try:
        doc = extract_anchored(a.base_bin, a.base_sha256, a.datadir, a.receipt, a.scratch, a.node, a.timeout)
    except Refused as e:
        print(json.dumps({'refused': str(e)})); return 2
    with open(a.out, 'x') as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    print(json.dumps({'ok': True, 'N': doc['anchor']['N'], 'l1Origin': doc['l1Origin']['number'], 'needFrom': doc['needFrom'], 'out': a.out}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
