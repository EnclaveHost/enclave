#!/usr/bin/env python3
"""Offline, non-mutating extraction of a Base snapshot's persisted forkchoice labels and their L1 origins.

Uses only the pinned client's own read-only inspection commands (`base reth db get`, AccessRights::RO in
reth base-v2.5.2.8 crates/cli/commands/src/db/mod.rs). It refuses unless DATADIR is on a read-only mount,
so even an unexpected write by the tool fails instead of touching the snapshot. Never start the node to
obtain these values: startup runs forkchoice updates that move the labels.

What Base v1.5.1 reads at restart (crates/consensus/engine/src/sync/forkchoice.rs):
  safe      = reth eth_getBlockByNumber("safe"), loaded from MDBX ChainState[LastSafeBlock]
              (reth blockchain_provider.rs:119); absent -> falls back to finalized
  finalized = ChainState[LastFinalizedBlock]; absent -> L2 genesis
  unsafe    = latest canonical block (StageCheckpoints[Finish])
Each label's L1 origin is decoded from its first transaction, the L1-attributes deposit
(crates/common/consensus/src/info/*: bedrock/ecotone/isthmus/jovian layouts).

Pinned-binary fact (found by jobs/real-origin.sh): reth's RO RocksDB open is a *secondary* instance that
creates `<parent of rocksdb path>/rocksdb-secondary-tmp-<pid>` (base/reth 7134be3
storage/provider/src/providers/rocksdb/provider.rs:429-434). The supported `--datadir.rocksdb` flag moves that
parent: the extractor builds an isolated view SCRATCH/view/rocksdb -> DATADIR/rocksdb (a symlink into the
read-only mount), so the secondary's temp files land in SCRATCH while MDBX, static files and RocksDB data stay
on the read-only mount.

usage: origin_extract.py --base-bin PATH --base-sha256 HEX --datadir DIR --scratch EMPTY_DIR --out FILE
Exit 0 = JSON written (status SAFE_HEAD_PERSISTED or NO_PERSISTED_SAFE_HEAD); exit 2 = refusal.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

FORMAT = 'enclave-base-snapshot-origin/v1'
MAX_OUTPUT = 4 << 20
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')

# selector -> (calldata length, layout). Lengths/offsets from base-v1.5.1 crates/common/consensus/src/info.
L1_INFO = {
    '015d8eb9': (4 + 32 * 8, 'bedrock'),
    '440a5e20': (4 + 32 * 5, 'ecotone'),
    '098999be': (4 + 32 * 5 + 4 + 8, 'isthmus'),
    '3db6be2b': (4 + 32 * 5 + 4 + 8 + 2, 'jovian'),
}


class Refusal(Exception):
    pass


def decode_l1_info(data_hex):
    """Return the L1 origin (number, hash), sequence number and batcher address from L1-info calldata."""
    if not isinstance(data_hex, str) or not re.fullmatch(r'0x([0-9a-fA-F]{2})+', data_hex):
        raise Refusal('L1-info calldata is not hex')
    r = bytes.fromhex(data_hex[2:])
    sel = r[:4].hex()
    if sel not in L1_INFO:
        raise Refusal(f'first transaction is not an L1-attributes deposit (selector {sel})')
    length, layout = L1_INFO[sel]
    if len(r) != length:
        raise Refusal(f'{layout} L1-info calldata length {len(r)} != {length}')
    if layout == 'bedrock':
        # setL1BlockValues(uint64 number, uint64 ts, uint256 basefee, bytes32 hash, uint64 seq, bytes32 batcherHash, ...)
        word = lambda i: r[4 + 32 * i: 4 + 32 * (i + 1)]
        number, block_hash, seq, batcher = int.from_bytes(word(0), 'big'), word(3), int.from_bytes(word(4), 'big'), word(5)
        if any(word(i)[:24] != bytes(24) for i in (0, 1, 4)):
            raise Refusal('bedrock L1-info uint64 word has high bits set')
    else:
        number = int.from_bytes(r[28:36], 'big')
        seq = int.from_bytes(r[12:20], 'big')
        block_hash, batcher = r[100:132], r[132:164]
    if batcher[:12] != bytes(12):
        raise Refusal('batcherHash is not a version-0 address')
    return {'layout': layout, 'l1Origin': {'number': number, 'hash': '0x' + block_hash.hex()},
            'sequenceNumber': seq, 'batcher': '0x' + batcher[12:].hex()}


def _json_after(text, marker=None):
    """First JSON value in reth's println output (logs/ANSI removed); after `marker` line if given."""
    text = ANSI.sub('', text)
    if 'No content for the given table key' in text:
        return None
    if marker is not None:
        m = re.search(r'(?m)^' + re.escape(marker) + r'\s*$', text)
        if m is None:
            raise Refusal(f'reth output lacks {marker!r} section')
        text = text[m.end():]
    dec = json.JSONDecoder()
    for m in re.finditer(r'(?m)^[\[{"0-9]', text):
        try:
            value, end = dec.raw_decode(text, m.start())
        except json.JSONDecodeError:
            continue
        # A log line such as `2026-10-25T...` decodes as 2026; only a value that ends its line counts.
        if text[end:].split('\n', 1)[0].strip() == '':
            return value
    raise Refusal('reth output contained no JSON value')


