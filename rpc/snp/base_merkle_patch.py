"""Pin reth's [stages.merkle] for Base on every start. Patches a guest chain_service.py in place.

python3 -I base_merkle_patch.py CHAIN_SERVICE_PY

Base's reth.toml comes from the snapshot with reth's Ethereum defaults, incremental_threshold 7000 and
rebuild_threshold 100000 (reth 7134be3 crates/config MerkleConfig). A merkle gap over 100000 blocks clears the
trie tables and rebuilds the whole state trie. On Base (5 blocks/s) 100000 blocks is 5.5 h and the rebuild
took ~8.5 h on r11 (2026-11-07), so any restart that leaves Base 5.5 h behind rebuilds, and a rebuild that
outlasts 5.5 h leaves a gap that rebuilds again. The incremental path in 2000-block chunks caught up 243k
blocks in ~45 min under Base's 30 GiB MemoryHigh, with no thrash (prod r11, 2026-11-07 13:12-13:58Z).

So before reth starts the guest sets incremental_threshold 2000 and rebuild_threshold 5000000 (~11.6 days of
Base). A rebuild then needs a gap over 5000000 blocks, and the gap it leaves behind goes incremental.
Only [stages.merkle] changes: the rewrite is checked to parse to the same document otherwise, keeps the file
mode, and replaces it atomically. reth itself rewrites reth.toml at start (save_pruning_config) and keeps
these values. The file is on the host's chain disk like the rest of the L2 state; the values change how the
trie is computed, never the state root reth checks.

One case this cannot see: a rebuild already in progress (its MerkleCheckpoint lives in MDBX). Switching that
datadir to incremental recomputes the cleared trie in one uncommitted transaction and exhausts memory (prod r11,
2026-11-07 01:15-04:35Z). Before shipping this to a datadir whose current settings could have started a
rebuild, confirm Base's MerkleExecute is not mid-rebuild (no stage_progress below 100% on MerkleExecute).
"""
import sys

OLD = """        history_files_present(datadir, profile, history_from)
        segment_files_present(datadir, profile, state_from, STATE_FILES)
"""
NEW = """        history_files_present(datadir, profile, history_from)
        segment_files_present(datadir, profile, state_from, STATE_FILES)
        base_merkle_config(datadir)
"""
ANCHOR = 'def run(side):\n'
HELPER = '''BASE_MERKLE_STAGE = {'incremental_threshold': 2000, 'rebuild_threshold': 5000000}


def base_merkle_config(datadir):
    """Set reth's [stages.merkle] in Base's reth.toml, changing nothing else (base_merkle_patch.py)."""
    path = pathlib.Path(datadir, 'reth.toml')
    text = path.read_text()
    doc = tomllib.loads(text)
    stages = doc.get('stages', {})
    if stages.get('merkle') == BASE_MERKLE_STAGE:
        return 'unchanged'
    kept, skip = [], False
    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith('['):
            skip = line.split('#', 1)[0].strip() == '[stages.merkle]'
        if not skip:
            kept.append(line)
    body = ''.join(kept)
    if body and not body.endswith('\\n'):
        body += '\\n'
    body += '\\n[stages.merkle]\\n' + ''.join('%s = %d\\n' % kv for kv in BASE_MERKLE_STAGE.items())
    assert tomllib.loads(body) == {**doc, 'stages': {**stages, 'merkle': BASE_MERKLE_STAGE}}, \\
        'reth.toml [stages.merkle] rewrite would change other settings'
    tmp = path.with_name('reth.toml.tmp')
    tmp.write_text(body)
    os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
    os.replace(tmp, path)
    print(json.dumps({'baseMerkleStage': BASE_MERKLE_STAGE, 'previous': stages.get('merkle')}), flush=True)
    return 'set'


'''


def patch(path):
    s = open(path).read()
    if s.count(OLD) != 1 or s.count(ANCHOR) != 1:
        raise SystemExit('Base retention file checks not found exactly once in ' + path)
    open(path, 'w').write(s.replace(OLD, NEW).replace(ANCHOR, HELPER + ANCHOR))


if __name__ == '__main__':
    patch(sys.argv[1])
