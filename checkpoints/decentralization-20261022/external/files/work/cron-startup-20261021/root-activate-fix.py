"""Root-only activation of the reviewed cron host repair; uses tested Windows CAS helpers."""
import argparse, hashlib, importlib.util, json, pathlib, subprocess

if not __debug__:
    raise RuntimeError('Optimized Python is forbidden: activation guards must remain enabled')

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('activation', HERE / 'respawn-activation/activate.py')
A = importlib.util.module_from_spec(spec)
spec.loader.exec_module(A)
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('step', choices=['stage', 'preflight', 'config', 'bundle', 'host', 'restart', 'verify',
        'rollback-host', 'rollback-bundle', 'rollback-config', 'rollback-restart'])
    ap.add_argument('--execute', action='store_true')
    ap.add_argument('--expect-local', default='')
    ap.add_argument('--expect-agent-pid', type=int, default=0)
    ap.add_argument('--expect-agent-start', default='')
    ap.add_argument('--expect-cmd-pid', type=int, default=0)
    ap.add_argument('--expect-cmd-start', default='')
    args = ap.parse_args()
    manifest = json.loads((HERE / 'root-approved-fix.json').read_text())
    assert sha(HERE / 'respawn-activation/activate.py') == manifest['activateSha256']
    assert A.SCRIPTS == manifest['scripts']
    for key in ('bundle', 'host'):
        assert sha(manifest[key]['file']) == manifest[key]['new'], key + ' local bytes changed'
    A.STAGE = r'C:\ProgramData\Enclave\hotfix\cron-final-20261021'
    A.BUNDLE_NEW_FILE = A.STAGE + r'\host-admission.bundle.mjs'
    original_runner = A.run_script
    A.run_script = lambda name, params, secs=150, stage=None: original_runner(name, params, secs, stage or A.STAGE)
    bundle_new, host_new = manifest['bundle']['new'], manifest['host']['new']
    if args.step in ('restart', 'verify', 'rollback-host'):
        A.CODE[r'node\host.mjs'] = host_new
    live_bundle = bundle_new if args.step in ('host', 'restart', 'verify', 'rollback-host', 'rollback-bundle') else A.BUNDLE_OLD
    if args.step == 'stage':
        A.remote(f"$null=[IO.Directory]::CreateDirectory({A.q(A.STAGE)});'{{}}'", 60)
        pairs = [(HERE / 'respawn-activation' / n, n) for n in A.NAMES]
        pairs += [(manifest['bundle']['file'], 'host-admission.bundle.mjs'), (manifest['host']['file'], 'host.mjs')]
        for source, name in pairs:
            subprocess.run(['scp', '-q', str(source), 'minipc:/' + A.STAGE.replace('\\', '/') + '/' + name], check=True, timeout=90)
        A.receipt('root-stage', {'manifestSha256': sha(HERE / 'root-approved-fix.json'), 'rootScriptSha256': sha(__file__)})
        return
    pins, bad = A.pins_ok(live_bundle)
    assert not bad, f'live/script pin mismatch: {bad}'
    if args.step == 'preflight':
        return A.receipt('root-preflight', {'pins': pins, 'inspect': A.inspect(), 'identify': A.identify(), 'gates': A.restart_gates()})
    if args.step == 'verify':
        return A.main(['verify', '--expect-bundle-sha', bundle_new])
    assert args.execute, 'explicit --execute required'
    if args.step == 'rollback-host':
        result = A.run_script('bundle-swap.ps1', {'Mode': 'rollback', 'Target': r'C:\Program Files\Enclave\control\windows\node\host.mjs',
            'WorkDir': A.STAGE + r'\host-swap', 'OldSha': manifest['host']['old'], 'ExpectCurrent': host_new}, 150)
        return A.receipt('root-host-rollback', {'rollback': result, 'rootScriptSha256': sha(__file__)})
    if args.step == 'rollback-bundle':
        return A.main(['bundle-rollback', '--execute', '--root-authorized', '--expect-current', bundle_new, '--expect-bundle-sha', bundle_new])
    if args.step == 'rollback-config':
        assert args.expect_local, '--expect-local must be the applied config hash from its receipt'
        return A.main(['rollback-config', '--execute', '--root-authorized', '--expect-local', args.expect_local, '--expect-backup', manifest['localSha']])
    if args.step == 'config':
        return A.main(['write-config', '--execute', '--root-authorized', '--expect-config', manifest['configSha'], '--expect-local', manifest['localSha']])
    if args.step == 'bundle':
        return A.main(['bundle-apply', '--execute', '--root-authorized', '--new-sha', bundle_new, '--new-file', A.BUNDLE_NEW_FILE])
    if args.step == 'host':
        result = A.run_script('bundle-swap.ps1', {'Mode': 'apply', 'Target': r'C:\Program Files\Enclave\control\windows\node\host.mjs',
            'WorkDir': A.STAGE + r'\host-swap', 'OldSha': manifest['host']['old'], 'NewFile': A.STAGE + r'\host.mjs', 'NewSha': host_new}, 150)
        return A.receipt('root-host-apply', {'apply': result, 'rootScriptSha256': sha(__file__)})
    identity = A.identify()['result']
    assert identity['actionExact'] and identity['manager']['pid'] == manifest['managerPid']
    assert identity['manager']['start'] == manifest['managerStart']
    cmd, agent = identity['before']['cmd'], identity['before']['agent']
    assert len(cmd) == len(agent) == 1 and agent[0]['parent'] == cmd[0]['pid']
    if args.step == 'rollback-restart':
        assert agent[0]['pid'] == args.expect_agent_pid and agent[0]['start'] == args.expect_agent_start, 'rollback needs fresh, explicit agent identity'
        assert cmd[0]['pid'] == args.expect_cmd_pid and cmd[0]['start'] == args.expect_cmd_start, 'rollback needs fresh, explicit task identity'
        state = A.inspect()['result']
        assert state['configSha'] == manifest['configSha'] and state['localSha'] == manifest['localSha'], 'configuration is not restored'
        return A.main(['restart-node', '--execute', '--root-authorized', '--coordinated-repair',
            '--repair-reason', 'Root rollback: original host code, admission bundle and configuration restored from pinned private backups.',
            '--expect-bundle-sha', A.BUNDLE_OLD, '--expect-agent-pid', str(agent[0]['pid']), '--expect-agent-start', agent[0]['start'],
            '--expect-cmd-pid', str(cmd[0]['pid']), '--expect-cmd-start', cmd[0]['start'],
            '--expect-manager-pid', str(identity['manager']['pid']), '--expect-manager-start', identity['manager']['start']])
    assert agent[0]['pid'] == manifest['agentPid'] and agent[0]['start'] == manifest['agentStart'], 'agent changed; review before another restart'
    assert cmd[0]['pid'] == manifest['cmdPid'] and cmd[0]['start'] == manifest['cmdStart'], 'node task changed'
    assert A.inspect()['result'].get('decision') == 'noop: already configured'
    return A.main(['restart-node', '--execute', '--root-authorized', '--coordinated-repair',
        '--repair-reason', 'Repeated quorum failures retire cron VMs. Apply reviewed admission retry, diagnostics, single-flight tick and per-cron recovery together.',
        '--expect-bundle-sha', bundle_new, '--expect-agent-pid', str(agent[0]['pid']), '--expect-agent-start', agent[0]['start'],
        '--expect-cmd-pid', str(cmd[0]['pid']), '--expect-cmd-start', cmd[0]['start'],
        '--expect-manager-pid', str(identity['manager']['pid']), '--expect-manager-start', identity['manager']['start']])

if __name__ == '__main__':
    main()