def _int(v, where):
    if isinstance(v, int) and not isinstance(v, bool):
        return v
    if isinstance(v, str) and re.fullmatch(r'0x[0-9a-fA-F]+', v):
        return int(v, 16)
    if isinstance(v, str) and v.isdigit():
        return int(v)
    raise Refusal(f'{where}: not an integer: {v!r}')


def _find_input(obj, depth=0):
    if depth > 6:
        return None
    if isinstance(obj, dict):
        if isinstance(obj.get('input'), str):
            return obj
        for v in obj.values():
            hit = _find_input(v, depth + 1)
            if hit is not None:
                return hit
    return None


class Reader:
    def __init__(self, base_bin, datadir, timeout, scratch):
        self.base_bin, self.datadir, self.timeout = base_bin, datadir, timeout
        self.calls = []
        self.scratch = scratch
        self.home = os.path.join(scratch, 'home')
        os.mkdir(self.home)
        self.rocksdb_view = os.path.join(scratch, 'view', 'rocksdb')

    def get(self, *args, marker=None):
        argv = [self.base_bin, 'reth', 'db', '--chain', 'base', '--datadir', self.datadir,
                '--datadir.rocksdb', self.rocksdb_view, 'get', *args]
        env = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': self.home, 'XDG_CACHE_HOME': self.home,
               'NO_COLOR': '1', 'RUST_LOG': 'error'}
        try:
            p = subprocess.run(argv, env=env, cwd=self.scratch, stdin=subprocess.DEVNULL, capture_output=True,
                               timeout=self.timeout)
        except subprocess.TimeoutExpired:
            raise Refusal(f'reth db get {" ".join(args)} timed out after {self.timeout}s')
        out = (p.stdout[:MAX_OUTPUT] + b'\n' + p.stderr[:MAX_OUTPUT]).decode('utf-8', 'replace')
        self.calls.append({'argv': argv[1:], 'rc': p.returncode})
        if p.returncode != 0:
            raise Refusal(f'reth db get {" ".join(args)} exited {p.returncode}: {ANSI.sub("", out)[-400:].strip()}')
        return _json_after(out, marker)

    def chain_state(self, key):
        v = self.get('mdbx', 'ChainState', json.dumps(key))
        return None if v is None else _int(v, f'ChainState[{key}]')

    def block(self, number, label, progress):
        hdr = self.get('static-file', 'headers', str(number), marker='Header')
        if hdr is None:
            raise Refusal(f'{label} block {number}: header not found in static files')
        out = self.get('static-file', 'headers', str(number), marker='BlockHash')
        if not (isinstance(out, str) and re.fullmatch(r'0x[0-9a-f]{64}', out)):
            raise Refusal(f'{label} block {number}: block hash unreadable')
        progress[label + 'Header'] = {'number': number, 'hash': out}
        if _int(hdr.get('number'), 'header.number') != number:
            raise Refusal(f'{label} block {number}: header number mismatch')
        idx = self.get('mdbx', 'BlockBodyIndices', str(number))
        if idx is None or _int(idx.get('tx_count'), 'tx_count') < 1:
            raise Refusal(f'{label} block {number}: body pruned or empty (no L1-attributes deposit)')
        tx = self.get('static-file', 'transactions', str(_int(idx.get('first_tx_num'), 'first_tx_num')))
        dep = _find_input(tx)
        if dep is None:
            raise Refusal(f'{label} block {number}: first transaction body unreadable')
        if str(dep.get('type', '0x7e')).lower() not in ('0x7e', '126'):
            raise Refusal(f'{label} block {number}: first transaction is not a deposit')
        info = decode_l1_info(dep['input'])
        return {'number': number, 'hash': out, 'parentHash': hdr.get('parentHash'),
                'timestamp': _int(hdr.get('timestamp'), 'header.timestamp'), **info}


