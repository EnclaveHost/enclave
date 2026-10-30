"""postrestore-maintenance-stage/r1 guest step: root inside the maintenance VM (NO chain disks), fed on stdin by maint_boot.py:
    sudo -n /usr/bin/python3 -I - <stamp>
disable + mask exactly UNITS. Each /etc/systemd/system fragment must be byte-identical (sha256) to the root offline inventory
(logs/root-postrestore-mask-inventory-20261028.out); it is moved (rename, same filesystem) to /var/lib/enclave-rpc-maint/<stamp>/
because `systemctl mask` refuses while a real file sits at /etc/systemd/system/<unit>. Drop-in dirs and every other unit stay.
Refuses, changing nothing, if any chain disk/mount is visible, a fragment drifted, or a chain SERVICE is running (only the two
.path watchers may be stopped). Reads no chain data and no secrets. Prints one JSON line; exit 0 only if every unit verifies
masked with no enablement link left. No poweroff here: the host sends the ACPI powerdown over its own QMP.
"""
import glob, hashlib, json, os, re, subprocess, sys, time

UNITS = {
    'enclave-rpc-base-snapshot.service': 'f7a193f1f50ab147aa15d33cb7de9fbddc1ad0c01c244ffef852b417551950f4',
    'enclave-rpc-l1-snapshot.service': '42cfc951d82ff4996460a4d180a9d6b91257d1bdfbee76e23c755d7e1e267070',
    'enclave-base-retention.service': 'f02388268aa110612dbf2648f9a90a90bdc2a2e36d237cab0e869fc49b59ceee',
    'enclave-base-holder.path': '8accb496663c590e2a52a83cd73815d42a81d994b430dde96d17df1e56bf4329',
    'enclave-base-holder.service': '3d305f2ef091af5ee7edec61bcd47607c7e969e64873dec66d021db34f5955ef',
    'enclave-l1-el.path': 'd2b379983fb5b5d6a442aef9ec7738e7f09641a2166353227d214ef1579656e3',
    'enclave-l1-el.service': 'be00a7d9542f79515658f09d49bc3ad546d3d80de3f30a531a4ee5d1fd72086d',
    'enclave-l1-cl.service': '54791e1a9ac7e27d4e12ce7630d903363ba1069f9fb3529acade709a4a8bb547',
}
CHAIN_UUIDS = ('11c6bbac-f823-4052-a87a-066eed6ad590', 'a2f2a8b5-06ac-4612-95a0-f48a00a7f6e0')
CHAIN_SERIALS = ('ERPC-BASE-740457FE', 'ERPC-L1-6DA15A8D')
CHAIN_MOUNTS = ('/srv/enclave-base-holder', '/srv/enclave-l1-pair')
ETC, KEEP = '/etc/systemd/system', '/var/lib/enclave-rpc-maint'
JOB_WAIT_S = 240
RUNNING = ('active', 'activating', 'deactivating', 'reloading', 'refreshing')


class Die(Exception):
    pass


def P(root, path):
    return os.path.join(root, path.lstrip('/'))


