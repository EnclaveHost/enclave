#!/usr/bin/env python3
"""production-bootstrap-wiring-stage (PREPARED; NOT run): the release-mode Base holder's two pre-start gates. Root (the release-mode
drop-in runs the unit as root until the wrapper's own privilege drop). Never starts, stops or signals anything; the ONLY write is
own-datadir's ownership repair inside the Base data subtree.

  datadir-idle   (ExecCondition=)  exit 0 only if NOTHING else uses the Base datadir: the snapshot download unit is not
                 active/activating/deactivating/reloading (`systemctl show -p ActiveState`), AND no live process other than this one
                 names the holder mount in its argv (the running `base snapshot download --datadir /srv/enclave-base-holder/data`, the
                 A2-A4 harness's `base db|stage ... --datadir`, any other reth/base). Anything else, or anything undeterminable, exits 1:
                 systemd then SKIPS the start (a condition, not a failure: no OnFailure, no restart loop) and the download is never
                 touched. The first anchored start (journal `armed`) runs no harness check in the permit ("nothing to permit"), so this
                 is the gate that keeps a release-mode start off a datadir that is still being downloaded.
  wait-l1 SEC    (ExecStartPre=)   cold boot: enclave-l1-el/cl are started before the holder (After=) but are not yet synced. Polls the
                 wrapper's own read-only `chain_service.py l1-ready` every 15 s until it exits 0, or exits 1 after SEC (the start fails,
                 OnFailure -> enclave-base-recover.service). Without it the wrapper refuses at once on every attempt and 5 attempts in 1 h
                 reach StartLimitBurst (50-finality-restart.conf), leaving the holder down until a human resets it.
  own-datadir    (ExecStartPre=)   the A2-A4 harness, `arm`/`rearm` and the restart permit run the base binary on the STOPPED datadir as
                 ROOT (harness Base.run: subprocess as the caller); any file or directory they create is root-owned, and the node -
                 exec'd by the wrapper as rpcbase - could not write it. Every entry under the data subtree that is not rpcbase:rpcbase is
                 lchown'ed to rpcbase:rpcbase (no symlink is followed; modes untouched). chown changes ctime only: the dev/ino/size/
                 mtimeNs the launch record, `arm` and the permit bound stay valid. Runs after datadir-idle (nothing else uses the datadir).
All run BEFORE the wrapper takes the launch lock, so none can consume or change the launch journal."""
import os, pathlib, pwd, stat, subprocess, sys, time

MOUNT = '/srv/enclave-base-holder'
DOWNLOAD_UNIT = 'enclave-rpc-base-snapshot.service'        # harness-first/a2a4.py SNAPSHOT_UNIT (stage_backend.py)
BUSY = {'active', 'activating', 'deactivating', 'reloading', 'refreshing'}
DATA = MOUNT + '/data'
SERVICE_USER = 'rpcbase'                                   # == chain_service.BASE_SERVICE_USER
L1_READY = ['/usr/bin/python3', '-I', '-B', '/opt/enclave-rpc/chain_service.py', 'l1-ready']
POLL_SEC = 15


def unit_state(unit, run=subprocess.run):
    p = run(['/usr/bin/systemctl', 'show', '-p', 'ActiveState', '--value', unit], capture_output=True, text=True, timeout=30)
    s = p.stdout.strip()
    if p.returncode != 0 or not s:
        raise RuntimeError(f'systemctl show {unit}: rc {p.returncode}')
    return s


def users_of(mount=MOUNT, proc='/proc', me=None):
    """[(pid, argv)] of live processes naming the mount (or a path below it) in their argv. A process that exits during the scan is
    skipped; an unreadable /proc itself raises (undeterminable -> the caller refuses)."""
    me = os.getpid() if me is None else me; out = []
    for name in os.listdir(proc):
        if not name.isdigit() or int(name) == me:
            continue
        try:
            with open(os.path.join(proc, name, 'cmdline'), 'rb') as f:
                argv = [a.decode(errors='replace') for a in f.read().split(b'\0') if a]
        except (FileNotFoundError, ProcessLookupError):
            continue
        if any(a == mount or a.startswith(mount + '/') or ('=' in a and a.split('=', 1)[1].startswith(mount)) for a in argv):
            out.append((int(name), argv))
    return out


