#!/usr/bin/python3 -I
"""selection-r3: read-only capacity preflight for the SECOND (cached) Base snapshot download, with reth's EXACT archive selection.

Supersedes activation-r2's copy (sha af70424c..., kept unchanged and still the one installed/pinned by the live guard). r2 took the
first chunk of `--with-*-since B` as B // blocks_per_file. Pinned reth 7134be3 (crates/cli/commands/src/download) instead does:
  * Since(B) is accepted only for B <= snapshot block (mod.rs:939); its archive distance is snapshot_block - B + 1 (planning.rs:197);
  * tail_chunks_for_distance(d): needed = min(d, total_blocks); 0 -> no chunk; first = (total_blocks - needed) // blocks_per_file;
    chunks = ceil(total_blocks / blocks_per_file) - first (manifest.rs:476-489), with the COMPONENT's total_blocks.
The pinned manifest (1f0c4e6c) has total_blocks == block == 53048526, so a B on a chunk boundary also selects the chunk BELOW B
(48000000 -> chunk 95, 52500000 -> chunk 104): 30 archives, not 26. Those extra archives are whole-chunk download artefacts below the
DECLARED floor; nothing here (or anywhere) may claim retention, coverage or readiness below the declared floor because of them.
Also planned by the CLI and only reused when their outputs verify: headers and state (All; mod.rs:886-888 and root 1394's startup
log "Headers 107 (All)"). They are reported and, if any output is absent or a different size, counted as missing (the CLI would
fetch them). Other behaviour as r2: verified outputs are reused, only --force/--prune-unlisted delete (the command has neither), each
archive is removed after extraction. Space model unchanged and conservative: every missing archive's compressed AND extracted bytes
at once, plus the index reserve (ESTIMATE) and the growth reserve. Exit 0 admitted, 3 refused/invalid input, 2 usage.
This is selection/capacity only: downloaded archives are NOT chain readiness.
"""
import argparse
import json
import os
import sys

GB = 10 ** 9
BLOCKS_PER_DAY = 43_200                     # Base 2 s blocks
MIN_INDEX_RESERVE = 150 * GB
SELECTED = {'transactions': 'history', 'receipts': 'history', 'account_changesets': 'state', 'storage_changesets': 'state'}
CLI_ALL = ('headers', 'state')              # always planned by the CLI (All), reused when their outputs verify
READINESS = 'NOT readiness: retention download selection/capacity only; coverage may be claimed from the declared floor only'


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
    """-> the validated chunked component (exact reth shape: one entry per chunk in every per-chunk list)"""
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


