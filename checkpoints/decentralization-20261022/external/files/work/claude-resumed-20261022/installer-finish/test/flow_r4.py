#!/usr/bin/env python3
"""Control-flow scenarios for install-host r4, LOCAL ONLY (pwsh 7.4 on Linux; mocks, no native Windows).

Reuses the existing section harness (ref/harness.r2.py: the script is ASSEMBLED FROM THE REAL FILE TEXT - definitions incl.
r4's update guard, section 5 up to the first role restore, sections 7 and 8, and the real `} finally {` closing) with the
same multi-line-finally adaptation root used for r3 (ref/test_install_flow.py). Mocks are extended with task actions,
process command lines and creation times, a scheduler start that is accepted but never reaches Running, Get-Acl for the
private-logs check, and on-disk updater/rollback-bundle fixtures.

  flow_r4.py SCRIPT [--expect-old]   -> runs every scenario, writes results JSON beside this file, exit 0 iff all pass
"""
import importlib.util, json, pathlib, shutil, subprocess, sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('harness', HERE.parent / 'ref/harness.r2.py')
h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)

# --- root's r3 adaptation: keep the real multi-line finally block ---------------------------------------------------
original_assemble = h.assemble
def assemble(text):
    marker = '} finally {\n  Restore-OtherTasks "during final cleanup"'
    position = text.rfind(marker)
    assert position > 0
    temporary = text[:position] + '} finally { Restore-OtherTasks "compatibility marker" }\nexit 0\n'
    body = original_assemble(temporary)
    # the real success line (in the tray/EnclaveDNS stretch the section harness leaves out) closes the try, as in the script
    done = next(l for l in text.splitlines() if l.startswith('Emit "done" "ok" "Enclave host'))
    return body[:body.rfind('} finally { Restore-OtherTasks')] + done + '\n' + text[position:]

# --- mock extensions -------------------------------------------------------------------------------------------------
P = h.PRELUDE
def sub(old, new):
    global P
    assert P.count(old) == 1, old
    P = P.replace(old, new)
sub("function Ev($m) {", "function X($s) { ([string]$s).Replace('{PF}', $PF).Replace('{PD}', $PD) }\nfunction Ev($m) {")
sub("Settings = [pscustomobject]@{ Enabled = [bool]$t.enabled }; engine = $t.engine } }",
    "Settings = [pscustomobject]@{ Enabled = [bool]$t.enabled }; engine = $t.engine; Actions = @(@($t.actions) | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ Execute = (X $_.exe); Arguments = (X $_.args); WorkingDirectory = (X $_.wd) } }) } }")
sub("function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $t =",
    "function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) if (@($MockScn.startFails) -contains $TaskName) { Ev \"start-refused $TaskName\"; throw 'scheduler denied start' }; if (@($MockScn.staysReady) -contains $TaskName) { Ev \"start-accepted-not-running $TaskName\"; return }; $t =")
sub("ExecutablePath = ($p.exe -replace '^PF', $PF) } }",
    "ExecutablePath = ($p.exe -replace '^PF', $PF); CreationDate = $(if ($p.created) { $p.created } else { \"c$($p.pid)\" }); CommandLine = (X $p.cmd) } }")
sub("function Get-CimInstance { param($ClassName) @($script:MockP.Values) }",
    "$script:CimCalls = 0\nfunction Get-CimInstance { param($ClassName) $script:CimCalls++; if ($MockScn.reusePid -and $script:CimCalls -ge 2 -and $script:MockP[[int]$MockScn.reusePid]) { $script:MockP[[int]$MockScn.reusePid].CreationDate = 'reused' }; @($script:MockP.Values) }\n"
    "function Get-Acl { param($LiteralPath) $o = [pscustomobject]@{ AreAccessRulesProtected = -not $MockScn.logsPublic }\n"
    "  $o | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-32-544' } }\n"
    "  $o | Add-Member ScriptMethod GetAccessRules { param($a, $b, $t) $r = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' } }); if ($MockScn.logsPublic) { $r += [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-545' } } }; $r }\n"
    "  $o }")
h.PRELUDE = P

