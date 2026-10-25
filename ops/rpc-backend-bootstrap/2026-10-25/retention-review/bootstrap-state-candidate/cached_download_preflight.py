#!/usr/bin/python3 -I
"""Read-only capacity preflight + exact command for the SECOND (cached) Base snapshot download (option B).

Run by root inside the guest, after the first download finished, with the Base client stopped. It never downloads,
deletes or writes anything; it prints JSON and exits 0 (admitted), 3 (refused: insufficient space or unsafe input),
2 (usage). Semantics follow pinned reth 7134be3 crates/cli/commands/src/download:
  * --with-*-since B selects whole chunks from B // blocks_per_file (mod.rs:928-939, planning.rs);
  * already-present archive outputs are hashed and reused, nothing re-downloaded (mod.rs:44-45, planning.rs:140-151);
  * only --force / --prune-unlisted delete data (mod.rs:510-511, 550-553): the emitted command contains neither;
  * each archive is downloaded, extracted, then its file removed (archive.rs:255-276, fetch.rs:89-101,159-160).
Space model (conservative): every missing archive's compressed AND extracted bytes counted at once, plus an index
reserve (rocksdb lookup/history indices rebuilt on first start; ESTIMATE, not measured) and a growth reserve.
This is capacity/selection only: it is not authenticated snapshot state.
"""
import argparse
import json
import os
import sys

GB = 10 ** 9
BLOCKS_PER_DAY = 43_200                     # Base 2 s blocks
MIN_INDEX_RESERVE = 150 * GB
SELECTED = {'transactions': 'history', 'receipts': 'history', 'account_changesets': 'state', 'storage_changesets': 'state'}


def plan(manifest, history_from, state_from):
    block = manifest['block']
    if not (0 < history_from <= block and 0 < state_from <= block):
        raise ValueError('history/state start must be within (0, snapshot block]')
    out = {'missingArchives': [], 'selected': {}}
    for name, which in SELECTED.items():
        c = manifest['components'][name]
        since = history_from if which == 'history' else state_from
        first = since // c['blocks_per_file']
        out['selected'][name] = {'since': since, 'firstChunk': first, 'chunks': len(c['chunk_sizes']) - first}
        for i in range(first, len(c['chunk_sizes'])):
            out['missingArchives'].append({'component': name, 'chunk': i, 'file': c['chunk_files'][i],
                                           'compressed': c['chunk_sizes'][i], 'extracted': c['chunk_decompressed_sizes'][i],
                                           'outputs': c['chunk_output_files'][i]})
    return out


def present(datadir, outputs):
    """Cheap presence check (path + size); reth itself re-verifies BLAKE3 before reuse."""
    for o in outputs:
        p = os.path.join(datadir, o['path'])
        try:
            if os.path.getsize(p) != o['size']:
                return False
        except OSError:
            return False
    return True


def index_reserve_estimate(manifest, history_from):
    """ESTIMATE: full-chain rocksdb_indices scaled by the share of transaction bytes from history_from (upper-ish)."""
    t = manifest['components']['transactions']
    first = history_from // t['blocks_per_file']
    share = sum(t['chunk_decompressed_sizes'][first:]) / sum(t['chunk_decompressed_sizes'])
    rocks = manifest['components'].get('rocksdb_indices', {}).get('decompressed_size', 0)
    return int(rocks * share)


def daily_growth(manifest):
    """Bytes/day from the last FULL chunk of each retained segment (state DB growth not included)."""
    per_block = 0.0
    for name in ('transactions', 'receipts', 'account_changesets', 'storage_changesets', 'headers'):
        c = manifest['components'][name]
        per_block += c['chunk_decompressed_sizes'][-2] / c['blocks_per_file']
    return int(per_block * BLOCKS_PER_DAY)


def command(datadir, manifest_path, history_from, state_from, concurrency):
    argv = ['/opt/enclave-rpc/bin/base', 'snapshot', 'download', '--chain', 'base', '--manifest-path', manifest_path,
            '--datadir', datadir, '--with-txs-since', str(history_from), '--with-receipts-since', str(history_from),
            '--with-state-history-since', str(state_from), '--download-concurrency', str(concurrency),
            '--resumable=true', '-y']
    assert not {'--force', '--prune-unlisted', '--with-senders', '--with-rocksdb', '--archive', '--all',
                '--minimal', '--full'} & set(argv)
    return argv


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
            manifest = json.loads(f.read())
        p = plan(manifest, a.history_from, a.state_history_from)
    except (OSError, ValueError, KeyError) as e:
        print(json.dumps({'admitted': False, 'refusal': f'input: {e}'}))
        return 3
    missing = [x for x in p['missingArchives'] if not present(a.datadir, x['outputs'])]
    need_c = sum(x['compressed'] for x in missing)
    need_x = sum(x['extracted'] for x in missing)
    est = index_reserve_estimate(manifest, a.history_from)
    index_reserve = max(2 * est, MIN_INDEX_RESERVE)
    growth = daily_growth(manifest) * a.growth_days
    if a.free_bytes is not None:
        free = a.free_bytes
    else:
        v = os.statvfs(a.datadir)
        free = v.f_bavail * v.f_frsize
    need = need_c + need_x + index_reserve + growth
    report = {'admitted': free >= need, 'freeBytes': free, 'needBytes': need,
              'missing': {'archives': len(missing), 'compressedBytes': need_c, 'extractedBytes': need_x,
                          'byComponent': {k: sum(1 for x in missing if x['component'] == k) for k in SELECTED}},
              'indexReserveBytes': index_reserve, 'indexEstimateBytes': est, 'indexEstimate': 'ESTIMATE (not measured)',
              'growthReserveBytes': growth, 'growthDays': a.growth_days, 'dailyGrowthBytes': daily_growth(manifest),
              'selected': p['selected'], 'snapshotBlock': manifest['block'],
              'command': command(a.datadir, a.manifest, a.history_from, a.state_history_from, a.download_concurrency),
              'headroomAfterBytes': free - need}
    if not report['admitted']:
        report['refusal'] = 'insufficient free space for missing archives + index reserve + growth reserve'
    print(json.dumps(report, indent=1, sort_keys=True))
    return 0 if report['admitted'] else 3


if __name__ == '__main__':
    sys.exit(main())
