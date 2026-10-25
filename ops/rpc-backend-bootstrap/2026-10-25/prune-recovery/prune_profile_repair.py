#!/usr/bin/env python3
"""One-time, missing-only repair of a reth.toml whose snapshot prune profile was erased by the launcher defect.

Defect (base/reth 7134be3 crates/node/builder/src/launch/common.rs:190-212, reproduced offline with the pinned
base v1.5.1 binary): a launch with ONLY `--prune.transaction-lookup.distance 140000` makes the client replace the
whole [prune] section with the CLI-only config and save it. The result is exactly:

    [prune]
    block_interval = 5
    minimum_pruning_distance = 10064

    [prune.segments.transaction_lookup]
    distance = 140000

This tool recognizes ONLY that exact parsed signature (and that exact text shape), confirms the pinned client
binary, and inserts the five missing segment entries in the client's own serialization order and format:
sender_recovery = "full" and {distance = 140000} for receipts, account_history, storage_history, bodies_history.
It changes nothing else: every other byte is preserved, and the parsed result must equal the original plus
exactly those entries. It is not a generic auto-heal. Anything else is refused.

Run only with the client unit AND its .path unit stopped. Default is a dry run. --apply additionally requires
--expect-sha256 of the current file (bind the exact observed bytes), keeps an O_EXCL backup next to it, and
replaces atomically (same mode/owner, fsync file + directory).

Exit 0 = repaired (or dry run would repair); 2 = refused; nothing is written on refusal.
"""
import argparse
import hashlib
import os
import sys
import tomllib

PINNED = {  # stage_backend.py pins
    'reth': '8cdd1f35e00558a40ff19001752c4b4fa3ea885c88d1c704348ba88248f6d250',   # reth v2.8.0 (Ethereum EL)
    'base': '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f',   # base v1.5.1 (Base EL)
}
DISTANCE = 140000
DEFECT = {'block_interval': 5, 'minimum_pruning_distance': 10064,
          'segments': {'transaction_lookup': {'distance': DISTANCE}}}
INTENDED = {'block_interval': 5, 'minimum_pruning_distance': 10064,
            'segments': {'sender_recovery': 'full', 'transaction_lookup': {'distance': DISTANCE},
                         **{k: {'distance': DISTANCE} for k in ('receipts', 'account_history', 'storage_history',
                                                                 'bodies_history')}}}
LOOKUP_HEADER = '[prune.segments.transaction_lookup]'
BEFORE_LOOKUP = '[prune.segments]\nsender_recovery = "full"\n\n'
AFTER_LOOKUP = ''.join(f'\n[prune.segments.{k}]\ndistance = {DISTANCE}\n'
                       for k in ('receipts', 'account_history', 'storage_history', 'bodies_history'))
MAX_BYTES = 1 << 20
BACKUP_SUFFIX = '.pre-prune-repair'


class Refuse(Exception):
    pass


def sha(b):
    return hashlib.sha256(b).hexdigest()