LEGACY_UPDATER = '# update-host.ps1 (legacy e0d9df1c stand-in: carries no rollback-guard marker)\n'
GUARD_UPDATER = '# update-host.ps1 ... ENCLAVE-ROLLBACK-GUARD-V1 ...\n'
LEGACY_TARGET = '# install-host.ps1 of 2026.10.12.47 (legacy: Remove-Item $PF -Recurse)\n'
PRESERVING_TARGET = '# install-host.ps1 ... ENCLAVE-ROLE-PRESERVATION-V1 ...\n'

original_make_root = h.make_root
def make_root(sc):
    r = original_make_root(sc)
    pf, pd = r / 'PF', r / 'PD'
    if sc.get('updater'):
        (pf / 'update-host.ps1').write_text(sc['updater'])
    if sc.get('target'):
        t = r / 'Enclave-setup' / '2026.10.12.47'; t.mkdir(parents=True); (t / 'install-host.ps1').write_text(sc['target'])
    if sc.get('plainHost'):
        shutil.rmtree(pf / 'host-services'); shutil.rmtree(pf / 'challenge-replica')
    for name, text in (sc.get('files') or {}).items():
        f = r / name.replace('{PF}/', 'PF/').replace('{PD}/', 'PD/'); f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text.replace('{PF}', str(pf)).replace('{PD}', str(pd)))
    return r
h.make_root = make_root

def run(script_path, name):
    """harness.run plus the files this revision writes, read before the temp root is removed"""
    sc = h.SCENARIOS[name]; r = make_root(sc)
    body = assemble(pathlib.Path(script_path).read_text(encoding='utf-8'))
    if sc.get('inject', {}).get('point') == 'pre-copy':
        body = body.replace('$manifest = Get-Content (Join-Path $Bundle "manifest.json")', 'Inject "pre-copy"\n$manifest = Get-Content (Join-Path $Bundle "manifest.json")', 1)
    (r / 'assembled.ps1').write_text(h.PRELUDE + body, encoding='utf-8')
    p = subprocess.run([h.PWSH, '-NoProfile', '-NonInteractive', '-File', str(r / 'assembled.ps1'), '-MockScenario', name, '-MockRoot', str(r)],
                       capture_output=True, text=True, timeout=180)
    ev = (r / 'events.log').read_text().splitlines() if (r / 'events.log').exists() else []
    emits = []
    for l in p.stdout.splitlines():
        try: emits.append(json.loads(l))
        except Exception: pass
    pf = r / 'PF'
    kept = {k: (pf / k).exists() for k in ('host-services/hs2/bin/hostsvc-supervisor.exe', 'challenge-replica/release-3e1560f94542/dns.mjs', 'network/challenge-replica/release-3e1560f94542/dns.mjs')}
    st = r / 'PD/logs/install-status.json'
    status = json.loads(st.read_text(encoding='utf-8-sig')) if st.exists() else None
    version = json.loads((pf / 'manifest.json').read_text())['version'] if (pf / 'manifest.json').exists() else None
    shutil.rmtree(r, ignore_errors=True)
    return {'exit': p.returncode, 'events': ev, 'emits': emits, 'kept': kept, 'status': status, 'pfVersion': version, 'stderr': p.stderr[-800:]}

# --- scenarios -------------------------------------------------------------------------------------------------------
T, LP = h.tasks, h.LIVE_PROCS
def procs(*extra, drop=()):
    out = [dict(p) for p in LP if p['pid'] not in drop]; out += list(extra); return out
EXT_NODE = 'C:\\Program Files\\nodejs\\node.exe'
# Relay as an EXTERNAL node.exe executing a release-owned script (the r3 blocker), hs2's external node on its own source
EXTERNAL = procs(dict(pid=101, ppid=100, exe=EXT_NODE, cmd='"' + EXT_NODE + '" "{PF}\\host-services\\hs2\\app\\main.mjs"'),
                 dict(pid=301, ppid=300, exe=EXT_NODE, cmd='"' + EXT_NODE + '" "{PF}\\network\\relay.mjs" --port 8443'), drop=(101, 301))
# NetworkChecker: external node whose command line names nothing; its task's wrapper script runs a control\ script
WRAPPED = procs(dict(pid=200, ppid=1, exe='C:\\Windows\\System32\\cmd.exe', cmd='cmd.exe /c "{PD}\\run-checker.cmd"'),
                dict(pid=201, ppid=200, exe=EXT_NODE, cmd='node checker.mjs'), drop=(200,))
