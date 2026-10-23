#!/usr/bin/env python3
"""Root-run, isolated whole-snapshot Sia production restore (sia-s3 `recovery restore`). See RESULT.md.

  check    read-only resources of a target: the local workstation or the storage VM (no network but the VM's SSH)
  prepare  verify the archive and snapshot pins; create a NEW private run directory holding an IP-pinned derivative
           of the snapshot (the original is never modified; both hashes are recorded)
  start    verify every pin again (binary, snapshot, derivative, archive, key file) BEFORE any upload; prove the indexer
           reachable OUTSIDE the scope; then start one bounded unit and return (no long blocking call)
  poll     that unit's state by its exact handle (unit name + invocation id); counts, sizes and digests only
  stop     stop that exact unit
  finish   after a verified success (or --abandon after a failure): remove the staging copies only (on the VM, the
           uploaded key file); restored data is kept
  discard  remove one attempt's restored data, when root chooses to

Nothing runs by default: every live input is an explicit argument. The key file is passed by PATH; its contents are
never printed, logged, put in an argument or an environment value (the VM upload sends it over SSH standard input).
"""
import argparse
import datetime
import hashlib
import io
import ipaddress
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNNER = HERE / 'runner.py'
UNIT_PREFIX = 'sia-whole-restore-'
MAX_DEADLINE = 7 * 24 * 3600
RESERVE = 1 << 30
SSH_SHORT = 60       # seconds for any short SSH call
SSH_UPLOAD = 1200    # the one upload (binary + snapshot)


