#!/usr/bin/python3 -I
"""Fake `ssh enclave-rpc CMD` for the r2 controller's OFFLINE tests: a stateful guest (systemd units with InvocationIDs, markers,
the activation-r2 script's install/check/start/status/stop) in $RLC_TEST_ROOT/state.json. Output formats mirror the frozen API:
  check  = retention_guard.py `pre` JSON on stdout (json.dumps indent=1, sort_keys), rc 0 admitted / 3 refused
  start  = REFUSED: ... (stderr, rc 3) or `systemctl show --property=ActiveState,SubState` lines
  status = `systemctl show --property=ActiveState,SubState,Result,ExecMainStatus` lines, then the guard `status` JSON
  stop   = `stop rc=0`, unit state lines, status JSON, NOTE line
Every call is recorded in calls.jsonl. Nothing here is evidence about the real guest."""
import fcntl, json, os, sys, time, uuid

cmd = sys.argv[-1]
root = os.environ['RLC_TEST_ROOT']
SP, U = f'{root}/state.json', 'enclave-base-retention.service'
lk = open(f'{root}/state.lock', 'w'); fcntl.flock(lk, fcntl.LOCK_EX)
S = json.load(open(SP))


def save():
    json.dump(S, open(SP + '.tmp', 'w')); os.replace(SP + '.tmp', SP)


def record(kind, **kw):
    with open(f'{root}/calls.jsonl', 'a') as f:
        f.write(json.dumps({'kind': kind, 't': time.time(), **kw}) + '\n')


def unlock():
    fcntl.flock(lk, fcntl.LOCK_UN)


def setu(name, **kw):
    S['units'][name].update(kw)


def show(names):
    blocks = []
    for n in names:
        u = S['units'][n]
        blocks.append('\n'.join([f'Id={n}', 'LoadState=loaded'] + [f'{k}={u[k]}' for k in
                      ('ActiveState', 'SubState', 'Result', 'ExecMainStatus', 'MainPID', 'UnitFileState', 'InvocationID')]))
    return '\n\n'.join(blocks) + '\n'


def status_doc():
    d = {'units': {}, 'snapshotComplete': S['marker_snapshot'], 'retentionComplete': S['marker_retention'], 'selectedArchives': 26,
         'missingArchives': 0 if S['marker_retention'] else 18, 'partialExtraction': [], 'leftovers': [], 'datadirUsers': []}
    d.update(S.get('status_override') or {})
    return json.dumps(d, indent=1, sort_keys=True)


def start_unit():
    setu(U, ActiveState='activating', SubState='start', Result='success', ExecMainStatus='0', MainPID='4242', InvocationID=uuid.uuid4().hex)
    S['run_left'], S['since_start'] = S['run_polls'], 0


r = S['units'][U]
if cmd.startswith('systemctl show ') and ' -p Id ' in cmd:
    names = cmd.split()[2:cmd.split().index('-p')]
    running = r['ActiveState'] == 'activating'
    if running:
        S['since_start'] += 1
        if S.get('fail_show_at') == S['since_start']:
            record('show-fail', n=S['since_start']); save(); sys.exit(255)
        if S.get('hijack_at') == S['since_start']:
            setu(U, InvocationID='foreign-' + uuid.uuid4().hex[:8]); record('hijack')
        S['run_left'] -= 1
        if S['run_left'] <= 0 and not str(r['InvocationID']).startswith('foreign'):
            ok = S['run_result'] == 'success'
            setu(U, ActiveState='inactive' if ok else 'failed', SubState='dead' if ok else 'failed', Result='success' if ok else 'exit-code',
                 ExecMainStatus='0' if ok else '1', MainPID='0')
            S['marker_retention'] = S['marker_retention'] or ok
    delay = S.pop('delay_next_show', 0) if running else 0
    out = show(names); record('show', state=f"{r['ActiveState']}/{r['SubState']}", inv=r['InvocationID'], delay=delay); save(); unlock()
    if delay:
        time.sleep(delay)
    sys.stdout.write(out); sys.exit(0)