def plan(raw):
    """Return the repaired bytes for an exact defect file, or raise Refuse."""
    try:
        text = raw.decode('utf-8')
        doc = tomllib.loads(text)
    except (UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
        raise Refuse(f'reth.toml is not valid UTF-8 TOML: {e}')
    if doc.get('prune') == INTENDED:
        raise Refuse('prune profile already complete: nothing to repair')
    if doc.get('prune') != DEFECT:
        raise Refuse(f'prune section is not the exact known defect signature: {doc.get("prune")!r}')
    bpf = (doc.get('static_files') or {}).get('blocks_per_file')
    if not (isinstance(bpf, dict) and bpf):
        raise Refuse('static_files.blocks_per_file missing: this is not the snapshot datadir profile')
    lines = text.split('\n')
    headers = [i for i, l in enumerate(lines) if l.startswith('[prune')]
    if [lines[i] for i in headers] != ['[prune]', LOOKUP_HEADER]:
        raise Refuse(f'unexpected prune table layout: {[lines[i] for i in headers]}')
    i = headers[1]
    if lines[i - 1] != '' or lines[i + 1] != f'distance = {DISTANCE}' or lines[i + 2] != '':
        raise Refuse('transaction_lookup table is not in the client serialization shape')
    new_text = '\n'.join(lines[:i]) + '\n' + BEFORE_LOOKUP + '\n'.join(lines[i:i + 2]) + '\n' + AFTER_LOOKUP \
        + '\n'.join(lines[i + 2:])
    new_doc = tomllib.loads(new_text)
    old_rest = {k: v for k, v in doc.items() if k != 'prune'}
    new_rest = {k: v for k, v in new_doc.items() if k != 'prune'}
    if new_doc.get('prune') != INTENDED or new_rest != old_rest:
        raise Refuse('internal check failed: repaired file would not equal original plus the missing entries')
    added = len(new_text) - len(text)
    if added != len(BEFORE_LOOKUP) + len(AFTER_LOOKUP) or not new_text.startswith(text[:text.index(LOOKUP_HEADER)]):
        raise Refuse('internal check failed: repair would change existing bytes')
    return new_text.encode('utf-8')


def check_binary(client, path):
    with open(path, 'rb') as f:
        got = hashlib.file_digest(f, 'sha256').hexdigest()
    if got != PINNED[client]:
        raise Refuse(f'{client} binary {path} sha256 {got} is not the pinned {PINNED[client]}')


def apply(path, raw, new):
    st = os.lstat(path)
    backup = path + BACKUP_SUFFIX
    tmp = path + '.prune-repair.tmp'
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, st.st_mode & 0o7777)
    try:
        os.write(fd, raw)
        os.fsync(fd)
    finally:
        os.close(fd)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, st.st_mode & 0o7777)
    try:
        if os.geteuid() == 0:
            os.fchown(fd, st.st_uid, st.st_gid)
        os.write(fd, new)
        os.fsync(fd)
    finally:
        os.close(fd)
    with open(path, 'rb') as f:   # still the bytes we planned from (no concurrent writer)
        if f.read(MAX_BYTES + 1) != raw:
            os.unlink(tmp)
            raise Refuse('reth.toml changed during repair (is the client running?); nothing replaced')
    os.replace(tmp, path)
    dfd = os.open(os.path.dirname(os.path.abspath(path)), os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    return backup


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--reth-toml', required=True)
    ap.add_argument('--client', required=True, choices=sorted(PINNED))
    ap.add_argument('--binary', required=True, help='the installed client binary (sha256-pinned)')
    ap.add_argument('--expect-sha256', help='sha256 of the current reth.toml; required with --apply')
    ap.add_argument('--apply', action='store_true')
    a = ap.parse_args(argv)
    try:
        check_binary(a.client, a.binary)
        st = os.lstat(a.reth_toml)
        if not os.path.isfile(a.reth_toml) or os.path.islink(a.reth_toml) or st.st_size > MAX_BYTES:
            raise Refuse('reth.toml must be a regular, non-symlink file under 1 MiB')
        with open(a.reth_toml, 'rb') as f:
            raw = f.read(MAX_BYTES + 1)
        if a.expect_sha256 is not None and sha(raw) != a.expect_sha256:
            raise Refuse(f'reth.toml sha256 {sha(raw)} != --expect-sha256')
        new = plan(raw)
        if os.path.lexists(a.reth_toml + BACKUP_SUFFIX):
            raise Refuse('a previous repair backup exists: this is a one-time repair, inspect manually')
        print(f'before sha256 {sha(raw)}  after sha256 {sha(new)}')
        print('inserting:\n' + BEFORE_LOOKUP + LOOKUP_HEADER + f'\ndistance = {DISTANCE}\n' + AFTER_LOOKUP)
        if not a.apply:
            print('DRY RUN: nothing written (use --apply --expect-sha256 <before>)')
            return 0
        if a.expect_sha256 is None:
            raise Refuse('--apply requires --expect-sha256 of the observed file')
        backup = apply(a.reth_toml, raw, new)
        print(f'REPAIRED {a.reth_toml}; original preserved at {backup}')
        return 0
    except (Refuse, OSError) as e:
        print(f'REFUSED: {e}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