class Refused(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def hexarg(v, what):
    if not re.fullmatch(r'[0-9a-f]{64}', v or ''):
        raise Refused(f'{what} must be 64 lowercase hex characters')
    return v


def pinned(path, want, what):
    got = sha256_file(path)
    if got != want:
        raise Refused(f'{what} hash differs from its pin')
    return got


def private_file(path, what):
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise Refused(f'{what} must be a regular file owned by this user with mode 0600 (no symlink)')


def private_dir(path, what):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o077:
        raise Refused(f'{what} must be a directory owned by this user with mode 0700 (no symlink)')


def write_new(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, 'wb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def dumps(obj):
    return (json.dumps(obj, indent=2, sort_keys=True) + '\n').encode()


def out(obj, code=0):
    print(json.dumps(obj, sort_keys=True), flush=True)
    return code


# ---- the IP-pinned derivative ----------------------------------------------------------------------------------------
def resolve4(name, port):
    try:
        return sorted({r[4][0] for r in socket.getaddrinfo(name, port, socket.AF_INET, socket.SOCK_STREAM)})
    except OSError:
        return []


def is_ip(v):
    try:
        ipaddress.ip_address(v)
        return True
    except ValueError:
        return False


def split_addr(a):
    host, sep, port = a.rpartition(':')
    if not sep or not port.isdigit() or not 0 < int(port) < 65536:
        return None
    return host.strip('[]'), int(port)


def derive(snap, resolver):
    """-> (derivative, endpoints, resolution, stats): host addresses become the global IPv4 addresses their siamux
    hostnames resolve to (the recovery binary dials siamux; nothing inside the scope can resolve names)."""
    stats = {'hosts': len(snap['hosts']), 'hostsWithEndpoints': 0, 'droppedNonSiamux': 0, 'droppedNonGlobal': 0,
             'unresolved': 0, 'malformed': 0}
    resolution, endpoints, hosts = {}, set(), []
    for h in snap['hosts']:
        addrs = []
        for a in h.get('addresses') or []:
            if a.get('protocol') != 'siamux':
                stats['droppedNonSiamux'] += 1
                continue
            hp = split_addr(a.get('address', ''))
            if not hp:
                stats['malformed'] += 1
                continue
            host, port = hp
            if is_ip(host):
                ips = [host]
            else:
                ips = resolution.setdefault(host, resolver(host, port))
                if not ips:
                    stats['unresolved'] += 1
            for ip in ips:
                addr = ipaddress.ip_address(ip)
                if addr.version != 4 or not addr.is_global:
                    stats['droppedNonGlobal'] += 1
                    continue
                entry = {'protocol': 'siamux', 'address': f'{ip}:{port}'}
                if entry not in addrs:
                    addrs.append(entry)
                endpoints.add((ip, port))
        stats['hostsWithEndpoints'] += bool(addrs)
        hosts.append({**h, 'addresses': addrs})
    return {**snap, 'hosts': hosts}, sorted(endpoints), resolution, stats


def verify_derivative(orig, deriv, resolution):
    """The derivative equals the original except host addresses, each a resolution of one of that host's own siamux
    addresses (same port)."""
    if set(orig) != set(deriv) or any(orig[k] != deriv[k] for k in orig if k != 'hosts') or len(orig['hosts']) != len(deriv['hosts']):
        raise Refused('derivative snapshot differs from the original beyond host addresses')
    for o, d in zip(orig['hosts'], deriv['hosts']):
        if set(o) != set(d) or any(o[k] != d[k] for k in o if k != 'addresses'):
            raise Refused('derivative snapshot changed a host field other than its addresses')
        allowed = set()
        for a in o.get('addresses') or []:
            hp = split_addr(a.get('address', '')) if a.get('protocol') == 'siamux' else None
            if hp:
                for ip in ([hp[0]] if is_ip(hp[0]) else resolution.get(hp[0], [])):
                    allowed.add(f'{ip}:{hp[1]}')
        for a in d['addresses']:
            ip = split_addr(a['address'])[0]
            if a['protocol'] != 'siamux' or a['address'] not in allowed or not ipaddress.ip_address(ip).is_global:
                raise Refused('derivative snapshot holds an address its host did not announce')


def blocked_set(path):
    spec = json.loads(Path(path).read_text())
    if spec.get('format') != 'sia-whole-restore-blocked/v1':
        raise Refused('blocked list: format must be sia-whole-restore-blocked/v1')
    eps = []
    for e in spec['endpoints']:
        ipaddress.ip_address(e['ip'])
        eps.append({'label': str(e['label']), 'ip': e['ip'], 'port': int(e['port']), 'outsideMustConnect': bool(e.get('outsideMustConnect'))})
    names = []
    for n in spec.get('names', []):
        ips = resolve4(n['name'], int(n['port']))
        names.append({'label': str(n['label']), 'name': n['name'], 'port': int(n['port'])})
        eps += [{'label': f"{n['label']} ({n['name']})", 'ip': ip, 'port': int(n['port']), 'outsideMustConnect': False} for ip in ips]
    if not any(e['outsideMustConnect'] for e in eps):
        raise Refused('blocked list needs at least one outsideMustConnect endpoint (the indexer, reachable outside the scope)')
    return eps, names


def archive_members(archive, passphrase_file):
    """Stream-decrypt the archive (gpg, passphrase by file path) and hash its snapshot.json and app.seed members in
    memory; nothing is written or printed."""
    p = subprocess.Popen(['gpg', '--no-options', '--batch', '--quiet', '--no-symkey-cache', '--pinentry-mode', 'loopback',
                          '--passphrase-file', str(passphrase_file), '--decrypt', str(archive)],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    sums = {}
    with tarfile.open(fileobj=p.stdout, mode='r|') as tar:
        for m in tar:
            if m.name in ('snapshot.json', 'app.seed') and m.isfile():
                sums[m.name] = hashlib.sha256(tar.extractfile(m).read()).hexdigest()
    if p.wait() != 0:
        raise Refused('archive did not decrypt and authenticate')
    return sums


def prepare(a):
    for v, w in ((a.snapshot_sha, 'snapshot sha'), (a.archive_sha, 'archive sha')):
        hexarg(v, w)
    private_file(a.key_file, 'key file')
    pinned(a.archive, a.archive_sha, 'archive')
    raw = Path(a.snapshot).read_bytes()
    if hashlib.sha256(raw).hexdigest() != a.snapshot_sha:
        raise Refused('snapshot hash differs from its pin')
    members = None
    if a.archive_passphrase_file:
        private_file(a.archive_passphrase_file, 'passphrase file')
        sums = archive_members(a.archive, a.archive_passphrase_file)
        members = {'snapshotMatches': sums.get('snapshot.json') == a.snapshot_sha,
                   'keyFileMatches': sums.get('app.seed') == sha256_file(a.key_file)}
        if not all(members.values()):
            raise Refused('the archive does not hold this snapshot and key file')
    private_dir(a.root, 'root path')
    blocked, names = blocked_set(a.blocked)
    snap = json.loads(raw)
    deriv, endpoints, resolution, stats = derive(snap, resolve4)
    verify_derivative(snap, deriv, resolution)
    hit = {ip for ip, _ in endpoints} & {e['ip'] for e in blocked}
    if hit:
        raise Refused(f'{len(hit)} Sia host address(es) equal a blocked address: refusing')
    if not endpoints:
        raise Refused('no Sia host resolved to a global IPv4 siamux endpoint')
    run = Path(a.root) / (now().strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4))
    run.mkdir(mode=0o700)
    draw = json.dumps(deriv, separators=(',', ':')).encode()
    write_new(run / 'snapshot-ip-pinned.json', draw)
    dsha = hashlib.sha256(draw).hexdigest()
    if sha256_file(a.snapshot) != a.snapshot_sha:
        raise Refused('the original snapshot changed during prepare')
    record = {'format': 'sia-whole-restore-run/v1', 'createdAt': now().isoformat(), 'run': str(run),
              'snapshot': str(Path(a.snapshot).resolve()), 'snapshotSha256': a.snapshot_sha,
              'archive': str(Path(a.archive).resolve()), 'archiveSha256': a.archive_sha, 'archiveMembers': members,
              'keyFile': str(Path(a.key_file).resolve()), 'derivativeSha256': dsha, 'derivativeBytes': len(draw),
              'endpoints': [{'ip': ip, 'port': port} for ip, port in endpoints], 'blocked': blocked, 'blockedNames': names,
              'resolution': resolution, 'stats': stats}
    write_new(run / 'run.json', dumps(record))
    return out({'prepared': True, 'run': str(run), 'snapshotSha256': a.snapshot_sha, 'derivativeSha256': dsha,
                'archiveSha256': a.archive_sha, 'archiveMembers': members, 'allowedEndpoints': len(endpoints),
                'allowedIPs': len({ip for ip, _ in endpoints}), 'blockedEndpoints': len(blocked), 'blockedNames': len(names), **stats})


# ---- targets ---------------------------------------------------------------------------------------------------------
def ssh_argv(h):
    return ['ssh', '-p', str(h['port']), '-i', h['identity'], '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3', '-o', f"UserKnownHostsFile={h['knownHosts']}",
            '-o', 'StrictHostKeyChecking=yes', h['dest']]


def ssh(h, command, stdin=None, timeout=SSH_SHORT):
    p = subprocess.run(ssh_argv(h) + [command], input=stdin if stdin is not None else b'', capture_output=True, timeout=timeout)
    return p.returncode, p.stdout


def ssh_target(a):
    for k in ('ssh_dest', 'ssh_port', 'ssh_identity', 'ssh_known_hosts'):
        if not getattr(a, k):
            raise Refused('--target vm needs --ssh-dest, --ssh-port, --ssh-identity and --ssh-known-hosts')
    return {'dest': a.ssh_dest, 'port': a.ssh_port, 'identity': a.ssh_identity, 'knownHosts': a.ssh_known_hosts}


PROBE = r'''
import json,socket,sys
r=[]
for ip,port in json.loads(sys.argv[1]):
    try:socket.create_connection((ip,port),5).close();r.append(True)
    except OSError:r.append(False)
print(json.dumps(r))
'''


def outside_control(run, target, h):
    """Every outsideMustConnect endpoint (the indexer) answers OUTSIDE the scope, so the inside block is meaningful."""
    want = [(e['ip'], e['port']) for e in run['blocked'] if e['outsideMustConnect']]
    if target == 'local':
        got = []
        for ip, port in want:
            try:
                socket.create_connection((ip, port), 5).close()
                got.append(True)
            except OSError:
                got.append(False)
    else:
        code, o = ssh(h, 'python3 -I -c ' + shlex.quote(PROBE) + ' ' + shlex.quote(json.dumps(want)))
        got = json.loads(o) if code == 0 else [False] * len(want)
    if not all(got):
        raise Refused('the indexer control endpoint is not reachable outside the scope: isolation cannot be demonstrated')
    return len(got)


def tar_bytes(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tar:
        for name, (data, mode) in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), mode, int(now().timestamp())
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def unit_props(a, ips=None):
    runtime = a.deadline_secs + 900 + a.max_total_bytes // (25 << 20)  # deadline + probes/grace + an on-disk re-hash
    props = ['Type=exec', f'MemoryMax={a.memory_max_mib}M', 'MemorySwapMax=0', 'TasksMax=512', f'CPUQuota={a.cpu_quota}%',
             f'RuntimeMaxSec={runtime}', 'KillMode=control-group', 'NoNewPrivileges=yes']
    if ips is not None:  # system units only: a second, kernel-enforced allowlist for the whole unit (bridge included)
        props += ['IPAddressDeny=any', 'IPAddressAllow=' + ' '.join(ips)]
    return [x for p in props for x in ('-p', p)]


def start(a):
    hexarg(a.binary_sha, 'binary sha')
    if not 0 < a.deadline_secs <= MAX_DEADLINE or a.max_total_bytes <= 0 or not 128 <= a.memory_max_mib <= 65536 or not 1 <= a.cpu_quota <= 3200:
        raise Refused('deadline must be 1..604800 s, budget > 0, memory 128..65536 MiB, cpu quota 1..3200 %')
    run_dir = Path(a.run).resolve()
    private_dir(run_dir, 'run directory')
    run = json.loads((run_dir / 'run.json').read_text())
    # every pin, before anything is copied, uploaded or started
    pinned(a.binary, a.binary_sha, 'binary')
    pinned(run['snapshot'], run['snapshotSha256'], 'original snapshot')
    pinned(run['archive'], run['archiveSha256'], 'archive')
    pinned(run_dir / 'snapshot-ip-pinned.json', run['derivativeSha256'], 'derivative snapshot')
    private_file(run['keyFile'], 'key file')
    h = ssh_target(a) if a.target == 'vm' else None
    if a.target == 'local':
        st = os.statvfs(run_dir)
        if st.f_bavail * st.f_frsize < a.max_total_bytes + RESERVE:
            raise Refused('not enough free space at the run directory for the byte budget plus 1 GiB')
    controls = outside_control(run, a.target, h)
    attempts = run_dir / 'attempts'
    attempts.mkdir(mode=0o700, exist_ok=True)
    n = len([p for p in attempts.iterdir() if p.is_dir()]) + 1
    attempt = attempts / f'{n:03d}-{secrets.token_hex(3)}'
    attempt.mkdir(mode=0o700)
    (attempt / 'stage').mkdir(mode=0o700)
    staged = attempt / 'stage' / 'sia-s3'
    with open(a.binary, 'rb') as src:
        write_new(staged, src.read(), 0o700)
    pinned(staged, a.binary_sha, 'staged binary')
    runner_bytes = RUNNER.read_bytes()
    unit = f"{UNIT_PREFIX}{run_dir.name[-8:]}-{n:03d}"
    plan = {'format': 'sia-whole-restore-plan/v1', 'binarySha256': a.binary_sha, 'snapshotSha256': run['derivativeSha256'],
            'originalSnapshotSha256': run['snapshotSha256'], 'maxTotalBytes': a.max_total_bytes, 'deadlineSecs': a.deadline_secs,
            'endpoints': run['endpoints'], 'blocked': run['blocked'], 'blockedNames': run['blockedNames']}
    handle = {'format': 'sia-whole-restore-handle/v1', 'target': a.target, 'unit': unit, 'attempt': str(attempt),
              'startedAt': now().isoformat(), 'binarySha256': a.binary_sha, 'runnerSha256': hashlib.sha256(runner_bytes).hexdigest()}
    if a.target == 'local':
        plan.update({'binary': str(staged), 'snapshot': str(run_dir / 'snapshot-ip-pinned.json'), 'keyFile': run['keyFile'],
                     'outdir': str(attempt / 'restored'), 'originalSnapshot': run['snapshot']})
        write_new(attempt / 'plan.json', dumps(plan))
        write_new(attempt / 'runner.py', runner_bytes, 0o600)
        write_new(attempt / 'handle.json', dumps(handle))
        argv = ['systemd-run', '--user', f'--unit={unit}', '--description=isolated whole-snapshot Sia restore',
                f'--working-directory={attempt}'] + unit_props(a) + ['/usr/bin/python3', '-I', str(attempt / 'runner.py'), 'run', str(attempt)]
        p = subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, timeout=30)
        if p.returncode:
            raise Refused('systemd-run did not start the unit')
    else:
        remote = f"{a.vm_root.rstrip('/')}/{run_dir.name}-{n:03d}-{secrets.token_hex(3)}"
        plan.update({'binary': remote + '/stage/sia-s3', 'snapshot': remote + '/snapshot-ip-pinned.json', 'keyFile': remote + '/stage/key',
                     'outdir': remote + '/restored', 'originalSnapshot': None})
        plan_bytes = dumps(plan)
        write_new(attempt / 'plan.json', plan_bytes)
        files = {'stage/sia-s3': (staged.read_bytes(), 0o700), 'stage/key': (Path(run['keyFile']).read_bytes(), 0o600),
                 'snapshot-ip-pinned.json': ((run_dir / 'snapshot-ip-pinned.json').read_bytes(), 0o600),
                 'plan.json': (plan_bytes, 0o600), 'runner.py': (runner_bytes, 0o600)}
        want = {k: hashlib.sha256(v[0]).hexdigest() for k, v in files.items()}
        handle.update({'remote': remote, 'ssh': h})
        write_new(attempt / 'handle.json', dumps(handle))
        code, _ = ssh(h, 'sudo -n mkdir -m 0700 -- ' + shlex.quote(remote))
        if code:
            raise Refused('could not create the new private VM directory')
        code, _ = ssh(h, 'sudo -n tar -x -k --no-same-owner -f - -C ' + shlex.quote(remote) + ' && sudo -n chmod 0700 '
                      + shlex.quote(remote + '/stage'), stdin=tar_bytes(files), timeout=SSH_UPLOAD)
        del files
        if code:
            raise Refused('upload failed; the VM directory is kept for inspection (finish --abandon removes its staging)')
        code, o = ssh(h, 'sudo -n sha256sum -- ' + ' '.join(shlex.quote(remote + '/' + k) for k in sorted(want)))
        got = {line.split()[1][len(remote) + 1:]: line.split()[0] for line in o.decode().splitlines() if line.strip()}
        if code or got != want:
            raise Refused('uploaded files differ from what was sent; nothing was started')
        ips = sorted({e['ip'] for e in run['endpoints']})
        argv = ['sudo', '-n', 'systemd-run', f'--unit={unit}', '--description=isolated whole-snapshot Sia restore',
                f'--working-directory={remote}'] + unit_props(a, ips) + ['/usr/bin/python3', '-I', remote + '/runner.py', 'run', remote]
        code, _ = ssh(h, shlex.join(argv))
        if code:
            raise Refused('systemd-run did not start the unit on the VM')
    return out({'started': True, 'target': a.target, 'unit': unit, 'attempt': str(attempt), 'remote': handle.get('remote'),
                'outsideControlsReached': controls, 'allowedEndpoints': len(run['endpoints']), 'binarySha256': a.binary_sha,
                'derivativeSha256': run['derivativeSha256'], 'maxTotalBytes': a.max_total_bytes, 'deadlineSecs': a.deadline_secs,
                'memoryMaxMiB': a.memory_max_mib})


# ---- polling and cleanup by the exact handle -------------------------------------------------------------------------
STATUS = r'''
import json,os,subprocess,sys
d,unit,user=sys.argv[1],sys.argv[2],sys.argv[3]=='1'
show=subprocess.run(['systemctl']+(['--user'] if user else [])+['show',unit,'--no-pager','-p','ActiveState,SubState,Result,ExecMainStatus,InvocationID,MemoryPeak,LoadState'],capture_output=True,text=True)
u=dict(l.split('=',1) for l in show.stdout.splitlines() if '=' in l)
def load(n):
    try:return json.load(open(os.path.join(d,n)))
    except (OSError,ValueError):return None
files=written=pending=0
o=os.path.join(d,'restored','objects')
if os.path.isdir(o):
    for n in os.listdir(o):
        s=os.lstat(os.path.join(o,n)).st_size
        if n.endswith('.bin') and not n.startswith('.'):files+=1;written+=s
        else:pending+=s
print(json.dumps({'unit':u,'started':load('started.json'),'result':load('result.json'),'progress':{'files':files,'bytes':written,'inFlightBytes':pending}}))
'''


def attempt_handle(a):
    run_dir = Path(a.run).resolve()
    private_dir(run_dir, 'run directory')
    attempts = sorted(p for p in (run_dir / 'attempts').iterdir() if p.is_dir())
    if a.attempt:
        attempts = [p for p in attempts if p.name == a.attempt]
    if not attempts:
        raise Refused('no such attempt')
    attempt = attempts[-1]
    return attempt, json.loads((attempt / 'handle.json').read_text())


def status(h):
    if h['target'] == 'local':
        p = subprocess.run([sys.executable, '-I', '-c', STATUS, h['attempt'], h['unit'], '1'], capture_output=True, stdin=subprocess.DEVNULL, timeout=SSH_SHORT)
        code, o = p.returncode, p.stdout
    else:
        code, o = ssh(h['ssh'], 'sudo -n python3 -I -c ' + shlex.quote(STATUS) + ' ' + shlex.quote(h['remote']) + ' ' + shlex.quote(h['unit']) + ' 0')
    if code:
        raise Refused('status read failed')
    s = json.loads(o)
    u, started, result = s['unit'], s['started'], s['result']
    active = u.get('ActiveState') in ('active', 'activating', 'deactivating', 'reloading')
    inv = u.get('InvocationID') or ''
    if active and started and started.get('invocationId') and inv != started['invocationId']:
        state = 'handle-mismatch'  # another process now holds this unit name: never act on it
    elif active:
        state = 'running'
    elif result is not None:
        state = 'succeeded' if result.get('success') else 'failed'
    else:
        state = 'ended-without-result'
    return state, s


def poll(a):
    attempt, h = attempt_handle(a)
    state, s = status(h)
    return out({'state': state, 'unit': h['unit'], 'attempt': attempt.name, 'unitState': {k: s['unit'].get(k) for k in
                ('ActiveState', 'Result', 'ExecMainStatus', 'MemoryPeak')}, 'progress': s['progress'], 'result': s['result']},
               {'succeeded': 0, 'running': 3}.get(state, 1))


def stop(a):
    attempt, h = attempt_handle(a)
    state, _ = status(h)
    if state != 'running':
        raise Refused(f'unit is not running under this handle ({state})')
    argv = ['systemctl'] + (['--user'] if h['target'] == 'local' else []) + ['stop', h['unit']]
    code = subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, timeout=SSH_SHORT).returncode if h['target'] == 'local' \
        else ssh(h['ssh'], 'sudo -n ' + shlex.join(argv))[0]
    return out({'stopRequested': code == 0, 'unit': h['unit']}, 0 if code == 0 else 1)