CHECKER_ACTION = [dict(exe='cmd.exe', args='/c "{PD}\\run-checker.cmd"', wd='')]
NEW = {
    'L-persistent-start-failure': dict(delta=True, startFails=['Relay'], tasks=T(), procs=LP),
    'M-nostart-persistent-start-failure': dict(delta=True, noStart=True, startFails=['Relay'], tasks=T(), procs=LP),
    'N-legacy-updater-unsafe-rollback-refused': dict(delta=True, updater=LEGACY_UPDATER, target=LEGACY_TARGET, tasks=T(), procs=LP),
    'O-legacy-updater-preserving-target-fails': dict(delta=True, updater=LEGACY_UPDATER, target=PRESERVING_TARGET, inject=dict(point='after-files', kind='throw'), tasks=T(), procs=LP),
    'P-guarded-updater-legacy-target-fails': dict(delta=True, updater=GUARD_UPDATER, target=LEGACY_TARGET, inject=dict(point='tail', kind='fail'), tasks=T(), procs=LP),
    'Q-legacy-updater-plain-host': dict(delta=True, updater=LEGACY_UPDATER, target=LEGACY_TARGET, plainHost=True,
                                        tasks=[t for t in T() if t['name'] in ('Card', 'Network', 'Node', 'Shield', 'Update')], procs=[p for p in LP if p['pid'] >= 400]),
    'R-external-interpreter': dict(delta=True, tasks=T(), procs=EXTERNAL),
    'S-wrapper-script-dependency': dict(delta=True, tasks=T(NetworkChecker=dict(engine=200, actions=CHECKER_ACTION)), procs=WRAPPED,
                                        files={'{PD}/run-checker.cmd': '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "{PF}\\control\\network\\checker.mjs"\r\n'}),
    'S2-wrapper-script-independent': dict(delta=True, tasks=T(NetworkChecker=dict(engine=200, actions=CHECKER_ACTION)), procs=WRAPPED,
                                          files={'{PD}/run-checker.cmd': '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "{PF}\\host-services\\checker\\checker.mjs"\r\n'}),
    'S3-wrapper-script-unreadable': dict(delta=True, tasks=T(NetworkChecker=dict(engine=200, actions=CHECKER_ACTION)), procs=WRAPPED),
    'T-reused-pid-not-killed': dict(delta=True, reusePid=301, tasks=T(), procs=EXTERNAL),
    'U-start-accepted-never-running': dict(delta=True, staysReady=['Relay'], tasks=T(), procs=LP),
    'V-logs-not-private': dict(delta=True, logsPublic=True, tasks=T(), procs=LP),
}
h.SCENARIOS.update(NEW)
EXPECTED_EXIT = {'B': 1, 'C': 1, 'E': 1, 'F': 1, 'K': 1, 'L': 1, 'M': 1, 'O': 1, 'P': 1, 'U': 1}

OLD = False   # --expect-old: r3 writes no install-status.json, so those checks are skipped there

