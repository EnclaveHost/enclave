#!/usr/bin/env python3
"""TEST-ONLY stand-in for `systemctl` (one Type=simple unit), used by test/remote.test.mjs. Models what the upgrade relies
on: drop-in ExecStart override order (*.conf sorted; `ExecStart=` resets), changes taking effect only after daemon-reload,
MainPID/ActiveState of the real process, and restart (SIGTERM, then start the loaded ExecStart). It runs the REAL bundles.
Fault hooks (env): FAKE_RELOAD_NOOP=1 (daemon-reload changes nothing), FAKE_CRASH_FOR=<substring> (a started process
whose argv contains it exits at once, as a runtime that fails to start)."""
import json, os, signal, subprocess, sys, time
from pathlib import Path

D = Path(os.environ['FAKE_SYSTEMD']); CFG = json.loads((D / 'config.json').read_text())
LOADED, PID = D / 'loaded.json', D / 'pid'


def effective():
    argv = CFG['fragment_argv']
    for f in sorted(Path(CFG['dropin_dir']).glob('*.conf')):
        for line in f.read_text().splitlines():
            line = line.strip()
            if line == 'ExecStart=': argv = None
            elif line.startswith('ExecStart='): argv = line[len('ExecStart='):].split()
    return argv


def alive(pid):
    try:
        st = Path('/proc/%d/stat' % pid).read_text()
        return st[st.rindex(')') + 2] not in 'ZX'
    except (FileNotFoundError, ValueError):
        return False


def pid():
    try:
        p = int(PID.read_text())
        return p if p and alive(p) else 0
    except (FileNotFoundError, ValueError):
        return 0


def stop():
    p = pid()
    if not p: return
    os.kill(p, signal.SIGTERM)
    for _ in range(100):
        if not alive(p): return
        time.sleep(0.1)
    os.kill(p, signal.SIGKILL)


cmd = sys.argv[1]
if cmd == 'daemon-reload':
    if not os.environ.get('FAKE_RELOAD_NOOP'): LOADED.write_text(json.dumps(effective()))
elif cmd == 'show':
    argv = json.loads(LOADED.read_text()) if LOADED.exists() else None
    p = pid()
    print('ExecStart={ path=%s ; argv[]=%s ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }' % (argv[0], ' '.join(argv)) if argv else 'ExecStart=')
    print('MainPID=%d' % p); print('ActiveState=%s' % ('active' if p else 'failed')); print('SubState=%s' % ('running' if p else 'failed')); print('NRestarts=0')
elif cmd == 'restart':
    stop()
    argv = json.loads(LOADED.read_text())
    env = {'PATH': os.environ.get('PATH', '/usr/bin')}
    if os.environ.get('NODE_EXTRA_CA_CERTS'):
        env['NODE_EXTRA_CA_CERTS'] = os.environ['NODE_EXTRA_CA_CERTS']
    crash = os.environ.get('FAKE_CRASH_FOR')
    if crash and crash in ' '.join(argv): env['NODE_OPTIONS'] = '--require=/nonexistent-fault-injection.cjs'
    log = open(CFG['log'], 'a')
    p = subprocess.Popen(argv, cwd='/', env=env, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
    PID.write_text(str(p.pid))
elif cmd == 'stop':
    stop()
else:
    sys.exit('fake systemctl: unsupported ' + cmd)
