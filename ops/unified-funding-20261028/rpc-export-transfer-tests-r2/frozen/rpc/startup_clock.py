"""One consumed owner clock spanning Windows and the storage host.

The caller supplies a sample from its authenticated Windows channel. A digest
binds bytes, not their provenance. This module performs no remote operations.
Run preparation inside an independently bounded operator process.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time

_spec = importlib.util.spec_from_file_location('storage_protocol', Path(__file__).with_name('storage_protocol.py'))
protocol = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(protocol)
WINDOW = 900_000_000_000
MAX_INT = (1 << 63) - 1


def integer(value, maximum=MAX_INT):
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError('Bounded nonnegative integer required')
    return value


def hex32(value):
    if not isinstance(value, str) or not re.fullmatch('[0-9a-f]{32}', value):
        raise ValueError('Exact attempt or Windows boot identity required')


def directory(path):
    path = Path(path)
    if not path.is_absolute() or path.resolve(strict=True) != path:
        raise ValueError('Canonical owner directory required')
    for parent in [path, *path.parents]:
        row = parent.lstat()
        if not stat.S_ISDIR(row.st_mode) or row.st_uid not in (0, os.geteuid()) or row.st_mode & 0o022:
            raise ValueError('Directory authority differs')
    if stat.S_IMODE(path.stat().st_mode) != 0o700:
        raise ValueError('Private owner directory required')
    return path


def read(path):
    path = Path(path)
    directory(path.parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        row = os.fstat(stream.fileno())
        if (not stat.S_ISREG(row.st_mode) or row.st_uid != os.geteuid() or row.st_nlink != 1
                or stat.S_IMODE(row.st_mode) != 0o600 or not 0 < row.st_size <= 65536):
            raise ValueError('Bounded private owner file required')
        raw = stream.read(65537)
        after = os.fstat(stream.fileno())
        if (row.st_dev, row.st_ino, row.st_size, row.st_mtime_ns, row.st_ctime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise ValueError('Owner file changed during read')
    if len(raw) != row.st_size:
        raise ValueError('Owner file length changed')
    return raw


def read_pinned(binding):
    if not isinstance(binding, dict) or set(binding) != {'path', 'sha256'}:
        raise ValueError('Exact pinned owner input required')
    protocol.digest(binding['sha256'])
    raw = read(binding['path'])
    if protocol.sha(raw) != binding['sha256']:
        raise ValueError('Pinned owner input changed')
    return raw


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode() + b'\n'


def write_new(path, raw):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(Path(path).parent)
    return {'path': str(path), 'sha256': protocol.sha(raw)}


def snapshot():
    # Timestamp precedes any remote sample acquisition or startup mutation.
    mono = time.monotonic_ns()
    wall = time.time_ns()
    boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    protocol.boot(boot)
    return wall, mono, boot


def begin(parent, attempt, instance, vm_attempt):
    protocol.identity(attempt, instance)
    hex32(vm_attempt)
    parent = directory(parent)
    wall, mono, boot = snapshot()
    integer(wall, MAX_INT - WINDOW)
    integer(mono, MAX_INT - WINDOW)
    root = parent / attempt
    root.mkdir(mode=0o700)  # Never replace a prior or incomplete attempt.
    sync_directory(parent)
    return write_new(root / 'begin.json', encode({
        'schema': 'owned-rpc-startup-begin/1', 'attempt': attempt,
        'instance': instance, 'vmAttempt': vm_attempt, 'bootId': boot,
        'createdUtcNs': wall, 'originMonotonicNs': mono}))


def validate_begin(row, root):
    if set(row) != {'schema', 'attempt', 'instance', 'vmAttempt', 'bootId', 'createdUtcNs', 'originMonotonicNs'} or row['schema'] != 'owned-rpc-startup-begin/1':
        raise ValueError('Exact original begin record required')
    protocol.identity(row['attempt'], row['instance'])
    hex32(row['vmAttempt'])
    protocol.boot(row['bootId'])
    if root.name != row['attempt']:
        raise ValueError('Attempt directory differs')
    integer(row['createdUtcNs'], MAX_INT - WINDOW)
    integer(row['originMonotonicNs'], MAX_INT - WINDOW)


def current(row, handshake=False):
    wall, mono, boot = snapshot()
    integer(wall)
    integer(mono)
    elapsed = mono - row['originMonotonicNs']
    if boot != row['bootId'] or elapsed < 0 or wall < row['createdUtcNs']:
        raise ValueError('Original host boot or clock differs')
    if abs(wall - row['createdUtcNs'] - elapsed) > 2_000_000_000:
        raise ValueError('Original wall/monotonic relationship changed')
    if elapsed >= WINDOW or wall >= row['createdUtcNs'] + WINDOW:
        raise ValueError('Original startup deadline expired')
    if handshake and elapsed > 10_000_000_000:
        raise ValueError('Windows sample handshake exceeded ten seconds')
    return wall, mono, elapsed


def compose(row, sample, elapsed, begin_sha, sample_sha):
    if set(sample) != {'schema', 'attempt', 'vmAttempt', 'windowsBoot', 'monotonicMilliseconds'} or sample['schema'] != 'owned-rpc-windows-clock/1':
        raise ValueError('Exact Windows clock sample required')
    if (sample['attempt'], sample['vmAttempt']) != (row['attempt'], row['vmAttempt']):
        raise ValueError('Windows sample belongs to another attempt')
    hex32(sample['windowsBoot'])
    integer(sample['monotonicMilliseconds'])
    integer(elapsed, 10_000_000_000)
    # The sample occurred between begin and finish. Subtract the entire elapsed
    # interval (rounded up) and a millisecond for Windows clock quantization.
    # Therefore this origin is no later than Windows time at local begin.
    origin = sample['monotonicMilliseconds'] - (elapsed + 999999) // 1000000 - 1
    integer(origin, MAX_INT - 900000)
    return {**row, 'schema': 'owned-rpc-startup-clock/1',
            'deadlineUtcNs': row['createdUtcNs'] + WINDOW,
            'deadlineMonotonicNs': row['originMonotonicNs'] + WINDOW,
            'windowsBoot': sample['windowsBoot'], 'windowsOriginMilliseconds': origin,
            'windowsDeadlineMilliseconds': origin + 900000,
            'beginSha256': begin_sha, 'sampleSha256': sample_sha,
            'handshakeElapsedNs': elapsed}


def finish(begin_binding, sample_binding):
    original = read_pinned(begin_binding)
    row = protocol.decode(original)
    root = directory(Path(begin_binding['path']).parent)
    if Path(begin_binding['path']).name != 'begin.json':
        raise ValueError('Original begin filename required')
    validate_begin(row, root)
    current(row, True)
    if not isinstance(sample_binding, dict) or set(sample_binding) != {'path', 'sha256'}:
        raise ValueError('Pinned authenticated sample required')
    protocol.digest(sample_binding['sha256'])
    write_new(root / 'finish.intent', encode({'beginSha256': protocol.sha(original), 'sampleSha256': sample_binding['sha256']}))
    raw = read_pinned(sample_binding)
    _, _, elapsed = current(row, True)
    clock = compose(row, protocol.decode(raw), elapsed, protocol.sha(original), protocol.sha(raw))
    write_new(root / 'windows-sample.json', raw)
    if read_pinned(begin_binding) != original or read_pinned(sample_binding) != raw:
        raise ValueError('Clock inputs changed before completion')
    current(row, True)
    return write_new(root / 'clock.json', encode(clock))


def validate(binding):
    raw = read_pinned(binding)
    root = directory(Path(binding['path']).parent)
    if Path(binding['path']).name != 'clock.json':
        raise ValueError('Completed clock filename required')
    clock = protocol.decode(raw)
    original = read(root / 'begin.json')
    row = protocol.decode(original)
    validate_begin(row, root)
    sample = read(root / 'windows-sample.json')
    intent = protocol.decode(read(root / 'finish.intent'))
    if intent != {'beginSha256': protocol.sha(original), 'sampleSha256': protocol.sha(sample)}:
        raise ValueError('Consumed clock binding differs')
    expected = compose(row, protocol.decode(sample), clock.get('handshakeElapsedNs'), protocol.sha(original), protocol.sha(sample))
    if clock != expected:
        raise ValueError('Completed clock was reset or rebound')
    current(row)
    return clock


def remaining(binding):
    row = validate(binding)
    wall, mono, _ = current(row)
    return min(row['deadlineUtcNs'] - wall, row['deadlineMonotonicNs'] - mono) / 1e9
