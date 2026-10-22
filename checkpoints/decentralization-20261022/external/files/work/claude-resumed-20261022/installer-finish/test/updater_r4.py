#!/usr/bin/env python3
"""Flow tests of update-host r4's rollback/preservation guard, LOCAL ONLY (pwsh 7.4 on Linux; mocks, no native Windows).

The REAL script text runs end to end (legacy unsigned channel, as on minipc: no release policy) in its own pwsh process with
ProgramFiles/ProgramData pointed at a temp root. Only three definitions are renamed out of the way and mocked: Install (records
which bundle's installer would run and returns the scenario's exit code), DeltaBundle (returns the prepared new bundle) and
SecureWorkDir (Windows ACLs). latest.json and Task Scheduler are mocks.
  updater_r4.py [SCRIPT] [--old]   (--old: the unpatched 96f19838 as the negative control: B and C must then FAIL)
"""
import hashlib, json, pathlib, shutil, subprocess, sys, tempfile, os

HERE = pathlib.Path(__file__).resolve().parent
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
LEGACY = '# install-host.ps1, legacy: Remove-Item $PF -Recurse\n# ENCLAVE-IDENTITY-RECORD-V1\n'
PRESERVING = '# install-host.ps1 r4\n# ENCLAVE-IDENTITY-RECORD-V1\n# ENCLAVE-ROLE-PRESERVATION-V1\n'
CORE = ['Card', 'Network', 'Node', 'Shield', 'Update']
ROLES = CORE + ['enclave-host-services-hs2', 'NetworkChecker', 'Relay']
SCENARIOS = {
    'A-roles-preserving-release-installs': dict(roles=True, new=PRESERVING, old=LEGACY, codes=[0], installs=['2026.10.22'], exit=0),
    'B-roles-legacy-release-refused': dict(roles=True, new=LEGACY, old=LEGACY, codes=[0], installs=[], exit=1, log='does not preserve the roles'),
    'C-roles-failed-install-no-legacy-rollback': dict(roles=True, new=PRESERVING, old=LEGACY, codes=[1], installs=['2026.10.22'], exit=1, log='RECOVERY REQUIRED, NOT rolling back'),
    'D-roles-failed-install-preserving-rollback': dict(roles=True, new=PRESERVING, old=PRESERVING, codes=[1, 0], installs=['2026.10.22', '2026.10.12.47'], exit=1, log='reinstalling 2026.10.12.47'),
    'E-plain-host-unchanged-behaviour': dict(roles=False, new=LEGACY, old=LEGACY, codes=[1, 0], installs=['2026.10.22', '2026.10.12.47'], exit=1, log='reinstalling 2026.10.12.47'),
    'F-only-a-role-task-counts': dict(roles='tasks', new=LEGACY, old=LEGACY, codes=[0], installs=[], exit=1, log='\\Enclave\\Relay'),
}

MOCKS = r'''
$script:Calls = Join-Path $env:MOCK_ROOT 'calls.log'
$script:Codes = @($env:MOCK_CODES.Split(',') | ForEach-Object { [int]$_ }); $script:N = 0
function SecureWorkDir { }
function DeltaBundle($latest, $installed) { Join-Path $W $latest.version }
function Install($dir, $name, $owner, $setup, [switch] $Delta) { Add-Content -LiteralPath $script:Calls -Value "install $(Split-Path -Leaf $dir)"; $c = $script:Codes[[math]::Min($script:N, $script:Codes.Count - 1)]; $script:N++; return $c }
function Invoke-RestMethod { param([switch]$UseBasicParsing, $Uri, $TimeoutSec) Get-Content -Raw (Join-Path $env:MOCK_ROOT 'latest.json') | ConvertFrom-Json }
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) @($env:MOCK_TASKS.Split(',') | Where-Object { $_ } | ForEach-Object { [pscustomobject]@{ TaskName = $_ } }) }
'''