def finished(a):
    attempt, h = attempt_handle(a)
    state, s = status(h)
    if state in ('running', 'handle-mismatch'):
        raise Refused(f'attempt is {state}')
    return attempt, h, state


def finish(a):
    attempt, h, state = finished(a)
    if state != 'succeeded' and not a.abandon:
        raise Refused(f'attempt {state}: staging (on the VM, the uploaded key) is kept; pass --abandon to remove it anyway')
    if h['target'] == 'local':
        stage = attempt / 'stage'
        if stage.is_dir() and not stage.is_symlink():
            shutil.rmtree(stage)
        subprocess.run(['systemctl', '--user', 'reset-failed', h['unit']], capture_output=True, stdin=subprocess.DEVNULL, timeout=SSH_SHORT)
        code = 0
    else:
        code, _ = ssh(h['ssh'], 'sudo -n rm -rf --one-file-system -- ' + shlex.quote(h['remote'] + '/stage') +
                      ' && test ! -e ' + shlex.quote(h['remote'] + '/stage'))
        ssh(h['ssh'], 'sudo -n systemctl reset-failed ' + shlex.quote(h['unit']))
    return out({'stagingRemoved': code == 0, 'state': state, 'restoredDataKept': True, 'unit': h['unit']}, 0 if code == 0 else 1)