def read_only_mount(path):
    return bool(os.statvfs(path).f_flag & os.ST_RDONLY)


def prepare_scratch(datadir, scratch):
    scratch, data = os.path.realpath(scratch), os.path.realpath(datadir)
    if not os.path.isdir(scratch) or os.listdir(scratch):
        raise Refusal('--scratch must be an existing empty directory')
    if scratch == data or scratch.startswith(data + os.sep) or data.startswith(scratch + os.sep):
        raise Refusal('--scratch must be outside the snapshot datadir')
    if read_only_mount(scratch) or not os.access(scratch, os.W_OK):
        raise Refusal('--scratch must be writable')
    os.makedirs(os.path.join(scratch, 'view'))
    src = os.path.join(data, 'rocksdb')
    if os.path.isdir(src):
        if not read_only_mount(src):
            raise Refusal('snapshot rocksdb/ is not on a read-only mount')
        os.symlink(src, os.path.join(scratch, 'view', 'rocksdb'))
    return scratch


def extract(base_bin, base_sha256, datadir, timeout=300, progress=None, scratch=None):
    progress = {} if progress is None else progress
    with open(base_bin, 'rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != base_sha256:
            raise Refusal('base binary differs from its pinned sha256')
    if not os.path.isdir(os.path.join(datadir, 'db')):
        raise Refusal('datadir has no db/ (snapshot not extracted?)')
    if not (read_only_mount(datadir) and read_only_mount(os.path.join(datadir, 'db'))):
        raise Refusal('datadir is not on a read-only mount; bind-mount it read-only first (see RESULT.md)')
    if scratch is None:
        raise Refusal('--scratch is required (RocksDB secondary temp files must not touch the snapshot)')
    scratch = prepare_scratch(datadir, scratch)
    rd = Reader(base_bin, datadir, timeout, scratch)
    progress['calls'] = rd.calls
    safe_n = progress['lastSafeBlock'] = rd.chain_state('LastSafeBlock')
    fin_n = progress['lastFinalizedBlock'] = rd.chain_state('LastFinalizedBlock')
    finish = rd.get('mdbx', 'StageCheckpoints', json.dumps('Finish'))
    if finish is None:
        raise Refusal('StageCheckpoints[Finish] absent: no completed pipeline tip')
    tip_n = progress['finishBlock'] = _int(finish.get('block_number'), 'Finish.block_number')
    labels = {'tip': rd.block(tip_n, 'tip', progress)}
    labels['safe'] = rd.block(safe_n, 'safe', progress) if safe_n is not None else None
    labels['finalized'] = rd.block(fin_n, 'finalized', progress) if fin_n is not None else None
    for k in ('safe', 'finalized'):
        if labels[k] and labels[k]['number'] > tip_n:
            raise Refusal(f'{k} label {labels[k]["number"]} above tip {tip_n}')
    return {'format': FORMAT, 'chain': 'base-mainnet',
            'status': 'SAFE_HEAD_PERSISTED' if labels['safe'] else 'NO_PERSISTED_SAFE_HEAD',
            'labels': labels,
            'source': {'tool': 'base reth db get (AccessRights::RO)', 'binarySha256': base_sha256,
                       'datadirReadOnlyMount': True, 'rocksdbSecondaryScratch': scratch, 'calls': rd.calls}}


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-bin', required=True)
    ap.add_argument('--base-sha256', required=True)
    ap.add_argument('--datadir', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--scratch', required=True)
    ap.add_argument('--timeout', type=int, default=300)
    a = ap.parse_args(argv)
    progress = {}
    try:
        doc = extract(a.base_bin, a.base_sha256, a.datadir, a.timeout, progress, a.scratch)
        rc = 0
    except (Refusal, OSError) as e:
        doc, rc = {'format': FORMAT, 'status': 'REFUSED', 'refusal': str(e), 'progress': progress}, 2
    with open(a.out, 'x') as f:
        json.dump(doc, f, indent=1, sort_keys=True)
    print(json.dumps({'status': doc['status'], 'out': a.out}))
    return rc


if __name__ == '__main__':
    sys.exit(main())
