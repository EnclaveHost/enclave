"""Synthetic filesystem only. Never accepts a production image argument."""
from pathlib import Path
import hashlib, json, os, re, signal, subprocess, tempfile, time

p = Path(__file__).resolve().parent
assert os.sched_getaffinity(0) == {1}
pins = json.loads((p / 'INPUT-PINS.json').read_text())
def sha(f):
    with Path(f).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
def check():
    for f, h in pins.items():
        assert sha(f) == h, f
check()
with (p / 'ATTEMPT.json').open('x') as f:
    json.dump({'startedAt': time.time(), 'scope': 'new synthetic32MiBext4 only'}, f)
t = Path(tempfile.mkdtemp(prefix='rpc-fs-', dir='/tmp'))
(p / 'TEMP.json').write_text(json.dumps({'path': str(t), 'owned': True}))
log = (p / 'commands.jsonl').open('x')
def run(args, ok=(0,)):
    r = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True,
                       env={'PATH': '/usr/bin:/bin', 'LANG': 'C'}, timeout=30)
    log.write(json.dumps({'argv': args, 'rc': r.returncode,
                         'stdout': r.stdout.decode(errors='replace'),
                         'stderr': r.stderr.decode(errors='replace')}) + '\n'); log.flush()
    assert r.returncode in ok, (args[0], r.returncode)
    return r
raw = t / 'root.ext4'
with raw.open('xb') as f: f.truncate(32 << 20)
run(['/usr/bin/mke2fs', '-q', '-F', '-t', 'ext4', '-L', 'cloudimg-rootfs', str(raw)])
unit = t / 'unit.txt'; unit.write_text('[Service]\nExecStart=/bin/true\n')
def dbg(dev, command, write=False):
    args = ['/usr/bin/debugfs'] + (['-w'] if write else []) + ['-R', command, str(dev)]
    r = run(args)
    noise = [x for x in r.stderr.decode().splitlines() if x and not x.startswith('debugfs ')]
    assert not noise, noise
    return r.stdout.decode()
for directory in ['/etc', '/etc/systemd', '/etc/systemd/system',
                  '/etc/systemd/system/multi-user.target.wants', '/keep']:
    dbg(raw, 'mkdir ' + directory, True)
name = '/etc/systemd/system/test.service'
link = '/etc/systemd/system/multi-user.target.wants/test.service'
dbg(raw, f'write {unit} {name}', True)
dbg(raw, f'symlink {link} ../test.service', True)
before = dbg(raw, 'stat ' + name)
inode = int(re.search(r'Inode: (\d+)', before).group(1))
assert re.search(r'Links:\s+1\b', before)
run(['/usr/bin/e2fsck', '-fn', str(raw)])
disk = t / 'fixture.raw'
with disk.open('xb') as f:
    f.write(b'A' * (1 << 20)); f.write(raw.read_bytes()); f.write(b'Z' * (1 << 20))
original = sha(disk)
qcow = t / 'fixture.qcow2'
run(['/usr/bin/qemu-img', 'convert', '-f', 'raw', '-O', 'qcow2', str(disk), str(qcow)])
mount = t / 'mount'; mount.mkdir(); export = mount / 'root'
opts = f'driver=raw,offset=1048576,size=33554432,file.driver=qcow2,file.file.driver=file,file.file.filename={qcow}'
err = (p / 'nbdfuse.stderr').open('xb')
proc = subprocess.Popen(['/usr/bin/nbdfuse', str(export), '[', '/usr/bin/qemu-nbd', '--image-opts', opts, ']'],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err,
                        start_new_session=True)
(p / 'FUSE-PROCESS.json').write_text(json.dumps({'pid': proc.pid, 'mount': str(mount)}))
try:
    end = time.monotonic() + 10
    while not export.exists():
        assert proc.poll() is None and time.monotonic() < end, 'export unavailable'
        time.sleep(.1)
    assert export.stat().st_size == 32 << 20
    run(['/usr/bin/e2fsck', '-fn', str(export)])
    assert dbg(export, 'cat ' + name) == unit.read_text()
    dbg(export, f'ln <{inode}> /keep/test.service', True)
    assert int(re.search(r'Inode: (\d+)', dbg(export, 'stat /keep/test.service')).group(1)) == inode
    dbg(export, 'unlink ' + name, True)
    dbg(export, f'symlink {name} /dev/null', True)
    dbg(export, 'rm ' + link, True)
    assert dbg(export, 'cat /keep/test.service') == unit.read_text()
    after = dbg(export, 'stat /keep/test.service')
    assert int(re.search(r'Inode: (\d+)', after).group(1)) == inode
    assert re.search(r'Links:\s+1\b', after)
    assert 'Fast link dest: "/dev/null"' in dbg(export, 'stat ' + name)
    assert 'test.service' not in dbg(export, 'ls -p /etc/systemd/system/multi-user.target.wants')
    run(['/usr/bin/e2fsck', '-fn', str(export)])
finally:
    unmount = subprocess.run(['/usr/bin/fusermount3', '-u', str(mount)],
                             capture_output=True, timeout=10)
    try: proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait(timeout=5)
    err.close()
    if unmount.returncode:
        # Only this synthetic mount; cleanup does not repeat any image edits.
        subprocess.run(['/usr/bin/fusermount3', '-u', str(mount)],
                       capture_output=True, timeout=10)
    assert not os.path.ismount(mount), 'owned fixture mount remains'
assert proc.returncode == 0
run(['/usr/bin/qemu-img', 'check', '-f', 'qcow2', str(qcow)])
flat = t / 'after.raw'
run(['/usr/bin/qemu-img', 'convert', '-f', 'qcow2', '-O', 'raw', str(qcow), str(flat)])
with flat.open('rb') as f:
    assert f.read(1 << 20) == b'A' * (1 << 20)
    f.seek(33 << 20); assert f.read() == b'Z' * (1 << 20)
assert sha(disk) == original
check()
with (p / 'RESULT.json').open('x') as f:
    json.dump({'pass': True, 'syntheticOnly': True, 'partitionBounded': True,
               'originalUnchanged': True, 'archiveInodePreserved': True,
               'maskVerified': True, 'enablementRemoved': True,
               'ext4ChecksPassed': True, 'qcowCheckPassed': True,
               'fusePidGone': not Path('/proc/' + str(proc.pid)).exists(),
               'fixturePath': str(t)}, f, indent=2)
