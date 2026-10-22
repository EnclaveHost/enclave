import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('harness', ROOT.parent / 'revision2/test/harness.py')
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)
# Retain the actual script's multi-line finally block in the existing section assembler.
original_assemble = h.assemble
def assemble(text):
    marker = '} finally {\n  Restore-OtherTasks "during final cleanup"'
    position = text.rfind(marker)
    assert position > 0
    temporary = text[:position] + '} finally { Restore-OtherTasks "compatibility marker" }\nexit 0\n'
    body = original_assemble(temporary)
    return body[:body.rfind('} finally { Restore-OtherTasks')] + text[position:]
h.assemble = assemble
old_mock = 'function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $t ='
assert old_mock in h.PRELUDE
h.PRELUDE = h.PRELUDE.replace(old_mock, 'function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) if ($MockScn.startFails -and $TaskName -eq "Relay") { Ev "start-refused Relay"; throw "scheduler denied start" }; $t =')
h.SCENARIOS['L-persistent-start-failure'] = dict(delta=True, startFails=True, tasks=h.tasks(), procs=h.LIVE_PROCS)
h.SCENARIOS['M-nostart-persistent-start-failure'] = dict(delta=True, noStart=True, startFails=True, tasks=h.tasks(), procs=h.LIVE_PROCS)
source = ROOT / 'install-host.r3.ps1'
assert h.parse_errors(source) == 0
results = {}
failed = []
for name in h.SCENARIOS:
    result = results[name] = h.run(source, name)
    try:
        expected_exit = 1 if name[0] in 'BCEFKLM' else 0
        assert result['exit'] == expected_exit, result['stderr']
        events = result['events']
        assert result['kept']['host-services/hs2/bin/hostsvc-supervisor.exe']
        assert result['kept']['challenge-replica/release-3e1560f94542/dns.mjs']
        if name[0] not in 'FJ':
            for task in ['NetworkChecker', 'Relay']:
                assert events.count('stop ' + task) == 1
                if name[0] in 'LM' and task == 'Relay':
                    assert events.count('start-refused Relay') == 2
                    assert 'start Relay' not in events
                    assert any(e['state'] == 'fail' and e['step'] == 'roles' for e in result['emits'])
                else:
                    assert events.count('start ' + task) == 1
                    assert events.index('stop ' + task) < events.index('start ' + task)
        else:
            assert not any(e in events for e in ['stop Relay', 'start Relay', 'stop NetworkChecker', 'start NetworkChecker'])
        if name[0] != 'G':
            assert 'stop enclave-host-services-hs2' not in events
        else:
            assert events.count('start enclave-host-services-hs2') == 1
        if name[0] in 'CDH':
            assert 'start Node' not in events
        if name[0] in 'DH':
            assert 'start Network' not in events
        if name[0] == 'H':
            assert 'start Shield' not in events
        if expected_exit:
            assert any(e.startswith('inject ') for e in events) or any(e['state'] == 'fail' for e in result['emits']), 'failure must be deliberate, not a parse/fixture error'
        print('PASS', name, flush=True)
    except AssertionError as error:
        failed.append({'name': name, 'error': str(error)})
        print('FAIL', name, str(error), flush=True)
(ROOT / 'install-flow-results.json').write_text(json.dumps({'results': results, 'failures': failed}, indent=2) + '\n')
assert not failed, failed