if cmd.startswith('free -m'):
    record('guest-before'); print('free/df/ls (fake)'); sys.exit(0)
if 'snapshot-complete' in cmd:
    record('snapshot-marker'); print('root') if S['marker_snapshot'] else None; sys.exit(0 if S['marker_snapshot'] else 1)
if 'list-units' in cmd:
    record('capture-units'); sys.stdout.write(S.get('capture', '')); sys.exit(0)
if 'test -e /opt/enclave-rpc/retention-stage' in cmd:
    record('stage-test'); sys.exit(0 if S['staged'] else 1)
if 'install -d' in cmd and 'retention-stage' in cmd:
    S['staged'] = True; record('stage-dir'); save(); sys.exit(0)
if 'tar -xf' in cmd:
    n = len(sys.stdin.buffer.read()); record('stage-copy', bytes=n); sys.exit(0)
if 'chmod' in cmd:
    record('stage-modes'); sys.exit(0)
if 'sha256sum SHA256SUMS' in cmd:
    record('staged-verify'); print(f"{os.environ['RLC_A_SUMS']}  SHA256SUMS"); print('root 555 .'); sys.exit(0)
if cmd.endswith('retention_activate.sh install'):
    record('install'); print('identical /opt/enclave-rpc/retention/retention_guard.py'); sys.exit(0)
if cmd.endswith('retention_activate.sh check'):
    refusals = S['check_refusals']; record('check', refusals=refusals)
    if S.get('foreign_start_on_check'):
        setu(U, ActiveState='activating', SubState='start', InvocationID='foreign-precheck'); save()
    print(json.dumps({'admitted': not refusals, 'refusals': refusals, 'missingArchives': 18, 'partialExtraction': [], 'leftovers': [],
                      'preflight': {}}, indent=1, sort_keys=True))
    sys.exit(0 if not refusals else 3)
if cmd.endswith('retention_activate.sh start'):
    mode = S['start_mode']; record('start', mode=mode, before=r['InvocationID'])
    if r['ActiveState'] not in ('inactive', 'failed'):
        print(f"REFUSED: {U} is busy or in an unexpected state: '{r['ActiveState']}'", file=sys.stderr); sys.exit(3)
    if mode == 'refuse':
        print('REFUSED: guard refused (see JSON above)', file=sys.stderr); sys.exit(3)
    if mode in ('ok', 'lost-started'):
        start_unit(); save()
    if mode.startswith('lost'):
        unlock(); time.sleep(60); sys.exit(0)
    print('ActiveState=activating\nSubState=start'); sys.exit(0)
if cmd.endswith('retention_activate.sh stop'):
    record('stop', inv=r['InvocationID'], state=f"{r['ActiveState']}/{r['SubState']}")
    if r['ActiveState'] in ('activating', 'active'):
        setu(U, ActiveState='failed', SubState='failed', Result='signal', ExecMainStatus='15', MainPID='0')
    save(); print('stop rc=0'); print(f"ActiveState={r['ActiveState']}\nSubState={r['SubState']}\nResult={r['Result']}"); print(status_doc())
    print('NOTE: nothing deleted; the holder stays disabled; resume with: retention_activate.sh start'); sys.exit(0)
if cmd.endswith('retention_activate.sh status'):
    record('status')
    print(f"ActiveState={r['ActiveState']}\nSubState={r['SubState']}\nResult={r['Result']}\nExecMainStatus={r['ExecMainStatus']}")
    print(status_doc()); sys.exit(0)
if 'retention-complete' in cmd:
    record('retention-marker')
    if not S['marker_retention']:
        sys.exit(1)
    print('root'); print(json.dumps({'format': 'enclave-base-retention-complete/v1', 'archives': 26, 'manifestSha256':
          '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2', 'completedAt': 'fake'}, sort_keys=True)); sys.exit(0)
record('UNKNOWN', cmd=cmd[:200]); sys.exit(97)