def datadir_idle(run=subprocess.run, proc='/proc', me=None, unit=DOWNLOAD_UNIT, mount=MOUNT):
    try:
        st = unit_state(unit, run)
        users = users_of(mount, proc, me)
    except Exception as e:                                   # noqa: BLE001 - undeterminable is NOT idle
        return 1, f'cannot determine datadir users ({type(e).__name__}: {e}): start skipped'
    if st in BUSY:
        return 1, f'{unit} is {st}: the download owns the datadir; start skipped (the download is not touched)'
    if users:
        return 1, f'{len(users)} process(es) use {mount} (first: pid {users[0][0]} {" ".join(users[0][1])[:200]}): start skipped'
    return 0, f'{unit} {st}; no process names {mount}'


def wait_l1(limit, run=subprocess.run, sleep=time.sleep, clock=time.monotonic):
    end = clock() + limit; n = 0
    while True:
        n += 1
        try:
            p = run(L1_READY, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=120)
            if p.returncode == 0:
                return 0, f'L1 ready after {n} check(s)'
            why = (p.stderr or p.stdout).strip().splitlines()[-1:] or ['']
        except subprocess.TimeoutExpired:
            why = ['l1-ready timed out']
        if clock() + POLL_SEC > end:
            return 1, f'L1 not ready within {limit} s ({n} checks; last: {why[0][:200]})'
        sleep(POLL_SEC)


def own_datadir(data=DATA, user=SERVICE_USER, chown=os.lchown, getpw=pwd.getpwnam, lstat=os.lstat):
    """two passes: (1) scan - every entry must be on the data subtree's own filesystem (st_dev) and every entry to repair must not be
    a multi-link regular file (a hard link could reach a file outside the subtree); any violation refuses BEFORE anything changes;
    (2) lchown the collected entries (no symlink is followed; modes untouched)."""
    pw = getpw(user)
    if pw.pw_uid == 0 or pw.pw_gid == 0:
        return 1, f'{user} must not be root'
    st = lstat(data)
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode):
        return 1, f'{data} is not a real directory'
    todo = []

    def check(q):
        e = lstat(q)
        if e.st_dev != st.st_dev:
            raise ValueError(f'{q} is on another filesystem (a mount inside the data subtree)')
        if (e.st_uid, e.st_gid) != (pw.pw_uid, pw.pw_gid):
            if stat.S_ISREG(e.st_mode) and e.st_nlink > 1:
                raise ValueError(f'{q} is a hard-linked file not owned by {user}: not changed')
            todo.append(q)
    try:
        check(data)
        for top, dirs, files in os.walk(data, followlinks=False, onerror=lambda e: (_ for _ in ()).throw(e)):
            for n in dirs + files:
                check(os.path.join(top, n))
    except (OSError, ValueError) as e:
        return 1, f'refused, nothing changed: {e}'
    for q in todo:
        chown(q, pw.pw_uid, pw.pw_gid)
    return 0, f'{len(todo)} entr{"y" if len(todo) == 1 else "ies"} under {data} given to {user}'


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    if argv[1:] == ['datadir-idle']:
        rc, msg = datadir_idle()
    elif argv[1:] == ['own-datadir']:
        rc, msg = own_datadir()
    elif len(argv) == 3 and argv[1] == 'wait-l1' and argv[2].isdigit() and 60 <= int(argv[2]) <= 4 * 3600:
        rc, msg = wait_l1(int(argv[2]))
    else:
        print(__doc__); return 2
    print(f'holder_gate {argv[1]}: {msg}', flush=True)
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv))
