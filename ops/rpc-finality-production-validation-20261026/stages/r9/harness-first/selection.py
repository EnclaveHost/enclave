"""Exact Base snapshot archive selection, derived from the PINNED manifest and an explicitly pinned retention profile.

Pinned reth 7134be3 `crates/cli/commands/src/download`:
  - with explicit `--with-*` flags, State and Headers are `All`; Transactions/Receipts/{Account,Storage}Changesets get
    `Since(b)` or `Distance(d)`; Senders only with `--with-senders`, RocksDB only with `--with-rocksdb` (mod.rs:721-777);
  - `Since(b)` -> distance `block - b + 1` (planning.rs:190-200) -> whole chunks from the one containing the first block;
  - every planned archive MUST carry plain output checksums or the client bails (planning.rs `collect_planned_archives`).
Profiles:
  first-pass-distance-140000  the initial download (`--with-{txs,receipts,state-history}-distance 140000`): 116 archives
  final-h48000000-s52500000   root's approved cached second download (option B, base-retention-stage/v2/
                              cached_download_preflight.py `command`): txs/receipts since 48,000,000, state history since 52,500,000
Only the FINAL profile is readiness for A2-A4; a first-pass receipt stays distinguishable and is refused there.
"""
PROFILES = {
    'first-pass-distance-140000': {'flags': {'--with-txs-distance': 140000, '--with-receipts-distance': 140000,
                                             '--with-state-history-distance': 140000}, 'final': False},
    'final-h48000000-s52500000': {'flags': {'--with-txs-since': 48000000, '--with-receipts-since': 48000000,
                                            '--with-state-history-since': 52500000}, 'final': True},
}
FINAL_PROFILE = 'final-h48000000-s52500000'
CHUNKED = {'transactions': 'txs', 'receipts': 'receipts', 'account_changesets': 'state-history', 'storage_changesets': 'state-history'}
BASE_BINARY = '/opt/enclave-rpc/bin/base'
BASE_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'   # outputs/.../base-cli-help-2025/help.out
DOWNLOAD_CONCURRENCY = '16'
# The ONLY tokens a download invocation may contain after `<binary> snapshot download` (exact allowlist):
#   value flags (each exactly once, value = the next token): --chain base, --manifest-path P, --datadir D,
#     --download-concurrency 16, and the profile's three selection flags with their pinned values;
#   bare tokens (each exactly once): --resumable=true, -y
BARE_TOKENS = ('--resumable=true', '-y')


class SelectionError(Exception):
    pass


def _first_block(profile, which, block):
    f = PROFILES[profile]['flags']
    if f'--with-{which}-since' in f:
        return f[f'--with-{which}-since']
    return block - f[f'--with-{which}-distance'] + 1


def _chunks(comp):
    n = len(comp.get('chunk_sizes') or [])
    cof = comp.get('chunk_output_files') or []
    if n == 0 or len(cof) != n:
        raise SelectionError('chunked component without one checksum list per chunk')
    return n


def derive(manifest, profile):
    """-> set of (component, chunk|None) the pinned client plans for `profile` on this manifest."""
    if profile not in PROFILES:
        raise SelectionError(f'unknown profile {profile!r}')
    block, comps = manifest['block'], manifest['components']
    out = {('state', None)}
    for i in range(_chunks(comps['headers'])):
        out.add(('headers', i))
    for name, which in CHUNKED.items():
        c = comps[name]
        first = _first_block(profile, which, block) // c['blocks_per_file']
        if first < 0:
            raise SelectionError('selection starts before genesis')
        out |= {(name, i) for i in range(first, _chunks(c))}
    return out


def validate_entries(entries, manifest):
    """Strict shape: list of {'component': str, 'chunk': None|int>=0 in range}, unique. -> set of (component, chunk)."""
    if not isinstance(entries, list) or not entries:
        raise SelectionError('selectedArchives must be a non-empty list')
    seen = set()
    for a in entries:
        if not isinstance(a, dict) or set(a) != {'component', 'chunk'} or not isinstance(a['component'], str):
            raise SelectionError(f'malformed entry {a!r}')
        comp = manifest['components'].get(a['component'])
        if comp is None:
            raise SelectionError(f'{a["component"]} is not a manifest component')
        ch = a['chunk']
        if 'file' in comp:
            if ch is not None:
                raise SelectionError(f'{a["component"]} is a single archive: chunk must be null')
        elif type(ch) is not int or ch < 0 or ch >= _chunks(comp):
            raise SelectionError(f'{a["component"]}: chunk {ch!r} is not an integer in [0, {_chunks(comp)})')
        key = (a['component'], ch)
        if key in seen:
            raise SelectionError(f'duplicate entry {key}')
        seen.add(key)
    return seen


def checksums(manifest, key):
    comp = manifest['components'][key[0]]
    return comp.get('output_files') if key[1] is None else comp['chunk_output_files'][key[1]]


def check_argv(argv, profile, datadir, manifest_path):
    """EXACT download invocation for `profile` (observed real first pass, ExecStart 21:02: `/opt/enclave-rpc/bin/base snapshot
    download --chain base --with-txs-distance 140000 --with-receipts-distance 140000 --with-state-history-distance 140000
    --manifest-path /opt/enclave-rpc/snapshots/base-1792886410-manifest.json --datadir /srv/enclave-base-holder/data
    --download-concurrency 16 --resumable=true -y`; final profile = cached_download_preflight.py `command`). Order of the
    flag/value pairs is free; content, cardinality and values are exact; anything else refuses."""
    if profile not in PROFILES:
        raise SelectionError(f'unknown profile {profile!r}')
    if not isinstance(argv, list) or not all(isinstance(x, str) for x in argv) or len(argv) < 3:
        raise SelectionError('argv must be a list of strings')
    if argv[:3] != [BASE_BINARY, 'snapshot', 'download']:
        raise SelectionError(f'argv must start with [{BASE_BINARY!r}, "snapshot", "download"]')
    want = {'--chain': 'base', '--manifest-path': manifest_path, '--datadir': datadir, '--download-concurrency': DOWNLOAD_CONCURRENCY,
            **{k: str(v) for k, v in PROFILES[profile]['flags'].items()}}
    seen, bare, i, rest = {}, [], 0, argv[3:]
    while i < len(rest):
        t = rest[i]
        if t in BARE_TOKENS:
            if t in bare:
                raise SelectionError(f'duplicate {t}')
            bare.append(t); i += 1; continue
        if t not in want:
            raise SelectionError(f'unlisted token {t!r}')
        if t in seen:
            raise SelectionError(f'duplicate {t}')
        if i + 1 >= len(rest):
            raise SelectionError(f'{t} has no value')
        seen[t] = rest[i + 1]; i += 2
    if set(seen) != set(want) or sorted(bare) != sorted(BARE_TOKENS):
        raise SelectionError(f'missing {sorted(set(want) - set(seen)) + sorted(set(BARE_TOKENS) - set(bare))}')
    for k, v in want.items():
        if seen[k] != v:
            raise SelectionError(f'{k} {seen[k]!r} != {v!r}')