def first_chunk(c, since, snapshot_block):
    """reth 7134be3: Since(since) -> distance snapshot_block - since + 1 -> tail_chunks_for_distance against total_blocks"""
    distance = snapshot_block - since + 1
    needed = min(distance, c['total_blocks'])
    n = -(-c['total_blocks'] // c['blocks_per_file'])
    return n if needed <= 0 else (c['total_blocks'] - needed) // c['blocks_per_file']


def plan(manifest, history_from, state_from):
    """-> every archive the CLI selects for the four retained components, each marked whether it lies wholly below the declared floor"""
    block = _int(manifest.get('block') if isinstance(manifest, dict) else None, 'manifest block', 1)
    for v, what in ((history_from, 'history start'), (state_from, 'state history start')):
        if type(v) is not int or not 0 < v <= block:
            raise ValueError(f'{what} must be an integer within (0, snapshot block {block}]')
    out = {'archives': [], 'selected': {}, 'snapshotBlock': block}
    for name, which in SELECTED.items():
        c = chunked(manifest, name)
        since, bpf = (history_from if which == 'history' else state_from), c['blocks_per_file']
        n, first = -(-c['total_blocks'] // bpf), first_chunk(c, history_from if which == 'history' else state_from, block)
        out['selected'][name] = {'declaredFloor': since, 'firstChunk': first, 'lastChunk': n - 1, 'chunks': n - first,
                                 'firstBlockExtracted': first * bpf, 'legacyR2FirstChunk': since // bpf,
                                 'belowFloorChunks': sum(1 for i in range(first, n) if (i + 1) * bpf - 1 < since)}
        for i in range(first, n):
            out['archives'].append({'component': name, 'chunk': i, 'fromBlock': i * bpf, 'toBlock': (i + 1) * bpf - 1,
                                    'belowDeclaredFloor': (i + 1) * bpf - 1 < since, 'file': c['chunk_files'][i],
                                    'compressed': c['chunk_sizes'][i], 'extracted': c['chunk_decompressed_sizes'][i],
                                    'outputs': c['chunk_output_files'][i]})
    return out


def cli_all_archives(manifest):
    """headers (chunked) and state (single), which the CLI always plans and reuses when their outputs verify"""
    out = []
    h = chunked(manifest, 'headers')
    for i in range(len(h['chunk_files'])):
        out.append({'component': 'headers', 'chunk': i, 'file': h['chunk_files'][i], 'compressed': h['chunk_sizes'][i],
                    'extracted': h['chunk_decompressed_sizes'][i], 'outputs': h['chunk_output_files'][i]})
    s = manifest['components'].get('state')
    if not isinstance(s, dict) or not isinstance(s.get('file'), str):
        raise ValueError('manifest has no single state component')
    out.append({'component': 'state', 'chunk': None, 'file': s['file'], 'compressed': _int(s.get('size'), 'state.size'),
                'extracted': _int(s.get('decompressed_size'), 'state.decompressed_size'), 'outputs': _outputs(s.get('output_files'), 'state')})
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
    """ESTIMATE: full-chain rocksdb_indices scaled by the share of transaction bytes the CLI actually selects (upper-ish)."""
    t = chunked(manifest, 'transactions')
    first = first_chunk(t, history_from, manifest['block'])
    share = sum(t['chunk_decompressed_sizes'][first:]) / sum(t['chunk_decompressed_sizes'])
    rocks = manifest['components'].get('rocksdb_indices', {}).get('decompressed_size', 0)
    return int(rocks * share)


def daily_growth(manifest):
    """Bytes/day from the last FULL chunk of each retained segment (state DB growth not included)."""
    per_block = 0.0
    for name in ('transactions', 'receipts', 'account_changesets', 'storage_changesets', 'headers'):
        c = chunked(manifest, name)
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


def _sum(xs):
    return {'archives': len(xs), 'compressedBytes': sum(x['compressed'] for x in xs), 'extractedBytes': sum(x['extracted'] for x in xs)}


def report(manifest, datadir, history_from, state_from, growth_days, free, manifest_path, concurrency):
    p = plan(manifest, history_from, state_from)
    req, cli_all = p['archives'], cli_all_archives(manifest)
    missing = [x for x in req if not present(datadir, x['outputs'])]
    missing_all = [x for x in cli_all if not present(datadir, x['outputs'])]
    extra = [x for x in req if x['belowDeclaredFloor']]
    est = index_reserve_estimate(manifest, history_from)
    index_reserve = max(2 * est, MIN_INDEX_RESERVE)
    growth = daily_growth(manifest) * growth_days
    m, ma = _sum(missing), _sum(missing_all)
    need = m['compressedBytes'] + m['extractedBytes'] + ma['compressedBytes'] + ma['extractedBytes'] + index_reserve + growth
    rep = {'format': 'enclave-base-retention-preflight/r3', 'admitted': free >= need, 'freeBytes': free, 'needBytes': need,
           'headroomAfterBytes': free - need, 'snapshotBlock': p['snapshotBlock'],
           'declaredFloor': {'history': history_from, 'stateHistory': state_from}, 'readiness': READINESS,
           'required': {**_sum(req), 'byComponent': {k: v['chunks'] for k, v in p['selected'].items()}},
           'missing': {**m, 'byComponent': {k: sum(1 for x in missing if x['component'] == k) for k in SELECTED}},
           'belowDeclaredFloor': {**_sum(extra), 'missing': _sum([x for x in extra if x in missing]),
                                  'archivesList': [f"{x['component']}:{x['chunk']}" for x in extra],
                                  'note': 'selected by reth whole-chunk semantics; never a coverage/readiness claim'},
           'cliAlsoPlanned': {'archives': len(cli_all), 'missing': ma,
                              'byComponent': {k: sum(1 for x in cli_all if x['component'] == k) for k in CLI_ALL}},
           'selected': p['selected'], 'indexReserveBytes': index_reserve, 'indexEstimateBytes': est,
           'indexEstimate': 'ESTIMATE (not measured)', 'growthReserveBytes': growth, 'growthDays': growth_days,
           'dailyGrowthBytes': daily_growth(manifest),
           'command': command(datadir, manifest_path, history_from, state_from, concurrency)}
    if not rep['admitted']:
        rep['refusal'] = 'insufficient free space for missing archives + index reserve + growth reserve'
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
            manifest = json.loads(f.read())
        if a.free_bytes is not None:
            free = a.free_bytes
        else:
            v = os.statvfs(a.datadir)
            free = v.f_bavail * v.f_frsize
        rep = report(manifest, a.datadir, a.history_from, a.state_history_from, a.growth_days, free, a.manifest, a.download_concurrency)
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
        print(json.dumps({'admitted': False, 'refusal': f'input: {e}'}))
        return 3
    print(json.dumps(rep, indent=1, sort_keys=True))
    return 0 if rep['admitted'] else 3


if __name__ == '__main__':
    sys.exit(main())