def prepare(script_text):
    t = script_text
    anchor = '$ErrorActionPreference = "Stop"; $ProgressPreference = "SilentlyContinue"\n'
    assert t.count(anchor) == 1
    for name in ('function SecureWorkDir {', 'function Install($dir', 'function DeltaBundle($latest'):
        assert t.count(name) == 1, name
        t = t.replace(name, name.replace('function ', 'function Real', 1))
    return t.replace(anchor, anchor + MOCKS)


def run(script, sc):
    root = pathlib.Path(tempfile.mkdtemp(prefix='uh-r4-'))
    try:
        pf, pdata = root / 'PF', root / 'PD'
        en, pd, w = pf / 'Enclave', pdata / 'Enclave', pdata / 'Enclave-setup'
        for d in (en / 'control', en / 'network', pd / 'node', pd / 'logs', w / '2026.10.12.47', w / '2026.10.22'): d.mkdir(parents=True)
        (en / 'manifest.json').write_text(json.dumps({'version': '2026.10.12.47', 'files': []}))
        (en / 'update-host.ps1').write_text('#')
        if sc['roles'] is True:
            (en / 'host-services' / 'hs2').mkdir(parents=True)
        (pd / 'node' / 'host.json').write_text(json.dumps({'name': 'nucbox-k11-4', 'owner': 'owner'}))
        (w / '2026.10.12.47' / 'install-host.ps1').write_text(sc['old'])
        (w / '2026.10.22' / 'install-host.ps1').write_text(sc['new'])
        setup = b'setup-2026.10.22'; (w / 'EnclaveSetup-2026.10.22.exe').write_bytes(setup)
        (root / 'latest.json').write_text(json.dumps({'version': '2026.10.22', 'file': 'enclave-host-2026.10.22.zip', 'sha256': '0' * 64,
            'setup': 'EnclaveSetup-2026.10.22.exe', 'setupSha256': hashlib.sha256(setup).hexdigest(), 'manifest': 'manifest-2026.10.22.json', 'manifestSha256': '1' * 64}))
        (root / 'update-host.ps1').write_text(prepare(pathlib.Path(script).read_text()))
        env = dict(os.environ, ProgramFiles=str(pf), ProgramData=str(pdata), MOCK_ROOT=str(root), MOCK_CODES=','.join(map(str, sc['codes'])),
                   MOCK_TASKS=','.join(ROLES if sc['roles'] else CORE))
        p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(root / 'update-host.ps1')], capture_output=True, text=True, timeout=120, env=env)
        calls = (root / 'calls.log').read_text().split('\n') if (root / 'calls.log').exists() else []
        logs = list(pd.rglob('*update.log'))
        log = logs[0].read_text() if logs else ''
        return {'exit': p.returncode, 'installs': [c.split(' ', 1)[1] for c in calls if c], 'log': log, 'stderr': p.stderr[-800:]}
    finally:
        shutil.rmtree(root, ignore_errors=True)


def main():
    old = '--old' in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    script = pathlib.Path(args[0]).resolve() if args else HERE.parent / 'src/update-host.r4.ps1'
    results, failed = {}, []
    for name, sc in SCENARIOS.items():
        r = results[name] = run(script, sc)
        ok = r['exit'] == sc['exit'] and r['installs'] == sc['installs'] and (sc.get('log', '') in r['log'])
        (failed.append(name) if not ok else None)
        print('PASS' if ok else 'FAIL', name, '' if ok else json.dumps(r)[:600], flush=True)
    (HERE / ('updater-results.old.json' if old else 'updater-results.json')).write_text(json.dumps({'source': str(script), 'results': results, 'failures': failed}, indent=1) + '\n')
    print(f'{len(results) - len(failed)} passed, {len(failed)} failed')
    if old:   # negative control: the unpatched updater must install the legacy release (B) and roll back to it (C)
        sys.exit(0 if set(failed) == {'B-roles-legacy-release-refused', 'C-roles-failed-install-no-legacy-rollback', 'F-only-a-role-task-counts'} else 1)
    sys.exit(0 if not failed else 1)


if __name__ == '__main__':
    main()
