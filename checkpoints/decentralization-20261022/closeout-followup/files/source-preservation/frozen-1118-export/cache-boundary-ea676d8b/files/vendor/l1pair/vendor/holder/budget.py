#!/usr/bin/env python3
"""The shared NVMe cache budget of the RPC/storage work: ONE root-owned ledger for every package and host.

  budget.py validate LEDGER                     the ledger's own rules (no filesystem access)
  budget.py admit LEDGER RESERVATION_ID PATH=BYTES...
                                                (create preflight) the reservation exists for this host, names exactly
                                                 these files, its filesystem is supported with the declared block size;
                                                 present files are its own (interrupted creates are adopted)
  budget.py allocate LEDGER RESERVATION_ID      (holder-storage.sh create) lock, re-validate, allocate this reservation's
                                                 fixed-size files in bounded steps; prints "created PATH" for each file
                                                 and marker it made
  budget.py verify LEDGER RESERVATION_ID        (assemble / verify-cap) lock (shared), re-validate, check every local
                                                 reservation's ACTUAL allocation against its maximum; exit 3 out of bounds

Canonical identity: /etc/enclave-rpc-cache/nvme-cache-budget.json (format enclave-rpc-nvme-cache-budget/v2); the lock is
the sibling file <ledger>.lock (this budget only, never a host-wide lock).

Why a ledger of MAXIMA rather than measured usage:
  * every reservation is charged its declared maxBytes whether or not its files exist yet. A missing file is never
    counted as zero, and a participant that later grows cannot be fitted under an earlier measurement;
  * only HARD-BOUNDED kinds are admitted ("preallocated-files": fixed-size, fully allocated files whose size cannot grow
    through the consumer, e.g. dm-cache data/metadata, or a fixed image holding a cache filesystem). Directory entries
    are refused, because nothing bounds them;
  * per-host shares are fixed in the ledger and must sum to <= the 250,000,000,000-byte cap, so hosts that do not share
    a lock still cannot exceed the aggregate. Each host is also charged a fixed BOOKKEEPING_BYTES for the ledger, its
    lock and their directory blocks.

How a reservation's maxBytes bounds REAL allocation (v2; v1 charged declared bytes and allowed +64 MiB per file):
  * ACTUAL bytes of a reservation = st_blocks of its files and markers + a fixed directory-entry charge (one block per
    file, entry_bytes). Every bound below compares ACTUAL with maxBytes; there is no per-file allowance;
  * declared file sizes must be multiples of the reservation's blockBytes, which must equal the real filesystem's block
    size; only SUPPORTED_FS are accepted (others refused before anything is written);
  * slackBytes must be >= required_headroom(): per file one marker block (markers are <= MARKER_MAX_BYTES), one
    directory-entry block and 2x the ext4 extent tree of a contiguous fallocate; plus ONE allocation step's worst-case
    extent metadata (one extent per block). The ledger is refused otherwise, before any file or marker exists;
  * allocate checks the projected total (present allocation + missing markers + all remaining declared data + one step's
    headroom) before writing anything, then allocates in ALLOC_STEP steps, re-checking actual + remaining + one step's
    headroom before every step and actual after the last. A filesystem that allocates more than the estimate makes
    allocation STOP (and unwind) inside the maximum instead of overrunning it; an owned incomplete file (interrupted
    create) is reset to zero in place so its old blocks are never miscounted;
  * verify compares every local reservation's actual bytes with its maxBytes, and the ledger + lock with
    BOOKKEEPING_BYTES.
What the bound depends on (not proven here): st_blocks reporting all of a file's data AND extent blocks (true for ext4
and tmpfs; filesystems with CoW, snapshots, compression or delayed accounting are unsupported); the parent directories'
growth staying within one block per entry; ext4 not allocating per-file space outside st_blocks (inode tables are
preallocated at mkfs). The estimate only decides how much slack is required: if real metadata is larger, allocation
refuses rather than exceeding maxBytes. This is source logic: real kernel/device behaviour is not proven by it, and
caches outside the ledger are not detected."""
import fcntl
import json
import os
import re
import stat
import sys
from pathlib import Path