def discard(a):
    attempt, h, state = finished(a)
    if h['target'] == 'local':
        r = attempt / 'restored'
        if r.is_symlink():
            raise Refused('restored path is a symlink')
        existed = r.is_dir()
        if existed:
            shutil.rmtree(r)
        code = 0
    else:
        existed = True
        code, _ = ssh(h['ssh'], 'sudo -n rm -rf --one-file-system -- ' + shlex.quote(h['remote'] + '/restored'))
    return out({'restoredRemoved': code == 0 and existed, 'state': state, 'attempt': attempt.name}, 0 if code == 0 else 1)


# ---- read-only resource check ----------------------------------------------------------------------------------------
CHECK = r'''
import json,os,re,subprocess,sys
root=sys.argv[1];p=root
while not os.path.exists(p):p=os.path.dirname(p)
st=os.statvfs(p);mem=dict(re.findall(r'^(\w+):\s+(\d+)',open('/proc/meminfo').read(),re.M))
def ok(c):
    try:return subprocess.run(c,capture_output=True,timeout=20).returncode==0
    except (OSError,subprocess.SubprocessError):return False
def first(c):
    try:return subprocess.run(c,capture_output=True,text=True,timeout=20).stdout.splitlines()[0]
    except (OSError,subprocess.SubprocessError,IndexError):return None
print(json.dumps({'path':p,'freeBytes':st.f_bavail*st.f_frsize,'memAvailableMiB':int(mem['MemAvailable'])//1024,'cpus':os.cpu_count(),
 'python':sys.version.split()[0],'systemd':first(['systemctl','--version']),'glibc':first(['ldd','--version']),
 'userSystemd':ok(['systemctl','--user','show-environment']),'sudoN':ok(['sudo','-n','true']),
 'unprivilegedNetns':ok(['unshare','--user','--map-root-user','--net','sh','-c','ip link set lo up && ip address add 192.0.2.1/32 dev lo']),
 'rootNetns':ok(['sudo','-n','unshare','--net','true']),
 'userControllers':open('/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/cgroup.subtree_control'%(os.getuid(),os.getuid())).read().split() if os.path.exists('/sys/fs/cgroup/user.slice/user-%d.slice/user@%d.service/cgroup.subtree_control'%(os.getuid(),os.getuid())) else None}))
'''


