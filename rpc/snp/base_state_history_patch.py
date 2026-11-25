"""Bound Base's retained state history to a rolling window. Patches a guest chain_service.py in place, after
base_history_patch.py.

python3 -I base_state_history_patch.py CHAIN_SERVICE_PY

Base keeps account and storage changesets from chain.json baseRetention.stateHistoryFromBlock (52500000) with reth's
absolute `before` mode, and base_history_patch.py left that floor where it was. Nothing bounds it: on prod r15
(2026-11-24) the two changeset segments were 174 GiB of Base's 1382 GiB (storage 156.6, account 17.7; 92 GiB on
2026-11-08), about 8 GiB more every day, and the history indexes for the same range sit in MDBX.

Why the floor was fixed (ops/rpc-backend-bootstrap/2026-10-25/finality-investigation/anchor-bootstrap-review,
decision R1): reth refuses an unwind below the state-history prune floor, and the anchor bootstrap (unwind to a
finalized anchor, then rebuild and check the state there) needs an anchor at or above that floor. A `distance`
profile of 140000 blocks was too short to be sure of ever meeting one, and deletes whole changeset files while
serving. That bootstrap has not been run on production (ops/rpc-snp-prod-r7/ROOT-RESULT.md records none).

This patch keeps `before`: the floor becomes the newest headers static file's first block minus
BASE_STATE_HISTORY_WINDOW, rounded down to a whole changeset file, never below stateHistoryFromBlock. Every block
of the last window can still be unwound to. eth_getProof serves 1800 blocks and nothing else here reads state
history, so no request changes its answer.

The window has to hold the anchor, and the anchor is old. It is the AnchorStateRegistry's finalized game, which
finalizes only after its challenge clock and the finality delay: read on 2026-11-25 00:23Z (getAnchorRoot at L1
finalized, public endpoints, not attested) it was L2 block 59694360, 2184313 blocks behind the tip, 5.06 days.
The floor moves only when Base restarts, weekly (3024000 blocks), so just before a restart the anchor of the day
is up to 2.2M + 3.0M blocks above a floor set a week earlier, and the floor is rounded down by up to 500000 more.
7000000 blocks (16 days, the transaction window of base_history_patch.py) covers that with about 1.8M to spare.
A first build of this patch used 2000000: that window did not contain the anchor at all and would have ended the
option at its first start (image r16; started once for 50 s on 2026-11-25, stopped before Base ran, superseded).
What is given up is unwinding to an anchor OLDER than the window, down to 52500000, and with it R1 as written
("hold the floor at 52500000"). If the anchor ever trails by more than the margin, widen the window first.

- The prune flags for account and storage history name the floor (the `before` branch already passes the block it
  is given, base_history_patch.py), so reth prunes the changeset files and the history indexes below it.
- The start check requires the changeset files holding the floor instead of stateHistoryFromBlock's, which an
  earlier run's pruning will have deleted.
- chain.json is untouched, and the snapshot check still compares stateHistoryFromBlock as configured.

As with the history floor, reth fixes its prune configuration at start: the floor advances when Base restarts (the
weekly timer of base_history_patch.py). Not measured: how long the FIRST start takes to prune the indexes of the
blocks that fall below the window (the changeset files themselves are deleted whole): about 2 million at the
first start, 4 of the 19 files of 2026-11-24.
The build re-pins identity.json afterwards.
"""
import sys

OLD_FLOOR = "        state_from = state_history_from_block(CONFIG, required=False) if side == 'base' else None\n"
NEW_FLOOR = OLD_FLOOR + ("        if state_from is not None:\n"
                         "            state_from = base_state_history_floor(datadir, profile, state_from)\n")
OLD_CHECK = "        segment_files_present(datadir, profile, state_from, STATE_FILES)\n"
NEW_CHECK = ("        segment_files_present(datadir, profile, base_state_history_floor(datadir, profile, state_from), "
             "STATE_FILES)\n")
REQUIRED = "        return [f'--prune.{flag}.before', str(history_from)]\n"   # base_history_patch.py's `before` branch
ANCHOR = 'def run(side):\n'
HELPER = '''BASE_STATE_HISTORY_WINDOW = 7000000


def base_state_history_floor(datadir, profile, configured):
    """First Base block whose account and storage changesets are kept: a whole static file, >= configured
    (base_state_history_patch.py)."""
    bpf = (profile.get('static_files') or {}).get('blocks_per_file') or {}
    n = bpf.get('storage_change_sets')
    assert _uint(n) and n > 0 and bpf.get('account_change_sets') == n and bpf.get('headers'), \\
        'Base static-file sizes unsuitable for a state-history window'
    assert BASE_STATE_HISTORY_WINDOW >= RETAINED_BLOCKS, 'Base state-history window shorter than the retained range'
    starts = [int(m.group(1)) for m in (re.fullmatch(r'static_file_headers_(\\d+)_\\d+', p.name)
                                        for p in pathlib.Path(datadir, 'static_files').iterdir()) if m]
    assert starts, 'Base headers static files absent'
    return max(configured, (max(starts) - BASE_STATE_HISTORY_WINDOW) // n * n)


'''


def patch(path):
    s = open(path).read()
    for old in (OLD_FLOOR, OLD_CHECK, ANCHOR):
        if s.count(old) != 1:
            raise SystemExit('Base state-history retention code not found exactly once in %s: %r' % (path, old[:60]))
    if s.count(REQUIRED) != 2 or 'def base_history_floor(' not in s:
        raise SystemExit('base_history_patch.py must be applied to %s first' % path)
    if 'import re\n' not in s:
        raise SystemExit('chain_service.py no longer imports re')
    s = s.replace(OLD_FLOOR, NEW_FLOOR).replace(OLD_CHECK, NEW_CHECK)
    open(path, 'w').write(s.replace(ANCHOR, HELPER + ANCHOR))


if __name__ == '__main__':
    patch(sys.argv[1])
