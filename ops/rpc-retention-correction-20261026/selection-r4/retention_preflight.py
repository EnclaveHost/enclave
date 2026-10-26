#!/usr/bin/python3 -I
"""selection-r4: read-only preflight for a cached Base snapshot download (supersedes selection-r3's, which stays frozen).

What reth 7134be3 (crates/cli/commands/src/download) actually does, corrected from activation-r2/r3's docs:
  * Archive selection: Since(B) -> distance snapshot - B + 1 (planning.rs:197) -> first chunk (total_blocks - min(distance,
    total_blocks)) // blocks_per_file (manifest.rs:476-489). Kept exactly from r3 (pinned manifest: 30 history archives).
  * State and headers are ALWAYS planned as All when the manifest declares them (mod.rs:753-756, 886-888). An archive is reused
    only if every declared output matches exact size AND full blake3 (verify.rs). Any other planned archive is PENDING, and its
    attempt starts with cleanup_outputs(), which DELETES its declared outputs before fetching (archive.rs:150-152).
  * finalize opens the DB read-write and writes prune/index checkpoints (mod.rs:647-674), so a finalized datadir's state outputs
    never verify again: a second download with a state-declaring manifest deletes db/* and re-downloads the whole state.
  * So "only --force / --prune-unlisted delete data" (activation-r2 / r3 docs) is FALSE: pending archives' outputs are deleted too.
Policy here:
  * REFUSED: any manifest other than the reviewed pinned one (sha 1f0c4e6c...). A state-less or otherwise derived manifest needs its
    own reviewed provenance (derived from the pinned manifest, exact same block, checkpoint/readiness review); not implemented here.
  * REFUSED: the manifest declares state and ANY state output, any file under db/, or a state download cache exists: a size match
    is not integrity, and reth would delete that DB (no silent destructive reuse/retry). Only a datadir with no DB is admitted.
  * Counted needs (size presence ONLY, never integrity): state (mandatory), all 107 headers, the 30 history archives. Present by
    size does NOT mean reth will reuse it (blake3); `ifPresentOutputsFailIntegrity` reports the bound if they all re-fetch.
  * Reserves as before: index ESTIMATE max(2x, 150 GB), growth reserve. Nothing here is integrity or chain readiness.
Exit 0 admitted, 3 refused / invalid input, 2 usage. It never downloads, deletes or writes.
"""
import argparse
import hashlib
import json
import os
import sys

GB = 10 ** 9
BLOCKS_PER_DAY = 43_200
MIN_INDEX_RESERVE = 150 * GB
PINNED_MANIFEST_SHA256 = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
SELECTED = {'transactions': 'history', 'receipts': 'history', 'account_changesets': 'state', 'storage_changesets': 'state'}
SIZE_ONLY = 'size presence only: NOT integrity (reth verifies blake3 and deletes then re-fetches any mismatch)'
READINESS = 'NOT readiness: retention selection/capacity only; coverage may be claimed from the declared floor only'
STATELESS = ('a manifest without the reviewed sha (e.g. a state-less derived manifest) needs separately reviewed provenance: derived '
             'from the pinned manifest, exact same block, checkpoint and readiness review. Not implemented here')


def _int(v, what, minimum=0):
    if type(v) is not int or v < minimum:
        raise ValueError(f'{what} must be an integer >= {minimum}')
    return v


def _outputs(lst, what):
    if not isinstance(lst, list) or not lst:
        raise ValueError(f'{what}: output files missing')
    for o in lst:
        if not isinstance(o, dict) or not isinstance(o.get('path'), str) or not o['path'] or o['path'].startswith('/') \
                or '..' in o['path'].split('/'):
            raise ValueError(f'{what}: invalid output path')
        _int(o.get('size'), f'{what}: output size')
    return lst


