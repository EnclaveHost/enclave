"""Bound Base's retained history to a rolling window. Patches a guest chain_service.py in place.

python3 -I base_history_patch.py CHAIN_SERVICE_PY

Base keeps receipts, bodies and the tx-hash lookup from chain.json baseRetention.historyFromBlock (48000000)
with reth's absolute `before` mode, so history grew without bound: on prod r11 (2026-11-08) transactions and
receipts static files were 496 GiB of Base's 1.74 TiB and Base was the larger part of /vm's growth.

The reviewed reason for `before` still holds: in the pinned reth a `distance` profile deletes whole static
files while serving and bodies may lag receipts, so eth_getLogs could answer with silently missing logs
inside the range it serves (chain_service.py, base-retention-stage review). This patch keeps `before` and
only raises its block at each Base start: floor = the newest headers static file's first block minus
BASE_HISTORY_WINDOW, rounded down to a whole static file, never below historyFromBlock. A running Base
therefore serves one fixed range [floor, tip], exactly as with the reviewed absolute block.

- The prune flags for receipts, bodies and the tx-hash lookup name the floor, so reth prunes up to it. Its
  `before` branch now passes the block it is given instead of the persisted one, which never exceeds it
  (asserted, as before); for state history that block is stateHistoryFromBlock, unchanged.
- The start check requires the static files holding the floor (not historyFromBlock, which a previous
  run's pruning may have deleted).
- chain.json is untouched: its identity is what the coverage receipt reviewed, and the coverage, snapshot
  and state-history checks still use historyFromBlock and stateHistoryFromBlock as configured.

reth fixes its prune configuration at start, so the floor advances when Base restarts; build_image.py adds
a weekly timer that restarts enclave-rpc-base. 7000000 blocks is ~16 days at Base's 5 blocks/s, slightly
more than the 6.85M blocks served when this was written, so nothing served then is dropped at first start.
Blocks below the floor answer as blocks below historyFromBlock always have.
The build re-pins identity.json afterwards.
"""
import sys

OLD_FLOOR = "        history_from = history_from_block(CONFIG, required=False) if side == 'base' else None\n"
NEW_FLOOR = OLD_FLOOR + ("        if history_from is not None:\n"
                         "            history_from = base_history_floor(datadir, profile, history_from)\n")
OLD_CHECK = "        history_files_present(datadir, profile, history_from)\n"
NEW_CHECK = "        history_files_present(datadir, profile, base_history_floor(datadir, profile, history_from))\n"
OLD_BEFORE = "        return [f'--prune.{flag}.before', str(mode['before'])]\n"
NEW_BEFORE = "        return [f'--prune.{flag}.before', str(history_from)]\n"
ANCHOR = 'def run(side):\n'
HELPER = '''BASE_HISTORY_WINDOW = 7000000


def base_history_floor(datadir, profile, configured):
    """First Base block whose receipts, bodies and lookup are kept: a whole static file, >= configured (base_history_patch.py)."""
    bpf = (profile.get('static_files') or {}).get('blocks_per_file') or {}
    n = bpf.get('receipts')
    assert _uint(n) and n > 0 and bpf.get('transactions') == n and bpf.get('headers'), 'Base static-file sizes unsuitable for a history window'
    starts = [int(m.group(1)) for m in (re.fullmatch(r'static_file_headers_(\\d+)_\\d+', p.name)
                                        for p in pathlib.Path(datadir, 'static_files').iterdir()) if m]
    assert starts, 'Base headers static files absent'
    return max(configured, (max(starts) - BASE_HISTORY_WINDOW) // n * n)


'''


def patch(path):
    s = open(path).read()
    for old in (OLD_FLOOR, OLD_CHECK, OLD_BEFORE, ANCHOR):
        if s.count(old) != 1:
            raise SystemExit('Base history retention code not found exactly once in %s: %r' % (path, old[:60]))
    if 'import re\n' not in s:
        raise SystemExit('chain_service.py no longer imports re')
    s = s.replace(OLD_FLOOR, NEW_FLOOR).replace(OLD_CHECK, NEW_CHECK).replace(OLD_BEFORE, NEW_BEFORE)
    open(path, 'w').write(s.replace(ANCHOR, HELPER + ANCHOR))


if __name__ == '__main__':
    patch(sys.argv[1])
