#!/usr/bin/env python3
"""SOURCE ONLY. Run as an independent root service BEFORE gate, never from the chat PTY.

Expiry removes only the exact owned gate if original relay identity remains unchanged.
An activation marker or activation lock prevents automatic reopening during/after activation.
No restart, source rollback, journal rollback, financial call or mutation retry.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import session_gate as g

WATCH = Path('/var/lib/enclave-maintenance/session-write-gate-watchdogs')
PINS = {
    '/opt/nan-relay/api-relay.js': '481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d',
    '/opt/nan-relay/sessions.mjs': '457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d',
}


def relay_identity():
    r = subprocess.run(['systemctl', 'show', 'enclave-api-relay.service',
                        '--property=MainPID', '--value'], check=True,
                       capture_output=True, text=True, timeout=5)
    pid = int(r.stdout.strip())
    if pid <= 0:
        raise RuntimeError('relay is not running')
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'startTicks': fields[19],
            'sources': {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in PINS}}


def recover(op, baseline, watchdir):
    """Called once at deadline while holding activation.lock; errors retain the gate."""
    if (watchdir / 'activation-started.json').exists():
        return {'outcome': 'manual-review', 'reason': 'activation started; gate retained'}
    if relay_identity() != baseline:
        return {'outcome': 'manual-review', 'reason': 'relay identity changed; gate retained'}
    opdir = g.BACKUPS / op
    if not opdir.exists():
        return {'outcome': 'no-operation', 'reason': 'gate operation was never prepared'}
    g.secure_dir(g.BACKUPS); g.secure_dir(opdir)
    s = g.load(opdir / 'state.json')
    owned = g.gate_route(op)
    if s.get('op') != op or s.get('owned') != owned:
        raise RuntimeError('gate operation identity mismatch')
    routes, etag = g.read_routes()
    hits = [r for r in routes if r.get('@id') == owned['@id']]
    if not hits:
        return {'outcome': 'gate-absent', 'routesSha256': g.digest(routes)}
    updated = g.remove_owned(routes, owned)
    # Recheck identity immediately before CAS; activation must also hold this lock.
    if (watchdir / 'activation-started.json').exists() or relay_identity() != baseline:
        return {'outcome': 'manual-review', 'reason': 'activation/identity changed; gate retained'}
    g.mutate('PATCH', updated, etag, s, opdir / 'state.json', 'restore')
    return {'outcome': 'owned-gate-restored', 'routesSha256': s['afterHash']}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--op', required=True)
    p.add_argument('--seconds', type=int, default=900)
    p.add_argument('--apply', action='store_true')
    a = p.parse_args()
    g.gate_route(a.op)
    if not a.apply or os.geteuid() != 0 or not 60 <= a.seconds <= 900:
        raise RuntimeError('root, explicit --apply and deadline60..900seconds required')
    g.secure_dir(Path('/var/lib/enclave-maintenance'), create=True)
    g.secure_dir(WATCH, create=True)
    wd = WATCH / a.op
    if not wd.exists():
        wd.mkdir(mode=0o700); g.sync_dir(WATCH)
    g.secure_dir(wd)
    instance = os.open(wd / 'instance.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(instance, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(instance)
        raise RuntimeError('another watchdog owns this operation')
    # Separate lock coordinates activation without releasing instance ownership.
    fd = os.open(wd / 'activation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise RuntimeError('activation/watchdog lock busy; do not launch another operation')
    statepath = wd / 'watchdog.json'
    if statepath.exists():
        s = g.load(statepath)
        if s.get('op') != a.op:
            raise RuntimeError('watchdog operation mismatch')
        # A restarted service preserves its original deadline, never resets it.
        if 'outcome' in s:
            print(json.dumps(s['outcome'])); return
    else:
        baseline = relay_identity()
        if baseline['sources'] != PINS:
            raise RuntimeError('original source pins changed; re-review before arming')
        s = {'op': a.op, 'armedAtUnix': time.time(), 'deadlineUnix': time.time() + a.seconds,
             'deadlineMonotonic': time.monotonic() + a.seconds,
             'bootId': Path('/proc/sys/kernel/random/boot_id').read_text().strip(), 'baseline': baseline}
        g.save(statepath, s)
    if s.get('bootId') != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        raise RuntimeError('host rebooted; review gate status before recovery')
    fcntl.flock(fd, fcntl.LOCK_UN)
    print(json.dumps({'ready': True, 'op': a.op, 'deadlineUnix': s['deadlineUnix'],
                      'watchdogState': str(statepath)}), flush=True)
    # This process belongs to systemd, independent of the calling chat/helper.
    while time.time() < s['deadlineUnix'] and time.monotonic() < s['deadlineMonotonic']:
        time.sleep(min(5, max(0, s['deadlineUnix'] - time.time()),
                       max(0, s['deadlineMonotonic'] - time.monotonic())))
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        s['outcome'] = {'outcome': 'manual-review', 'reason': 'activation lock held at deadline; gate retained'}
    else:
        # Mark this recovery attempt before network I/O. A later restart never
        # retries an interrupted mutation; operator reads live status first.
        if s.get('recoveryAttempted'):
            s['outcome'] = {'outcome': 'manual-review', 'reason': 'previous recovery outcome unknown; no resend'}
        else:
            s['recoveryAttempted'] = True
            g.save(statepath, s)
            try:
                s['outcome'] = recover(a.op, s['baseline'], wd)
            except Exception as e:
                s['outcome'] = {'outcome': 'manual-review', 'reason': type(e).__name__ + ': recovery uncertain; no resend'}
    g.save(statepath, s)
    print(json.dumps(s['outcome']), flush=True)
    os.close(fd)
    os.close(instance)
    if s['outcome']['outcome'] == 'manual-review':
        raise SystemExit(2)


if __name__ == '__main__':
    main()