def chunked(manifest, name):
    c = manifest.get('components', {}).get(name)
    if not isinstance(c, dict):
        raise ValueError(f'manifest has no {name} component')
    total, bpf = _int(c.get('total_blocks'), f'{name}.total_blocks', 1), _int(c.get('blocks_per_file'), f'{name}.blocks_per_file', 1)
    n = -(-total // bpf)
    for k in ('chunk_sizes', 'chunk_decompressed_sizes', 'chunk_files', 'chunk_output_files'):
        if not isinstance(c.get(k), list) or len(c[k]) != n:
            raise ValueError(f'{name}.{k} must have exactly {n} entries')
    for i in range(n):
        _int(c['chunk_sizes'][i], f'{name}.chunk_sizes[{i}]'); _int(c['chunk_decompressed_sizes'][i], f'{name}.chunk_decompressed_sizes[{i}]')
        if not isinstance(c['chunk_files'][i], str) or not c['chunk_files'][i]:
            raise ValueError(f'{name}.chunk_files[{i}] invalid')
        _outputs(c['chunk_output_files'][i], f'{name}[{i}]')
    return c


def state_component(manifest):
    s = manifest.get('components', {}).get('state')
    if s is None:
        return None
    if not isinstance(s, dict) or not isinstance(s.get('file'), str):
        raise ValueError('invalid state component')
    return {'component': 'state', 'chunk': None, 'file': s['file'], 'compressed': _int(s.get('size'), 'state.size'),
            'extracted': _int(s.get('decompressed_size'), 'state.decompressed_size'), 'outputs': _outputs(s.get('output_files'), 'state')}


def first_chunk(c, since, snapshot_block):
    """reth 7134be3 (unchanged from selection-r3)"""
    needed = min(snapshot_block - since + 1, c['total_blocks'])
    n = -(-c['total_blocks'] // c['blocks_per_file'])
    return n if needed <= 0 else (c['total_blocks'] - needed) // c['blocks_per_file']


def history_plan(manifest, history_from, state_from):
    block = _int(manifest.get('block') if isinstance(manifest, dict) else None, 'manifest block', 1)
    for v, what in ((history_from, 'history start'), (state_from, 'state history start')):
        if type(v) is not int or not 0 < v <= block:
            raise ValueError(f'{what} must be an integer within (0, snapshot block {block}]')
    out = []
    for name, which in SELECTED.items():
        c, since = chunked(manifest, name), (history_from if which == 'history' else state_from)
        bpf, n = c['blocks_per_file'], -(-c['total_blocks'] // c['blocks_per_file'])
        for i in range(first_chunk(c, since, block), n):
            out.append({'component': name, 'chunk': i, 'fromBlock': i * bpf, 'toBlock': (i + 1) * bpf - 1, 'declaredFloor': since,
                        'belowDeclaredFloor': (i + 1) * bpf - 1 < since, 'file': c['chunk_files'][i], 'compressed': c['chunk_sizes'][i],
                        'extracted': c['chunk_decompressed_sizes'][i], 'outputs': c['chunk_output_files'][i]})
    return out


def header_archives(manifest):
    h = chunked(manifest, 'headers')
    return [{'component': 'headers', 'chunk': i, 'file': h['chunk_files'][i], 'compressed': h['chunk_sizes'][i],
             'extracted': h['chunk_decompressed_sizes'][i], 'outputs': h['chunk_output_files'][i]} for i in range(len(h['chunk_files']))]


def size_present(datadir, outputs):
    for o in outputs:
        p = os.path.join(datadir, o['path'])
        if os.path.islink(p) or not os.path.isfile(p) or os.path.getsize(p) != o['size']:
            return False
    return True


def existing_db(datadir, state):
    """every trace of a state DB or state download: declared outputs, anything under db/, a state archive cache/part"""
    found = [o['path'] for o in (state['outputs'] if state else []) if os.path.lexists(os.path.join(datadir, o['path']))]
    db = os.path.join(datadir, 'db')
    if os.path.lexists(db):
        found += [f'db/{n}' for n in sorted(os.listdir(db)) if f'db/{n}' not in found] if os.path.isdir(db) and not os.path.islink(db) else ['db']
    cache = os.path.join(datadir, '.download-cache')
    if os.path.isdir(cache):
        base = os.path.basename(state['file']) if state else 'state.tar.zst'
        found += [f'.download-cache/{n}' for n in sorted(os.listdir(cache)) if n.startswith(base)]
    return found


def _sum(xs):
    return {'archives': len(xs), 'compressedBytes': sum(x['compressed'] for x in xs), 'extractedBytes': sum(x['extracted'] for x in xs)}


def daily_growth(manifest):
    per_block = 0.0
    for name in ('transactions', 'receipts', 'account_changesets', 'storage_changesets', 'headers'):
        c = chunked(manifest, name)
        per_block += c['chunk_decompressed_sizes'][-2] / c['blocks_per_file']
    return int(per_block * BLOCKS_PER_DAY)


def index_reserve_estimate(manifest, history_from):
    t = chunked(manifest, 'transactions')
    first = first_chunk(t, history_from, manifest['block'])
    share = sum(t['chunk_decompressed_sizes'][first:]) / sum(t['chunk_decompressed_sizes'])
    return int(manifest['components'].get('rocksdb_indices', {}).get('decompressed_size', 0) * share)


def command(datadir, manifest_path, history_from, state_from, concurrency):
    argv = ['/opt/enclave-rpc/bin/base', 'snapshot', 'download', '--chain', 'base', '--manifest-path', manifest_path,
            '--datadir', datadir, '--with-txs-since', str(history_from), '--with-receipts-since', str(history_from),
            '--with-state-history-since', str(state_from), '--download-concurrency', str(concurrency), '--resumable=true', '-y']
    assert not {'--force', '--prune-unlisted', '--with-senders', '--with-rocksdb', '--archive', '--all', '--minimal', '--full'} & set(argv)
    return argv


def report(raw, manifest_path, datadir, history_from, state_from, growth_days, free, concurrency):
    sha, refusals = hashlib.sha256(raw).hexdigest(), []
    manifest = json.loads(raw)
    hist, heads, state = history_plan(manifest, history_from, state_from), header_archives(manifest), state_component(manifest)
    if sha != PINNED_MANIFEST_SHA256:
        refusals.append(f'manifest sha256 {sha} is not the reviewed pinned manifest: {STATELESS}')
    if state is None:
        refusals.append(f'the manifest declares no state component: {STATELESS}')
    db = existing_db(datadir, state)
    if state is not None and db:
        refusals.append('the manifest declares state and a state DB (or its traces) exists: reth would treat it as unverified and '
                        'DELETE it before re-downloading (cleanup_outputs); a matching size is not integrity. Refused, never reused/retried: '
                        + ', '.join(db))
    h_miss = [x for x in hist if not size_present(datadir, x['outputs'])]
    hd_miss = [x for x in heads if not size_present(datadir, x['outputs'])]
    st_need = [state] if state is not None else []        # mandatory: never verifiable on a finalized datadir; on an empty one, absent
    pending = h_miss + hd_miss + st_need
    est = index_reserve_estimate(manifest, history_from)
    index_reserve, growth = max(2 * est, MIN_INDEX_RESERVE), daily_growth(manifest) * growth_days
    p = _sum(pending)
    need = p['compressedBytes'] + p['extractedBytes'] + index_reserve + growth
    allx = _sum(hist + heads + st_need)
    if free < need:
        refusals.append('insufficient free space for pending archives + index reserve + growth reserve')
    rep = {'format': 'enclave-base-retention-preflight/r4', 'admitted': not refusals, 'refusals': refusals, 'manifestSha256': sha,
           'snapshotBlock': manifest['block'], 'declaredFloor': {'history': history_from, 'stateHistory': state_from},
           'readiness': READINESS, 'integrity': SIZE_ONLY,
           'state': {'declaredByManifest': state is not None, 'existingDbTraces': db, 'mandatoryNeed': _sum(st_need)},
           'headers': {'planned': len(heads), 'sizeMissing': _sum(hd_miss)},
           'history': {**_sum(hist), 'sizeMissing': _sum(h_miss), 'belowDeclaredFloor': _sum([x for x in hist if x['belowDeclaredFloor']]),
                       'belowDeclaredFloorList': [f"{x['component']}:{x['chunk']}" for x in hist if x['belowDeclaredFloor']]},
           'cliWouldPlanPending': {**p, 'note': 'history/headers by size presence + state (mandatory); reth may add more on blake3 mismatch'},
           'ifPresentOutputsFailIntegrity': {**allx, 'note': 'upper bound if every planned archive re-fetches'},
           'indexReserveBytes': index_reserve, 'indexEstimate': 'ESTIMATE (not measured)', 'growthReserveBytes': growth,
           'freeBytes': free, 'needBytes': need, 'headroomAfterBytes': free - need}
    if not refusals:
        rep['command'] = command(datadir, manifest_path, history_from, state_from, concurrency)
        rep['commandScope'] = 'only for this datadir as checked now (no state DB); re-run this preflight immediately before any start'
    return rep


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--manifest', required=True)
    ap.add_argument('--datadir', required=True)
    ap.add_argument('--history-from', type=int, required=True)
    ap.add_argument('--state-history-from', type=int, required=True)
    ap.add_argument('--growth-days', type=int, default=30)
    ap.add_argument('--download-concurrency', type=int, default=16)
    ap.add_argument('--free-bytes', type=int, help='testing only: override statvfs')
    a = ap.parse_args(argv)
    if not (1 <= a.growth_days <= 365 and 1 <= a.download_concurrency <= 64):
        ap.error('bounds')
    try:
        with open(a.manifest, 'rb') as f:
            raw = f.read()
        free = a.free_bytes if a.free_bytes is not None else (lambda v: v.f_bavail * v.f_frsize)(os.statvfs(a.datadir))
        rep = report(raw, a.manifest, a.datadir, a.history_from, a.state_history_from, a.growth_days, free, a.download_concurrency)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        print(json.dumps({'admitted': False, 'refusals': [f'input: {e}']}))
        return 3
    print(json.dumps(rep, indent=1, sort_keys=True))
    return 0 if rep['admitted'] else 3


if __name__ == '__main__':
    sys.exit(main())
