#!/usr/bin/python3 -I
"""q3_guard_inspect.py (guest-state-qualification-stage/r2; PREPARED, never run by Claude). GUEST, root, READ-ONLY.
Q3 of logs/claude-guest-state-install-review.md. PRECONDITION (a separate, reviewed root action, NOT done here): the candidate drop-in
is installed and `systemctl daemon-reload` was run. This script then only READS and runs the guard BY HAND:
  1. the installed retention unit file is byte-identical to the reviewed unit (sha256 pin), the installed drop-in to the candidate pin;
  2. retention + holder are not running (never touched: no start/stop/reload anywhere in this script);
  3. systemd's LOADED view: NeedDaemonReload=no, FragmentPath = the unit, DropInPaths includes the drop-in, and ExecStartPre order is
     mountpoint, retention_guard.py pre, THEN the state guard (last, privileged '+'), so the guard runs before ExecStart (reth);
  4. `systemd-analyze verify` of the loaded unit;
  5. the guard argv exactly as systemd will run it, executed by hand with a timeout -> the expected rc/reason
     (before install: rc 2 "no state-installed.json"; after a real install, Q4: rc 0);
  6. the retention unit is still not running and its InvocationID unchanged.
Writes only --record. Exit 0 = all checks as expected; 2 = refused precondition; 1 = a check differs.
"""
import argparse, hashlib, json, os, re, subprocess, sys, time

UNIT = 'enclave-base-retention.service'
HOLDER = 'enclave-base-holder.service'
ENV = {'PATH': '/usr/bin:/bin', 'LC_ALL': 'C'}


def sha256(p):
    with open(p, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


def run(cmd, timeout=60):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=ENV, stdin=subprocess.DEVNULL)
    return r.returncode, r.stdout, r.stderr


def show(props):
    rc, out, err = run(['/usr/bin/systemctl', 'show', UNIT] + [f'-p{p}' for p in props])
    if rc != 0:
        raise SystemExit(f'systemctl show failed: {err}')
    return dict(l.split('=', 1) for l in out.splitlines() if '=' in l)


def parse_exec(value):
    """systemctl show ExecStartPre= -> list of argv strings in order"""
    return [m.group(2) for m in re.finditer(r'\{ path=(\S+) ; argv\[\]=(.*?) ; ignore_errors=', value)]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--unit-path', default='/etc/systemd/system/enclave-base-retention.service')
    ap.add_argument('--unit-sha256', required=True, help='reviewed retention unit (stage file f02388268a...59ceee)')
    ap.add_argument('--dropin-path', default='/etc/systemd/system/enclave-base-retention.service.d/60-state-install-guard.conf')
    ap.add_argument('--dropin-sha256', required=True, help='the FROZEN candidate drop-in (guest-state-install-stage, root input)')
    ap.add_argument('--guard-marker', default='guest_state.py guard', help='substring identifying the state guard argv')
    ap.add_argument('--expect-guard-rc', type=int, required=True)
    ap.add_argument('--expect-guard-reason', default='', help='substring the guard output must contain (e.g. "no state-installed.json")')
    ap.add_argument('--record', required=True)
    a = ap.parse_args()
    if os.getuid() != 0:
        print('run as root'); sys.exit(2)
    rec = {'format': 'enclave-guest-qualification-q3/r1', 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'checks': {}}
    bad = []

    def check(name, ok, **kw):
        rec['checks'][name] = {'ok': bool(ok), **kw}
        if not ok:
            bad.append(name)

    check('unit-file-sha256', sha256(a.unit_path) == a.unit_sha256, got=sha256(a.unit_path))
    check('dropin-file-sha256', sha256(a.dropin_path) == a.dropin_sha256, got=sha256(a.dropin_path))
    before = {}
    for u in (UNIT, HOLDER):
        rc, out, _ = run(['/usr/bin/systemctl', 'is-active', u]); before[u] = out.strip()
    if any(s not in ('inactive', 'failed', 'unknown') for s in before.values()):
        print(json.dumps({'event': 'refused', 'reason': 'retention or holder is running: nothing inspected or run', 'states': before}))
        sys.exit(2)
    s = show(['NeedDaemonReload', 'FragmentPath', 'DropInPaths', 'ExecStartPre', 'ExecStartPreEx', 'ExecStart', 'InvocationID', 'ActiveState'])
    inv0 = s.get('InvocationID', '')
    check('need-daemon-reload-no', s.get('NeedDaemonReload') == 'no', got=s.get('NeedDaemonReload'))
    check('fragment-path', os.path.realpath(s.get('FragmentPath', '')) == os.path.realpath(a.unit_path), got=s.get('FragmentPath'))
    check('dropin-loaded', a.dropin_path in s.get('DropInPaths', '').split(), got=s.get('DropInPaths'))
    pre = parse_exec(s.get('ExecStartPre', ''))
    rec['execStartPre'] = pre; rec['execStartPreEx'] = s.get('ExecStartPreEx', ''); rec['execStart'] = s.get('ExecStart', '')
    gi = [i for i, v in enumerate(pre) if a.guard_marker in v]
    pi = [i for i, v in enumerate(pre) if 'retention_guard.py pre' in v]
    check('guard-present-once', len(gi) == 1, count=len(gi))
    check('guard-after-retention-pre-and-last', len(gi) == 1 and len(pi) == 1 and gi[0] > pi[0] and gi[0] == len(pre) - 1, order=pre)
    ex = s.get('ExecStartPreEx', '')
    ent = [m.group(0) for m in re.finditer(r'\{ path=\S+ ; argv\[\]=.*? ; flags=[^;]*;', ex)]
    gex = [e for e in ent if a.guard_marker in e]
    check('guard-privileged', len(gex) == 1 and re.search(r'flags=[^;]*\bprivileged\b', gex[0]) is not None, raw=ex[-800:])
    rc, out, err = run(['/usr/bin/systemd-analyze', 'verify', UNIT], timeout=120)
    check('systemd-analyze-verify', rc == 0, rc=rc, out=(out + err)[-2000:])
    if len(gi) == 1:
        argv = pre[gi[0]].split()
        try:
            r = subprocess.run(argv, capture_output=True, text=True, timeout=300, env=ENV, stdin=subprocess.DEVNULL)
            grc, gout = r.returncode, r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            grc, gout = 'timeout', ''
        check('guard-by-hand', grc == a.expect_guard_rc and a.expect_guard_reason in gout, rc=grc, out=gout[-2000:], argv=argv)
    after = {}
    for u in (UNIT, HOLDER):
        rc, out, _ = run(['/usr/bin/systemctl', 'is-active', u]); after[u] = out.strip()
    s2 = show(['InvocationID'])
    check('retention-untouched', after == before and s2.get('InvocationID', '') == inv0, before=before, after=after)
    rec['result'] = 'PASS' if not bad else 'FAIL'; rec['failed'] = bad
    fd = os.open(a.record, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(rec, f, indent=1); f.write('\n')
    print(json.dumps({'event': 'q3-result', 'result': rec['result'], 'failed': bad}))
    sys.exit(0 if not bad else 1)


if __name__ == '__main__':
    main()