FORMAT = 'enclave-rpc-nvme-cache-budget/v2'
CANONICAL_PATH = '/etc/enclave-rpc-cache/nvme-cache-budget.json'
CAP = 250_000_000_000          # direct human limit: ALL cache allocations of this work, all hosts together
TARGET = 200_000_000_000
KINDS = ('preallocated-files',)
MARKER = '.enclave-budget-owner'   # <file>.enclave-budget-owner: O_EXCL ownership marker written before the file
MARKER_MAX_BYTES = 512
SUPPORTED_FS = ('ext4', 'tmpfs')   # st_blocks counts data + extent blocks; no CoW/compression/snapshots
BLOCK_SIZES = (1024, 2048, 4096, 8192, 16384, 32768, 65536)
ALLOC_STEP = 64 << 20              # bytes allocated per step between bound checks
EXT4_MAX_UNWRITTEN_EXTENT = 32767  # blocks per unwritten (fallocated) ext4 extent
LEDGER_MAX_BYTES = 64 << 10
BOOKKEEPING_BYTES = (64 << 10) + 3 * 4096   # per host: ledger (<= LEDGER_MAX_BYTES) + lock + their directory entries


class BudgetError(Exception):
    pass


def fail(m):
    raise BudgetError(m)


def _abs(p, where):
    if not isinstance(p, str) or not p.startswith('/') or p != os.path.normpath(p) or '\0' in p:
        fail(f'{where}: a normalized absolute path is required')
    return p


def _int(v, where, lo=0, hi=CAP):
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        fail(f'{where} must be an integer in [{lo}, {hi}]')
    return v


