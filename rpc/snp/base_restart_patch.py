"""Let Base restart after L1 prunes the snapshot origin's data. Patches a guest chain_service.py in place.

python3 -I base_restart_patch.py CHAIN_SERVICE_PY

Every Base start required L1 to serve the coverage verdict's origin: the receipts of its L1 block and
the blobs of its slot. Lighthouse prunes blobs after 4096 epochs (~18 days, --blob-prune-margin-epochs 0)
and the L1 reth prunes receipts beyond its 140000-block profile (~19 days, in 50000-block segments), so
once the origin aged out every restart refused Base until a new verdict and image existed (activation-r4
REVIEW.md (c): ~2026-11-11 16:50Z). That data is only needed to derive forward from the snapshot. Once
Base has started from it, it resumes from its own persisted safe head, and l1_ready() still requires
current blobs to be served.

The check is unchanged until it first passes on a datadir. Then the guest writes the activation it served
(origin l1Block, blobSlot, toBlock, snapshot block) to DATADIR/enclave-origin-served.json. A later start
with the origin pruned (receipts: reth error 4444; blobs: 404, Lighthouse's 400 'Insufficient data
columns', or a short answer) proceeds only if that record names this same activation. A new verdict or
a fresh datadir requires the origin's data again. Any other L1 error still refuses.

The record lives on the host's chain disk, which the measured image does not protect. A forged record
can only skip a liveness check: derivation without its L1 data stalls Base, it cannot change what Base
derives (REVIEW.md (b)). The L2 state on that disk is already a separate trust assumption (REVIEW.md (d)).
The build re-pins identity.json afterwards.
"""
import sys

OLD = """        assert rpc(18645, 'eth_getBlockReceipts', [hex(origin['l1Block'])]) is not None, 'Base origin receipts absent'
        slot = str(origin['blobSlot'])
        commitments = beacon('/eth/v2/beacon/blocks/' + slot)['message']['body']['blob_kzg_commitments']
        assert commitments and len(beacon('/eth/v1/beacon/blobs/' + slot)) == len(commitments), 'Base origin blobs absent'
"""
NEW = """        base_origin_data(origin, datadir)
"""
ANCHOR = 'def run(side):\n'
HELPER = '''ORIGIN_SERVED = 'enclave-origin-served.json'


def base_origin_data(origin, datadir):
    """Require the coverage origin's L1 data until this datadir has started Base with it (base_restart_patch.py)."""
    record = pathlib.Path(datadir, ORIGIN_SERVED)
    served = {'l1Block': origin['l1Block'], 'blobSlot': origin['blobSlot'], 'toBlock': origin['toBlock'],
              'snapshotBlock': (origin.get('snapshot') or {}).get('block')}
    slot = str(origin['blobSlot'])
    commitments = beacon('/eth/v2/beacon/blocks/' + slot)['message']['body']['blob_kzg_commitments']
    assert commitments, 'Base origin slot carries no blobs'
    try:
        prior = json.loads(record.read_text())
    except (OSError, ValueError):
        prior = None
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockReceipts', 'params': [hex(origin['l1Block'])]}).encode()
    with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18645', body, {'Content-Type': 'application/json'}),
                                timeout=10) as r:
        receipts = json.load(r)
    if 'error' in receipts:
        assert (receipts['error'] or {}).get('code') == 4444, 'local RPC failed'
    else:
        assert receipts.get('result') is not None, 'Base origin receipts absent'
    try:
        present = 'error' not in receipts and len(beacon('/eth/v1/beacon/blobs/' + slot)) == len(commitments)
    except urllib.error.HTTPError as e:
        # Lighthouse v8 answers a pruned slot 400 'Insufficient data columns to reconstruct blobs'.
        if not (e.code == 404 or (e.code == 400 and b'Insufficient data columns' in e.read(4096))):
            raise
        present = False
    if present:
        if prior != served:
            tmp = record.with_name(ORIGIN_SERVED + '.tmp')
            tmp.write_text(json.dumps(served) + '\\n')
            os.replace(tmp, record)
        return 'origin-served'
    assert prior == served, 'Base origin receipts or blobs absent'
    print(json.dumps({'baseOrigin': 'pruned', 'resumingFrom': 'persisted safe head', **served}), flush=True)
    return 'resumed'


'''


def patch(path):
    s = open(path).read()
    if s.count(OLD) != 1 or s.count(ANCHOR) != 1:
        raise SystemExit('Base origin data check not found exactly once in ' + path)
    open(path, 'w').write(s.replace(OLD, NEW).replace(ANCHOR, HELPER + ANCHOR))


if __name__ == '__main__':
    patch(sys.argv[1])
