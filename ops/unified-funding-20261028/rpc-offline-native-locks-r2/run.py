"""One bounded native lock matrix. Only new, empty, disposable qcow images."""
import os, sys, json, time, socket, subprocess, tempfile, hashlib, fcntl, struct
from pathlib import Path

P = Path(__file__).resolve().parent
ENV = {'PATH': '/usr/bin:/usr/sbin:/bin', 'LANG': 'C'}
SOURCE = P / 'candidate'
sys.path.insert(0, str(SOURCE))

def sha(p):
    with open(p, 'rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()

def verify():
    for row in json.loads((P / 'INPUT-PINS.json').read_text()):
        assert sha(row['path']) == row['sha256'], row['path']

verify()
import offline_mask as om
assert os.sched_getaffinity(0) == {1}
assert int(next(x.split()[1] for x in Path('/proc/meminfo').read_text().splitlines() if x.startswith('MemAvailable:'))) >= 27648 * 1024
with (P / 'ATTEMPT.json').open('x') as f:
    json.dump({'at': time.time(), 'scope': 'new synthetic qcow only; no production files'}, f)
T = Path(tempfile.mkdtemp(prefix='lock-matrix-', dir='/vm/enclave-volumes/rpc-production-maint'))
os.chmod(T, 0o700)
(P / 'TEMP.json').write_text(json.dumps({'path': str(T)}))
events = (P / 'EVENTS.jsonl').open('x')
procs = []
held = []
fx = om.OsEffects()
results = []

def event(kind, **data):
    events.write(json.dumps({'kind': kind, **data}) + '\n'); events.flush()

def run(argv):
    r = subprocess.run(argv, stdin=subprocess.DEVNULL, capture_output=True, env=ENV, timeout=8)
    assert len(r.stdout) + len(r.stderr) < 65536
    event('command', argv=argv, rc=r.returncode, stdout=r.stdout.decode(errors='replace'), stderr=r.stderr.decode(errors='replace'))
    return r

def fresh(name):
    f = T / (name + '.qcow2')
    assert run(['/usr/bin/qemu-img', 'create', '-f', 'qcow2', str(f), '4M']).returncode == 0
    st = f.stat()
    return f, {'device': st.st_dev, 'inode': st.st_ino}, sha(f)

def start(argv, name):
    err = (T / (name + '.stderr')).open('xb')
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err, env=ENV)
    err.close(); procs.append(p)
    st = Path(f'/proc/{p.pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
    event('start', argv=argv, pid=p.pid, starttime=st)
    return p

def stop(p, name):
    if p.poll() is None:
        p.terminate()
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=3)
    err = (T / (name + '.stderr')).read_bytes()
    assert len(err) < 65536
    event('stop', pid=p.pid, rc=p.returncode, stderr=err.decode(errors='replace'), procGone=not Path(f'/proc/{p.pid}').exists())
    assert not Path(f'/proc/{p.pid}').exists()
    return err.decode(errors='replace')

def nbd(f, name, readonly=False):
    s = T / (name + '.sock')
    argv = ['/usr/bin/qemu-nbd', '--persistent', '--socket=' + str(s), '-f', 'qcow2']
    if readonly: argv.append('-r')
    p = start(argv + [str(f)], name)
    deadline = time.monotonic() + 3
    ready = False
    while p.poll() is None and time.monotonic() < deadline:
        if s.exists():
            st = f.stat()
            targets = []
            for fd in Path(f'/proc/{p.pid}/fd').iterdir():
                try:
                    v = fd.stat()
                    if (v.st_dev, v.st_ino) == (st.st_dev, st.st_ino): targets.append(fd.name)
                except FileNotFoundError: pass
            if targets:
                event('nbd_ready', pid=p.pid, fds=targets, file=str(f)); ready = True; break
        time.sleep(.02)
    return p, ready

def acquire(f, ident):
    fd = fx.hold_qemu_locks(str(f), ident); held.append(fd); return fd

def release(fd):
    fx.release(fd); held.remove(fd)

def record(name, status, **details):
    results.append({'case': name, 'status': status, **details})
    event('result', **results[-1])

def qsd(f, name):
    s = T / (name + '.qmp')
    p = start(['/usr/sbin/qemu-storage-daemon', '--chardev', 'socket,id=mon,path=' + str(s) + ',server=on,wait=off', '--monitor', 'chardev=mon'], name)
    deadline = time.monotonic() + 3
    while not s.exists() and p.poll() is None and time.monotonic() < deadline: time.sleep(.02)
    conn = socket.socket(socket.AF_UNIX); conn.settimeout(3); conn.connect(str(s))
    buf = b''
    def read(deadline):
        nonlocal buf
        while b'\n' not in buf:
            conn.settimeout(max(.001, deadline-time.monotonic()))
            chunk = conn.recv(65536)
            if not chunk: raise RuntimeError('QMP EOF')
            buf += chunk
            assert len(buf) <= 1048576
        line, buf = buf.split(b'\n', 1)
        return json.loads(line)
    def cmd(command, args=None):
        deadline = time.monotonic()+3
        request = {'execute': command, 'id': command}
        if args is not None: request['arguments'] = args
        conn.sendall(json.dumps(request).encode()+b'\n')
        while True:
            out = read(deadline)
            if out.get('id') == command:
                event('qmp', name=name, request=request, response=out); return out
            assert 'event' in out
    try:
        assert 'QMP' in read(time.monotonic()+3)
        assert 'return' in cmd('qmp_capabilities')
        file_result = cmd('blockdev-add', {'driver':'file','node-name':'fixture-file','filename':str(f),'read-only':False,'locking':'on'})
        if 'error' in file_result: return {'file':file_result}
        cor = cmd('blockdev-add', {'driver':'copy-on-read','node-name':'fixture-cor','file':'fixture-file','read-only':False})
        graph = cmd('x-debug-query-block-graph')
        return {'cor':cor, 'graph':graph}
    finally:
        conn.close(); stop(p, name)

