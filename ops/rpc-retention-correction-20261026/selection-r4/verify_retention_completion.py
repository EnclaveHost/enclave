#!/usr/bin/python3 -I
"""selection-r4: READ-ONLY completion evidence for ONE exact retention-unit invocation (writes nothing; exit 0 complete, 1 not
complete, 2 refused: still running, usage, unreadable). Four SEPARATE sections; `jobComplete` needs all of them:
  terminal    the unit is inactive with Result=success, ExecMainStatus=0, MainPID 0, the EXACT InvocationID root recorded at start,
              and ExecStart argv equal to the reviewed command. A failed/killed/other invocation is NEVER complete, whatever is on disk.
  marker      /srv/enclave-base-holder/retention-complete (activation-r2 `post`, unchanged): a root-owned 0444 regular file whose record
              names the pinned manifest, the reviewed argv and floors, archives == 26 (its r2 SUBSET scope), completedAt at/after
              the invocation's start. The marker is evidence of r2's 26-archive check only, never of the full selection or state.
  history     size presence of all 30 selected history archives (+ 107 headers), at/above vs below the declared floor.
  state       presence only: db/mdbx.dat is a non-empty regular file. finalize rewrites the DB (mod.rs:647-674), so the manifest's
              mdbx.dat/lock/mdbx.lck sizes and blake3 are NOT required and are reported as informational (expected to differ).
Size presence is NOT integrity (reth verified blake3 during the run; this tool does not hash), and nothing here is chain readiness:
coverage may be claimed from the declared floor (48000000 / 52500000) only.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
UNIT = 'enclave-base-retention.service'
HISTORY_FROM, STATE_FROM, R2_MARKER_ARCHIVES = 48_000_000, 52_500_000, 26
# the reviewed live invocation's paths (the argv is compared against these, wherever the evidence files are read from)
LIVE_DATADIR, LIVE_MANIFEST = '/srv/enclave-base-holder/data', '/opt/enclave-rpc/snapshots/base-1792886410-manifest.json'
PROPS = ('ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'ExecMainCode', 'MainPID', 'InvocationID', 'ExecMainStartTimestampMonotonic',
         'ExecMainStartTimestamp', 'ExecStart')


def _pf():
    spec = importlib.util.spec_from_file_location('pf_r4', os.path.join(HERE, 'retention_preflight.py'))
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def unit_show(run=subprocess.run):
    r = run(['systemctl', 'show', '--property=' + ','.join(PROPS), UNIT], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f'cannot read {UNIT}')
    return dict(l.split('=', 1) for l in r.stdout.splitlines() if '=' in l)


def exec_argv(s):
    """systemctl's ExecStart value '{ path=... ; argv[]=a b c ; ... }' -> ['a', 'b', 'c'] (no quoting in the reviewed argv)"""
    m = re.search(r'argv\[\]=(.*?) ;', s or '')
    return m.group(1).split() if m else None


def terminal(u, invocation, argv):
    checks = {'inactive': u.get('ActiveState') == 'inactive' and u.get('SubState') == 'dead',
              'resultSuccess': u.get('Result') == 'success', 'exitStatus0': u.get('ExecMainStatus') == '0',
              'noMainPid': u.get('MainPID') == '0', 'exactInvocation': bool(invocation) and u.get('InvocationID') == invocation,
              'reviewedArgv': exec_argv(u.get('ExecStart')) == argv}
    return {'ok': all(checks.values()), 'checks': checks, 'unit': {k: u.get(k) for k in PROPS if k != 'ExecStart'}}


def marker(root, argv, started_at, uid):
    p = os.path.join(root, 'retention-complete')
    checks = {}
    try:
        st = os.lstat(p)
        checks['regularNotSymlink'] = stat.S_ISREG(st.st_mode)
        checks['owner'] = st.st_uid == uid
        checks['mode0444'] = stat.S_IMODE(st.st_mode) == 0o444
        rec = json.loads(open(p).read()) if checks['regularNotSymlink'] else None
    except (OSError, ValueError):
        return {'ok': False, 'present': os.path.lexists(p), 'checks': {'readable': False}, 'scope': 'r2 26-archive subset'}
    rec = rec if isinstance(rec, dict) else {}
    checks.update({'format': rec.get('format') == 'enclave-base-retention-complete/v1',
                   'manifest': rec.get('manifestSha256') == _pf().PINNED_MANIFEST_SHA256, 'argv': rec.get('argv') == argv,
                   'floors': (rec.get('historyFrom'), rec.get('stateHistoryFrom')) == (HISTORY_FROM, STATE_FROM),
                   'r2SubsetScope': rec.get('archives') == R2_MARKER_ARCHIVES})
    try:
        done = datetime.datetime.fromisoformat(rec.get('completedAt'))
        checks['afterInvocationStart'] = started_at is not None and done.tzinfo is not None and done >= started_at
    except (TypeError, ValueError):
        checks['afterInvocationStart'] = False
    return {'ok': all(checks.values()), 'present': True, 'checks': checks, 'record': rec,
            'scope': 'r2 26-archive subset check only: NOT the full selection, NOT state verification, NOT readiness'}