def check(name, r):
    k = name.split('-')[0]
    st = r['status'] if not OLD else None
    ev, em = r['events'], r['emits']
    assert r['exit'] == EXPECTED_EXIT.get(k, 0), (r['exit'], r['stderr'], em[-3:])
    if k != 'Q':
        assert r['kept']['host-services/hs2/bin/hostsvc-supervisor.exe'] and r['kept']['challenge-replica/release-3e1560f94542/dns.mjs']
    if k == 'N':
        assert ev == [], ev                                                   # nothing stopped, killed or started
        assert r['pfVersion'] == '2026.10.12.47'                             # the installed release untouched
        assert any(e['step'] == 'release' and e['state'] == 'fail' and 'NOT INSTALLED' in e['message'] and 'host-services' in e['message'] for e in em)
        assert OLD or r['status']['result'] == 'refused-unsafe-rollback'
        return
    assert r['pfVersion'] == ('2026.10.12.47' if k in ('E', 'F') else '2026.10.22'), r['pfVersion']
    if k in ('F', 'J', 'Q'):
        assert not any(e in ev for e in ['stop Relay', 'start Relay', 'stop NetworkChecker', 'start NetworkChecker']), ev
    elif k in ('S2',):
        assert 'stop NetworkChecker' not in ev and 'start NetworkChecker' not in ev and 'kill 201' not in ev
    else:
        for task in ['Relay', 'NetworkChecker']:
            assert ev.count('stop ' + task) == 1, (task, ev)
            if k in ('L', 'M') and task == 'Relay':
                assert ev.count('start-refused Relay') == 2 and 'start Relay' not in ev
            elif k == 'U' and task == 'Relay':
                assert ev.count('start-accepted-not-running Relay') == 2 and 'start Relay' not in ev
            else:
                assert ev.count('start ' + task) == 1 and ev.index('stop ' + task) < ev.index('start ' + task), (task, ev)
    if k not in ('G',):
        assert 'stop enclave-host-services-hs2' not in ev and 'kill 100' not in ev and 'kill 101' not in ev, ev
    else:
        assert ev.count('start enclave-host-services-hs2') == 1
    if k in ('C', 'D', 'H', 'M'):
        assert 'start Node' not in ev
    if k in ('D', 'H', 'M'):
        assert 'start Network' not in ev
    if k == 'H':
        assert 'start Shield' not in ev
    if k in ('R',):
        assert 'kill 301' in ev and 'kill 300' in ev                         # the external node of the stopped Relay
        assert OLD or st['roles']['Relay']['why'].startswith('process 301')
        assert OLD or st['roles']['enclave-host-services-hs2']['stopped'] is False
    if k == 'T':
        assert 'kill 301' not in ev and 'kill 300' in ev                     # same id, other creation time: not that process
    if k in ('S', 'S3'):
        assert 'kill 200' in ev and 'kill 201' in ev
        assert OLD or ('names a release file' if k == 'S' else 'could not be read') in st['roles']['NetworkChecker']['why'], st
    if k in ('L', 'M', 'U'):
        assert any(e['state'] == 'fail' and e['step'] == 'services' and 'Relay' in e['message'] for e in em)
        assert OLD or (st['result'] == 'RECOVERY-REQUIRED' and st['roles']['Relay']['outcome'].startswith('PENDING'))
        if k == 'U':
            assert OLD or 'not Running' in st['roles']['Relay']['outcome']
    if OLD:
        pass
    elif k == 'V':
        assert r['status'] is None                                           # never written into a folder others could plant in
    elif k not in ('N',):
        assert r['status'] is not None
        if EXPECTED_EXIT.get(k, 0) == 0:
            assert r['status']['result'] in ('installed', 'installed-nostart') and r['status']['otherRolesRestored'] is True, r['status']
    if EXPECTED_EXIT.get(k, 0):
        assert any(e.startswith('inject ') for e in ev) or any(e['state'] == 'fail' for e in em), 'failure must be deliberate, not a fixture error'

def main():
    source = pathlib.Path(sys.argv[1]).resolve()
    global OLD
    expect_old = OLD = '--expect-old' in sys.argv
    assert h.parse_errors(source) == 0
    results, failed = {}, []
    for name in h.SCENARIOS:
        r = results[name] = run(source, name)
        try:
            check(name, r); print('PASS', name, flush=True)
        except AssertionError as e:
            failed.append(name); print('FAIL', name, str(e)[:400], flush=True)
    out = HERE / ('flow-results.old.json' if expect_old else 'flow-results.json')
    out.write_text(json.dumps({'source': str(source), 'results': results, 'failures': failed}, indent=1) + '\n')
    print(f'{len(results) - len(failed)} passed, {len(failed)} failed')
    if expect_old:   # negative control: exactly the r4 behaviours must fail on r3
        want = {'N-legacy-updater-unsafe-rollback-refused', 'R-external-interpreter', 'S-wrapper-script-dependency', 'S3-wrapper-script-unreadable', 'T-reused-pid-not-killed', 'U-start-accepted-never-running',
                # r3 retries and exits 1 here too; its final 'fail' line differs: step 'roles' (not an EnclaveSetup step), role not named
                'L-persistent-start-failure', 'M-nostart-persistent-start-failure'}
        print('negative control', 'OK' if set(failed) == want else 'MISMATCH', sorted(set(failed) ^ want))
        sys.exit(0 if set(failed) == want else 1)
    sys.exit(0 if not failed else 1)

if __name__ == '__main__':
    main()