def check(a):
    if a.target == 'local':
        p = subprocess.run([sys.executable, '-I', '-c', CHECK, a.root], capture_output=True, stdin=subprocess.DEVNULL, timeout=SSH_SHORT)
        code, o = p.returncode, p.stdout
    else:
        code, o = ssh(ssh_target(a), 'python3 -I -c ' + shlex.quote(CHECK) + ' ' + shlex.quote(a.root))
    if code:
        raise Refused('resource check failed to run')
    r = json.loads(o)
    need = a.total_bytes + RESERVE
    glibc_need = None
    if a.binary:
        found = re.findall(rb'GLIBC_2\.([0-9]+)', Path(a.binary).read_bytes())
        glibc_need = '2.%d' % max(int(x) for x in found) if found else None
    have = re.search(r'([0-9]+)\.([0-9]+)\s*$', r.get('glibc') or '')
    r.update({'target': a.target, 'needBytes': need, 'fitsBudget': r['freeBytes'] >= need, 'binaryNeedsGlibc': glibc_need,
              'glibcCompatible': None if not (glibc_need and have) else int(have.group(2)) >= int(glibc_need.split('.')[1]),
              'isolationAvailable': (r['userSystemd'] and r['unprivilegedNetns'] and 'memory' in (r['userControllers'] or []))
              if a.target == 'local' else (r['sudoN'] and r['rootNetns'])})
    return out(r, 0 if r['fitsBudget'] and r['isolationAvailable'] and r['glibcCompatible'] is not False else 1)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = ap.add_subparsers(dest='cmd', required=True)

    def ssh_opts(p):
        p.add_argument('--ssh-dest')
        p.add_argument('--ssh-port', type=int)
        p.add_argument('--ssh-identity')
        p.add_argument('--ssh-known-hosts')
    p = sub.add_parser('check')
    p.add_argument('--target', choices=('local', 'vm'), required=True)
    p.add_argument('--root', required=True, help='the restore root path on that target')
    p.add_argument('--total-bytes', type=int, required=True)
    p.add_argument('--binary', help='to compare its glibc need with the target')
    ssh_opts(p)
    p = sub.add_parser('prepare')
    for k in ('--snapshot', '--snapshot-sha', '--archive', '--archive-sha', '--key-file', '--root', '--blocked'):
        p.add_argument(k, required=True)
    p.add_argument('--archive-passphrase-file')
    p = sub.add_parser('start')
    p.add_argument('--run', required=True)
    p.add_argument('--target', choices=('local', 'vm'), required=True)
    p.add_argument('--binary', required=True)
    p.add_argument('--binary-sha', required=True)
    p.add_argument('--max-total-bytes', type=int, required=True)
    p.add_argument('--deadline-secs', type=int, required=True)
    p.add_argument('--memory-max-mib', type=int, required=True)
    p.add_argument('--cpu-quota', type=int, default=200)
    p.add_argument('--vm-root', help='existing directory on the VM; a new private directory is created inside it')
    ssh_opts(p)
    for name in ('poll', 'stop', 'finish', 'discard'):
        p = sub.add_parser(name)
        p.add_argument('--run', required=True)
        p.add_argument('--attempt')
        if name == 'finish':
            p.add_argument('--abandon', action='store_true')
    a = ap.parse_args(argv)
    if a.cmd == 'start' and a.target == 'vm' and not a.vm_root:
        ap.error('--target vm needs --vm-root')
    os.umask(0o077)
    try:
        return {'check': check, 'prepare': prepare, 'start': start, 'poll': poll, 'stop': stop, 'finish': finish, 'discard': discard}[a.cmd](a)
    except Refused as e:
        return out({'refused': str(e)}, 2)


if __name__ == '__main__':
    sys.exit(main())