def _ceil(a, b):
    return -(-a // b)


def _tree_blocks(extents, B):
    """ext4 extent-tree blocks (leaves + index levels) holding `extents` extents: <= 4 live in the inode, each tree
    block holds (B - 12) / 12 entries."""
    per, n, total = (B - 12) // 12, extents, 0
    while n > 4:
        n = _ceil(n, per)
        total += n
    return total


def file_headroom(f, B):
    """Per file: its marker (one block, <= MARKER_MAX_BYTES), its directory entries (one block) and 2x the extent tree
    of a contiguous fallocate (unwritten extents of <= EXT4_MAX_UNWRITTEN_EXTENT blocks)."""
    return 2 * B + 2 * _tree_blocks(_ceil(f['bytes'] // B, EXT4_MAX_UNWRITTEN_EXTENT), B) * B


def step_headroom(r):
    """One allocation step's worst case: one extent per block, plus a leaf split and one more tree level."""
    B = r['blockBytes']
    step = min(ALLOC_STEP, max(f['bytes'] for f in r['files']))
    return (_tree_blocks(step // B, B) + 2) * B


def entry_bytes(r):
    """Directory entries of each file and its marker: one block per file, charged in every actual comparison (directory
    blocks are not in the files' st_blocks)."""
    return len(r['files']) * r['blockBytes']


def required_headroom(r):
    """The minimum slackBytes of a reservation."""
    return sum(file_headroom(f, r['blockBytes']) for f in r['files']) + step_headroom(r)


def validate(raw):
    """-> the ledger, or BudgetError. Pure: no filesystem access."""
    if not isinstance(raw, dict) or set(raw) != {'format', 'capBytes', 'targetBytes', 'hosts', 'reservations'}:
        fail('ledger fields: exactly format, capBytes, targetBytes, hosts, reservations')
    if raw['format'] != FORMAT:
        fail(f'format must be {FORMAT} (v1 charged declared bytes only and is refused)')
    if raw['capBytes'] != CAP:
        fail(f'capBytes must be {CAP} (the user cap; it is not configurable)')
    _int(raw['targetBytes'], 'targetBytes', 0, CAP)
    hosts = {}
    for i, h in enumerate(raw['hosts']):
        if not isinstance(h, dict) or set(h) != {'machineId', 'label', 'shareBytes'}:
            fail(f'hosts[{i}]: exactly machineId, label, shareBytes')
        if not re.fullmatch(r'[0-9a-f]{32}', str(h['machineId'])) or h['machineId'] in hosts:
            fail(f'hosts[{i}].machineId must be a unique 32-hex /etc/machine-id')
        hosts[h['machineId']] = _int(h['shareBytes'], f'hosts[{i}].shareBytes')
    if sum(hosts.values()) > CAP:
        fail(f'host shares sum to {sum(hosts.values())} > cap {CAP}: every participating host needs an explicit share, no host gets 250 GB')
    used, ids, paths = {m: BOOKKEEPING_BYTES for m in hosts}, set(), []
    for i, r in enumerate(raw['reservations']):
        w = f'reservations[{i}]'
        if not isinstance(r, dict) or set(r) != {'id', 'host', 'owner', 'kind', 'blockBytes', 'maxBytes', 'slackBytes', 'files'}:
            fail(f'{w}: exactly id, host, owner, kind, blockBytes, maxBytes, slackBytes, files')
        if not re.fullmatch(r'[a-z0-9][a-z0-9._-]{0,63}', str(r['id'])) or r['id'] in ids:
            fail(f'{w}.id must be unique')
        ids.add(r['id'])
        if r['host'] not in hosts:
            fail(f'{w}.host is not a ledger host (unaccounted reservation)')
        if r['kind'] not in KINDS:
            fail(f'{w}.kind {r["kind"]!r} is not hard-bounded (allowed: {KINDS}); directory-only entries are refused')
        if r['blockBytes'] not in BLOCK_SIZES:
            fail(f'{w}.blockBytes must be the filesystem block size, one of {BLOCK_SIZES}')
        if not isinstance(r['files'], list) or not r['files']:
            fail(f'{w}.files must list the fixed-size files')
        total = 0
        for j, f in enumerate(r['files']):
            if not isinstance(f, dict) or set(f) != {'path', 'bytes'}:
                fail(f'{w}.files[{j}]: exactly path, bytes')
            paths.append((_abs(f['path'], f'{w}.files[{j}].path'), r['host']))
            total += _int(f['bytes'], f'{w}.files[{j}].bytes', 1)
            if f['bytes'] % r['blockBytes']:
                fail(f'{w}.files[{j}].bytes must be a multiple of blockBytes {r["blockBytes"]} (no partial blocks)')
        slack = _int(r['slackBytes'], f'{w}.slackBytes', 0, 4 << 30)
        need = required_headroom(r)
        if slack < need:
            fail(f'{w}.slackBytes {slack} is below the required headroom {need} (markers, directory entries, extent '
                 f'metadata, one allocation step)')
        if _int(r['maxBytes'], f'{w}.maxBytes', 1) != total + slack:
            fail(f'{w}.maxBytes must equal its files plus slackBytes ({total + slack})')
        used[r['host']] += r['maxBytes']
    for m, u in used.items():
        if u > hosts[m]:
            fail(f'host {m}: reservations plus bookkeeping {u} exceed its share {hosts[m]}')
    seen = set()
    for p, m in paths:
        for q, n in seen:
            if m == n and (p == q or p.startswith(q + '/') or q.startswith(p + '/')):
                fail(f'reservation paths overlap: {p} / {q}')
        seen.add((p, m))
    return raw


def machine_id(path='/etc/machine-id'):
    v = Path(path).read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{32}', v):
        fail('/etc/machine-id is not a 32-hex id')
    return v


def load(ledger, require_root_owned=True):
    """Read the ledger file. It must be a regular file, not a symlink, not group/other writable (root-owned in
    deployment), and at most LEDGER_MAX_BYTES (its allocation is part of the per-host bookkeeping charge)."""
    st = os.lstat(ledger)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022 or (require_root_owned and st.st_uid != 0):
        fail(f'{ledger} must be a root-owned regular file, not group/other writable')
    if st.st_size > LEDGER_MAX_BYTES:
        fail(f'{ledger} is larger than {LEDGER_MAX_BYTES} bytes')
    return validate(json.loads(Path(ledger).read_text()))


def fs_of(path):
    """(fstype, block size) of the filesystem holding directory `path`, from /proc/self/mountinfo + statvfs."""
    real = os.path.realpath(path)
    best, fstype = '', None
    with open('/proc/self/mountinfo') as f:
        for line in f:
            left, _, right = line.partition(' - ')
            mp = left.split()[4].replace('\\040', ' ').replace('\\011', '\t').replace('\\134', '\\')
            if (real == mp or real.startswith(mp.rstrip('/') + '/')) and len(mp) >= len(best):
                best, fstype = mp, right.split()[0]
    return fstype, os.statvfs(real).f_frsize


def check_fs(r):
    for f in r['files']:
        d = os.path.dirname(f['path'])
        fstype, bs = fs_of(d)
        if fstype not in SUPPORTED_FS:
            fail(f'{d} is on {fstype!r}: unsupported for bounded accounting (supported: {SUPPORTED_FS})')
        if bs != r['blockBytes']:
            fail(f'{d} has block size {bs}, the reservation declares {r["blockBytes"]}')


class Lock:
    """flock on <ledger>.lock: exclusive for allocation and ledger edits, shared for verification."""
    def __init__(self, ledger, exclusive):
        self.path, self.mode = ledger + '.lock', fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self.fd, self.mode)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.fd, fcntl.LOCK_UN)
        os.close(self.fd)


def reservation(ledger_doc, rid, host):
    r = next((r for r in ledger_doc['reservations'] if r['id'] == rid), None)
    if r is None:
        fail(f'reservation {rid!r} is not in the ledger: an unreserved allocation is refused')
    if r['host'] != host:
        fail(f'reservation {rid!r} belongs to host {r["host"]}, not this host {host}')
    return r


def _owned(p, rid):
    m = p + MARKER
    if not os.path.isfile(m):
        return False
    if os.lstat(m).st_size > MARKER_MAX_BYTES:
        fail(f'{m} is larger than a marker may be')
    return json.loads(Path(m).read_text()).get('reservation') == rid


def allocated(p):
    try:
        return os.lstat(p).st_blocks * 512
    except FileNotFoundError:
        return 0


def actual_bytes(r):
    """Allocated bytes of a reservation's present files and markers (st_blocks: data + extent blocks) plus its fixed
    directory-entry charge. Every bound compares THIS with maxBytes."""
    return sum(allocated(f['path']) + allocated(f['path'] + MARKER) for f in r['files']) + entry_bytes(r)


def complete(f):
    st = os.lstat(f['path'])
    return st.st_size == f['bytes'] and st.st_blocks * 512 >= f['bytes']


def check_file(f, rid, must_exist):
    """-> 'absent' | 'ok'. A present file must be ours (marker), a regular file of EXACTLY the declared size, and not
    sparse. Over-allocation is charged to the reservation as a whole (actual_bytes), never allowed per file."""
    p = f['path']
    try:
        st = os.lstat(p)
    except FileNotFoundError:
        if must_exist:
            fail(f'{p} (reservation {rid}) is missing')
        return 'absent'
    if not stat.S_ISREG(st.st_mode):
        fail(f'{p} is not a regular file')
    if not _owned(p, rid):
        fail(f'{p} exists without this reservation\'s ownership marker: not adopting it')
    if st.st_size != f['bytes']:
        fail(f'{p} is {st.st_size} bytes, declared {f["bytes"]}')
    if st.st_blocks * 512 < f['bytes']:
        fail(f'{p} allocates {st.st_blocks * 512} bytes for a declared {f["bytes"]} (sparse)')
    return 'ok'


def _bound(r, projected, what):
    if projected > r['maxBytes']:
        fail(f'reservation {r["id"]}: {what}: {projected} bytes would exceed maxBytes {r["maxBytes"]}; nothing more is allocated')


def allocate(ledger, rid, host=None, require_root_owned=True):
    """Under the exclusive lock: re-validate, check the filesystem and the PROJECTED total (present allocation + missing
    markers + all remaining declared data + one step's headroom) BEFORE writing anything; then create this reservation's
    markers (O_EXCL), reset owned incomplete files (an interrupted create) to zero in place, and allocate each file in
    ALLOC_STEP steps, re-checking actual + remaining + one step's headroom <= maxBytes before every step and
    actual <= maxBytes at the end. Complete owned files are untouched; recovery never grants new budget (maxBytes is
    fixed in the ledger). -> list of created paths (files and markers)."""
    host = host or machine_id()
    created = []
    with Lock(ledger, exclusive=True):
        doc = load(ledger, require_root_owned)
        r = reservation(doc, rid, host)
        check_fs(r)
        B, todo = r['blockBytes'], []
        for f in r['files']:
            p = f['path']
            if os.path.lexists(p):
                if not os.path.exists(p + MARKER):
                    fail(f'{p} exists without this reservation\'s ownership marker: refusing (no reuse of foreign files)')
                if not stat.S_ISREG(os.lstat(p).st_mode) or not _owned(p, rid):
                    fail(f'{p} is not this reservation\'s regular file')
                if os.lstat(p).st_size > f['bytes']:
                    fail(f'{p} is larger than its reservation')
            if not os.path.lexists(p) or not complete(f):
                todo.append(f)
        kept = sum(allocated(f['path']) for f in r['files'] if f not in todo)
        markers = sum(allocated(f['path'] + MARKER) if os.path.exists(f['path'] + MARKER) else B for f in r['files'])
        remaining = sum(f['bytes'] for f in todo)
        _bound(r, kept + markers + entry_bytes(r) + remaining + (step_headroom(r) if todo else 0), 'before any write')
        try:
            for f in r['files']:
                p = f['path']
                if not os.path.exists(p + MARKER):
                    body = (json.dumps({'reservation': rid, 'path': p, 'bytes': f['bytes']}) + '\n').encode()
                    if len(body) > MARKER_MAX_BYTES:
                        fail(f'marker for {p} would exceed {MARKER_MAX_BYTES} bytes')
                    fd = os.open(p + MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    created.append(p + MARKER)
                    with os.fdopen(fd, 'wb') as m:
                        m.write(body)
                        m.flush()
                        os.fsync(m.fileno())
            fds = {}
            for f in todo:                              # owned incomplete files restart from zero (same inode)
                p = f['path']
                if os.path.exists(p):
                    fds[p] = os.open(p, os.O_WRONLY)
                    os.ftruncate(fds[p], 0)
                else:
                    fds[p] = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    created.append(p)
            try:
                for f in todo:
                    p, off, fd = f['path'], 0, fds[f['path']]
                    while off < f['bytes']:
                        n = min(ALLOC_STEP, f['bytes'] - off)
                        _bound(r, actual_bytes(r) + remaining + step_headroom(r), f'before allocating {p} at {off}')
                        os.posix_fallocate(fd, off, n)
                        off += n
                        remaining -= n
                    os.fsync(fd)
            finally:
                for fd in fds.values():
                    os.close(fd)
            for f in r['files']:
                check_file(f, rid, must_exist=True)
            _bound(r, actual_bytes(r), 'after allocation')
        except BaseException:
            for p in reversed(created):            # only what THIS call created
                try:
                    os.remove(p)
                except FileNotFoundError:
                    pass
            raise
    return created


def admit(ledger, rid, expected, host=None, require_root_owned=True):
    """Shared lock: the reservation exists for this host, its files are exactly `expected` ({path: bytes}), their
    filesystem is supported with the declared block size, and each file is absent or ours (an owned file may be
    incomplete after an interrupted create). Nothing is written."""
    host = host or machine_id()
    with Lock(ledger, exclusive=False):
        r = reservation(load(ledger, require_root_owned), rid, host)
        if {f['path']: f['bytes'] for f in r['files']} != expected:
            fail(f'reservation {rid!r} files {[(f["path"], f["bytes"]) for f in r["files"]]} differ from this configuration {sorted(expected.items())}')
        check_fs(r)
        for f in r['files']:
            p = f['path']
            if os.path.exists(p):
                if not _owned(p, rid):
                    fail(f'{p} exists without this reservation\'s ownership marker: refusing')
                if os.lstat(p).st_size > f['bytes']:
                    fail(f'{p} is larger than its reservation')
        return r


def verify(ledger, rid, host=None, require_root_owned=True):
    """Shared lock: the ledger is valid (host shares and charged maxima incl. bookkeeping fit); this reservation's files
    exist on a supported filesystem with the declared block size; every present file of every local reservation is
    ours, exactly sized and not sparse; every local reservation's ACTUAL allocation (files + markers + directory-entry
    charge) is <= its maxBytes; the ledger + lock allocation is within the bookkeeping charge. -> summary dict."""
    host = host or machine_id()
    with Lock(ledger, exclusive=False):
        doc = load(ledger, require_root_owned)
        mine = reservation(doc, rid, host)
        check_fs(mine)
        local = [r for r in doc['reservations'] if r['host'] == host]
        share = next(h['shareBytes'] for h in doc['hosts'] if h['machineId'] == host)
        actual = {}
        for r in local:
            for f in r['files']:
                check_file(f, r['id'], must_exist=(r is mine))
            actual[r['id']] = actual_bytes(r)
            if actual[r['id']] > r['maxBytes']:
                fail(f'reservation {r["id"]}: actual allocation {actual[r["id"]]} exceeds its maxBytes {r["maxBytes"]}')
        book = allocated(ledger) + allocated(ledger + '.lock')
        if book > BOOKKEEPING_BYTES:
            fail(f'ledger + lock allocate {book} bytes, above the bookkeeping charge {BOOKKEEPING_BYTES}')
        charged = sum(r['maxBytes'] for r in local) + BOOKKEEPING_BYTES
        return {'host': host, 'shareBytes': share, 'chargedBytes': charged, 'actualBytes': sum(actual.values()) + book,
                'reservation': rid, 'reservationBytes': mine['maxBytes'], 'reservationActualBytes': actual[rid],
                'requiredHeadroomBytes': required_headroom(mine), 'bookkeepingBytes': BOOKKEEPING_BYTES,
                'ledgerHostShares': sum(h['shareBytes'] for h in doc['hosts']), 'capBytes': CAP, 'targetBytes': doc['targetBytes']}


def main(argv):
    try:
        if len(argv) == 2 and argv[0] == 'validate':
            validate(json.loads(Path(argv[1]).read_text()))
            print(json.dumps({'valid': True}))
        elif len(argv) >= 4 and argv[0] == 'admit':
            exp = {}
            for a in argv[3:]:
                p, sep, n = a.rpartition('=')
                if not sep or not n.isdigit():
                    fail('admit takes PATH=BYTES arguments')
                exp[p] = int(n)
            r = admit(argv[1], argv[2], exp)
            print(json.dumps({'admitted': r['id'], 'maxBytes': r['maxBytes']}))
        elif len(argv) == 3 and argv[0] == 'allocate':
            for p in allocate(argv[1], argv[2]):
                print(f'created {p}')
        elif len(argv) == 3 and argv[0] == 'verify':
            print(json.dumps(verify(argv[1], argv[2])))
        else:
            print(__doc__, file=sys.stderr)
            return 64
    except (BudgetError, OSError, ValueError) as e:
        print(json.dumps({'refused': f'{type(e).__name__}: {e}' if not isinstance(e, BudgetError) else str(e)}), file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
