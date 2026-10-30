"""Bounded read-only journal/direntry check; no recovery writes or guest start."""
import hashlib, json, os, subprocess, tempfile, time, types
from pathlib import Path

p = Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025')
inspector = p / 'rpc-memory-recovery-stage/r1/inspect_os_disk.py'
b = inspector.read_bytes()
assert hashlib.sha256(b).hexdigest() == '287c09ba2b3bebd3c1feddb995306bf2fe13a6be073f6b17bdeda257b98a0531'
I = types.ModuleType('readonly_inspector'); I.__file__ = str(inspector)
exec(compile(b, str(inspector), 'exec'), I.__dict__)
m = Path('/home/steven/.local/state/enclave-rpc-production/manifest.json')
mb = m.read_bytes()
assert hashlib.sha256(mb).hexdigest() == 'a28432151c9a24bd207d9adaab401ca4e24a9cdc39807489f12c3000b0936441'
manifest = json.loads(mb); base = manifest['disks']['base']; disk = Path(base['path'])
discard = manifest['backings'][base['backing']]['discard']
assert discard == 'ignore', 'do not infer recoverability when discard is enabled'
for unit in (*I.VM_UNITS, 'enclave-rpc-qual-vm.service'):
    assert I.unit_active(unit) in ('inactive', 'failed'), unit
assert not I.open_by_others(str(disk))
before = disk.stat()
out = p / 'logs/base-journal-metadata-1546'; out.mkdir(mode=0o700)
mnt = tempfile.mkdtemp(prefix='rpc-base-journal-read-')
raw = Path(mnt) / 'base.raw'; proc = None
record = {'readonly': True, 'disk': str(disk), 'discard': discard, 'commands': {}}
try:
    proc = subprocess.Popen(['nbdfuse', '-r', str(raw), '[', 'qemu-nbd', '-r', '-f', 'qcow2', str(disk), ']'],
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + 45
    while not raw.exists() or raw.stat().st_size == 0:
        assert time.monotonic() < deadline and proc.poll() is None
        time.sleep(.2)
    for name, command in [('journal-superblock', 'logdump -S'), ('journal-inode', 'stat <8>'), ('deleted-db-entries', 'ls -d -l /data/db')]:
        start = time.monotonic()
        with (out / (name + '.out')).open('wb') as fo, (out / (name + '.err')).open('wb') as fe:
            r = subprocess.run(['prlimit', '--fsize=67108864:67108864', 'timeout', '--signal=TERM', '--kill-after=5', '120',
                                'debugfs', '-R', command, str(raw)], stdout=fo, stderr=fe, stdin=subprocess.DEVNULL, timeout=135)
        record['commands'][name] = {'command': command, 'returncode': r.returncode, 'elapsed': time.monotonic() - start,
                                   'outputBytes': (out / (name + '.out')).stat().st_size}
finally:
    r = subprocess.run(['fusermount3', '-u', mnt], capture_output=True, timeout=30)
    record['unmountRc'] = r.returncode
    if proc:
        try: proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            record['cleanupForced'] = True; proc.kill(); proc.wait(timeout=10)
        record['nbdfuseRc'] = proc.returncode
    if r.returncode == 0: os.rmdir(mnt)
    after = disk.stat()
    record['diskUnchanged'] = all(getattr(before, k) == getattr(after, k) for k in ('st_size', 'st_ino', 'st_mtime_ns', 'st_ctime_ns'))
    record['openAfter'] = I.open_by_others(str(disk))
    (out / 'record.json').write_text(json.dumps(record, indent=2) + '\n')
assert record['diskUnchanged'] and record['unmountRc'] == 0 and not record.get('cleanupForced') and not record['openAfter']
print(json.dumps(record, indent=2))