try:
    f, ident, before = fresh('preexisting')
    p, ready = nbd(f, 'preexisting'); assert ready
    refused = False
    try: fd = acquire(f, ident)
    except om.Refusal: refused = True
    else: release(fd)
    stop(p, 'preexisting')
    fd = acquire(f, ident); release(fd)
    record('preexisting_writable', 'PASS' if refused else 'FAIL', unchanged=sha(f)==before)

    f, ident, before = fresh('future')
    fd = acquire(f, ident)
    p, ready = nbd(f, 'future'); err = stop(p, 'future'); release(fd)
    p, control = nbd(f, 'future-control'); stop(p, 'future-control')
    record('future_writable', 'PASS' if not ready and 'lock' in err.lower() and control else 'FAIL', error=err, control=control, unchanged=sha(f)==before)

    f, ident, before = fresh('resize')
    fd = acquire(f, ident)
    r = run(['/usr/bin/qemu-img','resize','-f','qcow2',str(f),'5M']); release(fd)
    unchanged = sha(f)==before
    control = run(['/usr/bin/qemu-img','resize','-f','qcow2',str(f),'5M'])
    info = run(['/usr/bin/qemu-img','info','--output=json',str(f)])
    record('resize', 'PASS' if r.returncode != 0 and b'lock' in r.stderr.lower() and unchanged and control.returncode == 0 and json.loads(info.stdout)['virtual-size']==5<<20 else 'FAIL', unchangedWhileHeld=unchanged)

    f, ident, before = fresh('reader')
    fd = acquire(f, ident)
    info = run(['/usr/bin/qemu-img','info','--output=json',str(f)])
    p, ready = nbd(f, 'reader', True); err = stop(p, 'reader'); release(fd)
    record('read_only', 'PASS' if ready and info.returncode == 0 and sha(f)==before else 'INCONCLUSIVE', ready=ready, error=err, unchanged=sha(f)==before)

    f, ident, before = fresh('race')
    original = fcntl.fcntl
    race = {}
    def hooked(fd, op, arg=0):
        result = original(fd, op, arg)
        if op == fcntl.F_OFD_GETLK and not race:
            p, ready = nbd(f, 'race'); race.update(process=p, ready=ready)
        return result
    fcntl.fcntl = hooked
    accepted = False
    try:
        fd = acquire(f, ident); accepted = True; release(fd)
    except om.Refusal: pass
    finally:
        fcntl.fcntl = original
        if race: stop(race['process'], 'race')
    record('deterministic_getlk_setlk_race', 'FAIL' if accepted and race['ready'] else 'PASS', writerAccepted=accepted, nativeWriterReady=race.get('ready'), unchanged=sha(f)==before)

    f, ident, before = fresh('pre-setlk-race')
    original = fcntl.fcntl
    race = {}
    def hooked_before(fd, op, arg=0):
        if op == fcntl.F_OFD_SETLK and not race:
            p, ready = nbd(f, 'pre-setlk-race'); race.update(process=p, ready=ready)
            assert ready
        return original(fd, op, arg)
    fcntl.fcntl = hooked_before
    accepted = False
    try:
        fd = acquire(f, ident); accepted = True; release(fd)
    except om.Refusal: pass
    finally:
        fcntl.fcntl = original
        if race: stop(race['process'], 'pre-setlk-race')
    record('deterministic_pre_setlk_race', 'PASS' if not accepted and race['ready'] else 'FAIL', writerAccepted=accepted, nativeWriterReady=race.get('ready'), unchanged=sha(f)==before)

    f, ident, before = fresh('write-unchanged')
    control = qsd(f, 'qsd-control')
    fd = acquire(f, ident)
    blocked = qsd(f, 'qsd-held'); release(fd)
    edges = control.get('graph',{}).get('return',{}).get('edges',[])
    valid = any('write-unchanged' in e.get('perm',[]) and 'write' not in e.get('perm',[]) for e in edges)
    held_edges = blocked.get('graph',{}).get('return',{}).get('edges',[])
    escaped = any('write-unchanged' in e.get('perm',[]) and 'write' not in e.get('perm',[]) for e in held_edges)
    errors = json.dumps(blocked).lower()
    record('write_unchanged', ('FAIL' if escaped else 'PASS' if 'error' in errors and 'lock' in errors else 'INCONCLUSIVE') if valid else 'INCONCLUSIVE', validControl=valid, escaped=escaped, control=control, held=blocked, unchanged=sha(f)==before)
finally:
    for fd in list(held): release(fd)
    for p in procs:
        if p.poll() is None:
            p.terminate()
            try: p.wait(timeout=3)
            except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=3)
    verify()
    (P / 'RESULT.json').write_text(json.dumps({'results':results, 'allProcessesGone':all(not Path(f'/proc/{p.pid}').exists() for p in procs), 'syntheticOnly':True, 'productionQualified':False},indent=2)+'\n')
print(json.dumps(results))