def sc(run, *args):
    r = run(['systemctl', *args], stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout or ''


def show(run, unit):
    rc, out = sc(run, 'show', '--property=LoadState,ActiveState,UnitFileState', unit)
    if rc:
        raise Die(f'systemctl show {unit} rc {rc}')
    return dict(l.split('=', 1) for l in out.splitlines() if '=' in l)


def chain_absent(root):
    seen = [u for u in CHAIN_UUIDS if os.path.lexists(P(root, f'/dev/disk/by-uuid/{u}'))]
    byid = P(root, '/dev/disk/by-id')
    seen += [n for n in (os.listdir(byid) if os.path.isdir(byid) else []) if any(s in n for s in CHAIN_SERIALS)]
    seen += [m for m in CHAIN_MOUNTS if os.path.ismount(P(root, m))]
    disks = sorted(n for n in os.listdir(P(root, '/sys/block')) if n.startswith(('sd', 'vd', 'nvme')))
    if len(disks) != 1:
        seen.append(f'block disks {disks} (expected only the OS disk)')
    if seen:
        raise Die(f'chain disk/mount visible: {seen}; nothing changed')


def wait_jobs(run, sleep, clock):
    """boot jobs for these units / their mounts may still wait on the absent devices (x-systemd.device-timeout=120s)"""
    end = clock() + JOB_WAIT_S
    while True:
        rc, out = sc(run, 'list-jobs', '--no-legend', '--plain', '--no-pager')
        pending = sorted({l.split()[1] for l in out.splitlines() if len(l.split()) > 1 and
                          (l.split()[1] in UNITS or l.split()[1].startswith('srv-enclave'))})
        if rc == 0 and not pending:
            return
        if clock() > end:
            raise Die(f'jobs still pending after {JOB_WAIT_S}s: {pending} (rc {rc}); nothing changed')
        sleep(5)


def masked_link(path):
    return os.path.islink(path) and os.readlink(path) == '/dev/null'


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main(argv, root='/', run=subprocess.run, sleep=time.sleep, clock=time.monotonic):
    moved = []
    try:
        if not argv or not re.fullmatch(r'\d{8}T\d{6}Z-[0-9a-f]{6}', argv[0]):
            raise Die('usage: - <stamp>')
        if root == '/' and os.geteuid() != 0:
            raise Die('must run as root in the guest')
        etc, keep = P(root, ETC), P(root, f'{KEEP}/{argv[0]}')
        chain_absent(root)
        wait_jobs(run, sleep, clock)
        plan = {}
        for u, want in UNITS.items():
            s = show(run, u)
            if s.get('ActiveState') in RUNNING and not u.endswith('.path'):
                raise Die(f"{u} is {s.get('ActiveState')}: a chain service runs; nothing changed")
            f = os.path.join(etc, u)
            if masked_link(f):
                plan[u] = 'already-masked'; continue
            if os.path.islink(f) or not os.path.isfile(f):
                raise Die(f'{f} is not a regular file; nothing changed')
            with open(f, 'rb') as fh:
                got = hashlib.sha256(fh.read()).hexdigest()
            if got != want:
                raise Die(f'{u} sha256 {got} is not the inventoried {want} (identity drift); nothing changed')
            plan[u] = 'move'
        os.makedirs(P(root, KEEP), mode=0o700, exist_ok=True)
        os.mkdir(keep, 0o700)
        if os.stat(keep).st_dev != os.stat(etc).st_dev:
            raise Die(f'{keep} is not on the /etc filesystem; nothing changed')
        stopped = []
        for u in (x for x in UNITS if x.endswith('.path')):
            if show(run, u).get('ActiveState') in RUNNING:
                if sc(run, 'stop', u)[0]:
                    raise Die(f'cannot stop the watcher {u}')
                stopped.append(u)
        if sc(run, 'disable', '--no-reload', *UNITS)[0]:
            raise Die('systemctl disable failed')
        for u in (x for x, how in plan.items() if how == 'move'):
            os.rename(os.path.join(etc, u), os.path.join(keep, u)); moved.append(u)
        fsync_dir(keep); fsync_dir(etc)
        if sc(run, 'mask', '--no-reload', *UNITS)[0] or sc(run, 'daemon-reload')[0]:
            raise Die('systemctl mask/daemon-reload failed')
        verified = {}
        for u in UNITS:
            s = show(run, u)
            links = [l for k in ('wants', 'requires', 'upholds') for l in glob.glob(os.path.join(etc, f'*.{k}', u))]
            kept = os.path.join(keep, u)
            same = plan[u] == 'already-masked' or (os.path.isfile(kept) and
                                                   hashlib.sha256(open(kept, 'rb').read()).hexdigest() == UNITS[u])
            verified[u] = masked_link(os.path.join(etc, u)) and s.get('LoadState') == 'masked' and \
                s.get('UnitFileState') == 'masked' and s.get('ActiveState') not in RUNNING and not links and same
        os.sync()
        rec = {'ok': all(verified.values()), 'plan': plan, 'moved': moved, 'stoppedWatchers': stopped, 'keptIn': f'{KEEP}/{argv[0]}',
               'verified': verified}
        with open(os.path.join(keep, 'RECEIPT.json'), 'w') as fh:
            json.dump(rec, fh, indent=1, sort_keys=True); fh.write('\n'); fh.flush(); os.fsync(fh.fileno())
        print(json.dumps(rec, sort_keys=True))
        return 0 if rec['ok'] else 2
    except (Die, OSError, subprocess.SubprocessError, ValueError) as e:
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}', 'moved': moved}, sort_keys=True))
        return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
