#!/usr/bin/env python3
"""Download/extracted sizes of a reth v2 modular snapshot manifest for the --minimal and --full presets.

Replicates, without changing them, base/reth 7134be3b crates/cli/commands/src/download:
  mod.rs pruning_selection_for_component (state + headers: all; rocksdb indices: none; others from prune modes),
  node/core/src/args/pruning.rs DefaultPruningValues (MINIMUM_UNWIND_SAFE_DISTANCE = 10064, MINIMUM_DISTANCE = 64),
  manifest.rs size_for_distance / output_size_for_distance / tail_chunks_for_distance.
Full preset: bodies since Paris (Base: Paris at genesis is NOT assumed; reported both ways), senders none."""
import json, sys
U, M64 = 32 * 2 + 10_000, 64
MINIMAL = {'state': None, 'headers': None, 'transactions': U, 'receipts': M64, 'account_changesets': U, 'storage_changesets': U}
FULL = {'state': None, 'headers': None, 'receipts': U, 'account_changesets': U, 'storage_changesets': U}  # + transactions since Paris

def sizes(comp, distance):
    if 'chunk_sizes' not in comp:        # single archive
        out = comp.get('decompressed_size') or sum(f.get('size', 0) for f in comp.get('output_files', [])) or None
        return comp['size'], out, 1
    tb, bpf = comp['total_blocks'], comp['blocks_per_file']
    n = -(-tb // bpf)
    start = 0
    if distance is not None:
        need = min(distance, tb)
        start = n - (n - (tb - need) // bpf) if need else n
    dl = sum(comp['chunk_sizes'][start:])
    dec = comp.get('chunk_decompressed_sizes') or []
    out = sum(dec[start:]) if dec else (sum(sum(f['size'] for f in fs) for fs in comp.get('chunk_output_files', [])[start:]) or None)
    return dl, out, n - start

m = json.load(open(sys.argv[1]))
print(json.dumps({'block': m['block'], 'chain_id': m['chain_id'], 'reth_version': m['reth_version'], 'storage_version': m['storage_version'],
                  'components': sorted(m['components'])}))
for name, preset in (('minimal', MINIMAL), ('full (without transactions-since-Paris)', FULL)):
    tdl = tout = 0
    for k, d in preset.items():
        dl, out, chunks = sizes(m['components'][k], d)
        tdl += dl; tout += out or 0
        print('  %-8s %-20s distance=%-6s chunks=%-4d download=%8.1f GB extracted=%s' % (name.split()[0], k, d, chunks, dl / 1e9, '%.1f GB' % (out / 1e9) if out else 'not in manifest'))
    print('%s: download %.1f GB, extracted %.1f GB' % (name, tdl / 1e9, tout / 1e9))
for k in ('transaction_senders', 'rocksdb_indices', 'proofs', 'transactions'):
    dl, out, chunks = sizes(m['components'][k], None)
    print('  (not in minimal) %-20s all: download %.1f GB extracted %s' % (k, dl / 1e9, '%.1f GB' % (out / 1e9) if out else '?'))