def history(pf, manifest, datadir):
    hist = pf.history_plan(manifest, HISTORY_FROM, STATE_FROM)
    heads = pf.header_archives(manifest)
    miss = [f"{x['component']}:{x['chunk']}" for x in hist if not pf.size_present(datadir, x['outputs'])]
    hmiss = [f"headers:{x['chunk']}" for x in heads if not pf.size_present(datadir, x['outputs'])]
    below = [x for x in hist if x['belowDeclaredFloor']]
    return {'ok': not miss and not hmiss, 'integrity': pf.SIZE_ONLY, 'selected': len(hist), 'sizeMissing': miss,
            'atOrAboveFloor': {'selected': len(hist) - len(below), 'missing': sum(1 for x in hist if not x['belowDeclaredFloor'] and f"{x['component']}:{x['chunk']}" in miss)},
            'belowDeclaredFloor': {'selected': len(below), 'missing': sum(1 for x in below if f"{x['component']}:{x['chunk']}" in miss)},
            'headers': {'planned': len(heads), 'sizeMissing': hmiss}, 'declaredFloor': {'history': HISTORY_FROM, 'stateHistory': STATE_FROM}}


def state(pf, manifest, datadir):
    s = pf.state_component(manifest)
    dat = os.path.join(datadir, 'db', 'mdbx.dat')
    ok = os.path.isfile(dat) and not os.path.islink(dat) and os.path.getsize(dat) > 0
    info = {o['path']: {'present': os.path.isfile(os.path.join(datadir, o['path'])),
                        'matchesManifestSize': pf.size_present(datadir, [o])} for o in (s['outputs'] if s else [])}
    return {'ok': ok, 'mdbxDatPresent': ok, 'outputs': info,
            'note': 'presence only; finalize rewrites the DB, so original sizes/blake3 are not required (informational)'}


def evidence(manifest_path, root, u, invocation, uid):
    pf = _pf()
    raw = open(manifest_path, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != pf.PINNED_MANIFEST_SHA256:
        return 2, {'jobComplete': False, 'refusal': 'snapshot manifest is not the pinned one'}
    if u.get('ActiveState') not in ('inactive', 'failed') or u.get('MainPID', '0') != '0':
        return 2, {'jobComplete': False, 'refusal': f'{UNIT} is running or in an unexpected state'}
    manifest, datadir = json.loads(raw), os.path.join(root, 'data')
    argv = pf.command(LIVE_DATADIR, LIVE_MANIFEST, HISTORY_FROM, STATE_FROM, 16)
    started = None
    with_ts = u.get('ExecMainStartTimestamp') or ''
    m = re.match(r'\w{3} (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC$', with_ts)
    if m:
        started = datetime.datetime.strptime(m.group(1), '%Y-%m-%d %H:%M:%S').replace(tzinfo=datetime.timezone.utc)
    rec = {'format': 'enclave-base-retention-completion-evidence/r4', 'terminal': terminal(u, invocation, argv),
           'marker': marker(root, argv, started, uid), 'history': history(pf, manifest, datadir), 'state': state(pf, manifest, datadir),
           'readiness': pf.READINESS}
    rec['jobComplete'] = all(rec[k]['ok'] for k in ('terminal', 'marker', 'history', 'state'))
    return (0 if rec['jobComplete'] else 1), rec


def main(argv=None, run=subprocess.run):
    ap = argparse.ArgumentParser()
    ap.add_argument('--invocation', required=True, help="the InvocationID root recorded when it started this job")
    ap.add_argument('--manifest', default='/opt/enclave-rpc/snapshots/base-1792886410-manifest.json')
    ap.add_argument('--root', default='/srv/enclave-base-holder')
    ap.add_argument('--marker-uid', type=int, default=0)
    ap.add_argument('--unit-json', help='testing only: the unit properties instead of systemctl')
    a = ap.parse_args(argv)
    try:
        u = json.loads(a.unit_json) if a.unit_json else unit_show(run)
        rc, rec = evidence(a.manifest, a.root, u, a.invocation, a.marker_uid)
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.SubprocessError) as e:
        rc, rec = 2, {'jobComplete': False, 'refusal': f'input: {e}'}
    print(json.dumps(rec, indent=1, sort_keys=True, default=str))
    return rc


if __name__ == '__main__':
    sys.exit(main())
