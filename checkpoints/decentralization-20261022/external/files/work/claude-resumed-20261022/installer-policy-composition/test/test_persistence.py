#!/usr/bin/env python3
"""Upgrade simulation for launcher-configuration persistence, LOCAL ONLY (pwsh 7.4 on Linux + a cmd.exe semantics model; NOT native
Windows). Synthetic values only (no live value is known or used).

  PRE   = launchers written by the REAL r5 template text (tools/render.ps1), then edited as on the live host: hand-made set lines
          inside run-node.cmd's loop (wallet-admission pins, contract pins, gateways; quoted, plain, conditional, and one
          same-name/different-value override), a run-shield.cmd set line, a customized shield-config.cmd value and an extra
          shield-config.cmd name; node-config.local.cmd with wallet hold, platform policy, BASE_RPCS and a QUOTED NODE_APP_RAM_GB.
  MIGRATE = root/migrate-local-config.ps1's real functions (only its three Windows ACL calls are replaced by plain file writes).
  POST  = the REAL r6 (or r5, negative control) template text rendered over the same directory with a NEW manifest.
  Check = the environment each launcher hands its program (test/cmdsim.py), before vs after, for every customized setting.
  python3 test/test_persistence.py -v
"""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, unittest

HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent
sys.path.insert(0, str(HERE)); import cmdsim
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
R5, R6 = PKG / 'ref/install-host.r5.ps1', PKG / 'src/install-host.r6p.ps1'   # installer-policy-composition: the MERGED file (r6 + 4760aae5)
MIG = PKG / 'root/migrate-local-config.ps1'
ROOTSET = re.compile(r'(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$')   # root's reader
H = lambda s: hashlib.sha256(s.encode()).hexdigest()
FH = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else 'absent'

SECRETISH = ['0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7', '0xREGISTRYPIN000000000000000000000000000001', '0xCATALOGPIN0000000000000000000000000000002',
             'https://gw-one.example,https://gw-two.example', 'C:\\ProgramData\\Enclave\\node\\host-policy', 'https://shield-gw.example',
             'https://startup-a.example,https://startup-b.example']
RUN_NODE_CUSTOM = [
    'set "BASE_RPCS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example"',   # same text as the local hook: persisted already
    'set IPFS_GATEWAYS=https://gw-one.example,https://gw-two.example',
    'set ENCLAVE_CONTRACT_PINS_FILE=C:\\ProgramData\\Enclave\\node\\contract-pins.json',
    'set "ENCLAVE_HOST_OWNERSHIP=0xbbd885d3e9bc33609387bb9710e91c1905fe6ee7"',
    'set ENCLAVE_HOST_REGISTRY_PIN=0xREGISTRYPIN000000000000000000000000000001',
    'set "ENCLAVE_HOST_CATALOG_PIN=0xCATALOGPIN0000000000000000000000000000002"',
    'set ENCLAVE_HOST_POLICY_DIR=C:\\ProgramData\\Enclave\\node\\host-policy',
    'if not defined ENCLAVE_STARTUP_RPCS set "ENCLAVE_STARTUP_RPCS=https://startup-a.example,https://startup-b.example"',
    'set "APP_SLOTS=3"',                                                                        # same name, different value than local's 4
]
LOCAL = ['@echo off', "rem This box's own node settings, read after node-config.cmd. Updates never write this file.",
         'set "BASE_RPCS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example"', 'set ENCLAVE_NETWORK_WALLET_HOLD=1',
         'set "ENCLAVE_PLATFORM_HOST_POLICY=production"', 'set ENCLAVE_PLATFORM_HOST_POLICY_RPCS=https://rpc-a.example,https://rpc-b.example,https://rpc-c.example,https://rpc-d.example',
         'set APP_SLOTS=4', 'set "NODE_APP_RAM_GB=48"', '', 'call "C:\\ProgramData\\Enclave\\lease-gas\\lease-gas-config.cmd"']
NODE_CUSTOM = ['BASE_RPCS', 'IPFS_GATEWAYS', 'ENCLAVE_CONTRACT_PINS_FILE', 'ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN', 'ENCLAVE_HOST_CATALOG_PIN',
               'ENCLAVE_HOST_POLICY_DIR', 'ENCLAVE_STARTUP_RPCS', 'APP_SLOTS', 'ENCLAVE_NETWORK_WALLET_HOLD', 'ENCLAVE_PLATFORM_HOST_POLICY',
               'ENCLAVE_PLATFORM_HOST_POLICY_RPCS', 'NODE_APP_RAM_GB', 'LEASE_GAS_MARK']
SHIELD_CUSTOM = ['IPFS_GATEWAY', 'ENCLAVE_SHIELD_EXTRA_FLAG', 'ENCLAVE_SHIELD_DEBUG']


def manifest(tag):
    files = [{'path': p, 'sha256': H(tag + p)} for p in ('guest/runtime.bin', 'guest/hyperv.psm1', 'bin/shield-host.exe', 'bin/shield-egress.exe',
                                                         'bin/shielded-bridge.exe', 'guest/runtime-shield-gpu.bin')]
    return {'version': tag, 'files': files}


def render(installer, out, tag):
    tmp = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-v-'))
    (tmp / 'm.json').write_text(json.dumps(manifest(tag)))
    v = {'PF': 'C:\\Program Files\\Enclave', 'PD': 'C:\\ProgramData\\Enclave', 'Name': 'testbox-1', 'Referral': '', 'independent': False,
         'pinsDest': 'C:\\ProgramData\\Enclave\\node\\contract-pins.json',
         'want': {'mode': 'relay', 'publicUrl': 'https://api.enclave.host/t/testbox-1', 'relay': 'https://api.enclave.host', 'gateways': [], 'rpcs': [], 'directories': [], 'checkers': []},
         'ramGb': 128, 'vmgs': 'C:\\ProgramData\\Enclave\\shield\\type1.vmgs', 'vmgsSha': 'aa' * 32, 'runtimeId': 'bb' * 32, 'Owner': 'BOX\\owner', 'gpu': False,
         'manifest': str(tmp / 'm.json')}
    (tmp / 'v.json').write_text(json.dumps(v))
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(PKG / 'tools/render.ps1'), '-Installer', str(installer), '-Vars', str(tmp / 'v.json'), '-OutDir', str(out)],
                       capture_output=True, text=True, timeout=120)
    shutil.rmtree(tmp, ignore_errors=True)
    if r.returncode: raise RuntimeError(r.stderr[-1500:])


def wlines(p, lines): p.write_bytes(('\r\n'.join(lines) + '\r\n').encode('ascii'))
def rlines(p): return p.read_bytes().decode('ascii').split('\r\n')[:-1]


def make_pre(d):
    (d / 'lease-gas').mkdir(parents=True, exist_ok=True)
    wlines(d / 'lease-gas/lease-gas-config.cmd', ['@echo off', 'set LEASE_GAS_MARK=kept'])
    wlines(d / 'node-config.local.cmd', LOCAL)
    render(R5, d, 'old')
    rn = rlines(d / 'run-node.cmd'); i = rn.index(':loop') + 1; wlines(d / 'run-node.cmd', rn[:i] + RUN_NODE_CUSTOM + rn[i:])
    rs = rlines(d / 'run-shield.cmd'); i = rs.index(':loop') + 1; wlines(d / 'run-shield.cmd', rs[:i] + ['set ENCLAVE_SHIELD_DEBUG=1'] + rs[i:])
    sc = rlines(d / 'shield-config.cmd'); k = sc.index('set IPFS_GATEWAY=https://ipfs.enclave.host')
    sc[k] = 'set IPFS_GATEWAY=https://shield-gw.example'; wlines(d / 'shield-config.cmd', sc + ['set "ENCLAVE_SHIELD_EXTRA_FLAG=on"'])


def reader(d, f):
    """root's names-and-hashes reader, re-implemented with its exact regex (the pins the migration checks)"""
    p = d / f
    if not p.exists(): return None
    return [{'name': m.group(1), 'valueSha256': H(m.group(2))} for m in (ROOTSET.match(l) for l in rlines(p)) if m]


def pins(d, extra=True):
    files = {f: FH(d / f) for f in ('run-node.cmd', 'run-shield.cmd', 'node-config.cmd', 'shield-config.cmd', 'node-config.local.cmd', 'shield-config.local.cmd')}
    sc = {s['name']: s['valueSha256'] for s in reader(d, 'shield-config.cmd')}
    ex = [{'file': 'shield-config.cmd', 'name': n, 'valueSha256': sc[n], 'hook': 'shield-config.local.cmd'} for n in ('IPFS_GATEWAY', 'ENCLAVE_SHIELD_EXTRA_FLAG')] if extra else []
    return {'files': files, 'sources': {f: reader(d, f) for f in ('run-node.cmd', 'run-shield.cmd')}, 'extra': ex}


DRIVER = r'''
param([string]$Root, [string]$Pins, [string]$Mode, [string]$PlanSha)
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($env:MIG, [ref]$tk, [ref]$er); if ($er.Count) { throw 'parse' }
$body = $ast.EndBlock.Statements | Where-Object { $_.Extent.Text -notmatch '^\s*if \(\$MyInvocation' } | ForEach-Object { $_.Extent.Text }
Invoke-Expression ($body -join "`n")
# ONLY the two Windows-ACL primitives and the ACL reader are replaced (Linux): exclusive creation, reparse/ancestor checks,
# backup-directory rules and the replace itself run for real. MOCK_ACL_BAD names a path suffix whose ACL is reported unsafe;
# MOCK_PLANT makes another writer create the file just before the exclusive create (the race CreateNew must lose safely).
# OWNER MODEL (root's native finding): a sidecar map path -> owner SID; existing files default to MOCK_EXISTING_OWNER (SYSTEM,
# as the live hook); ReplaceFile gives the destination the REPLACEMENT's owner and the backup the destination's old owner.
function Owners { if ($env:MOCK_OWNERS -and (Test-Path -LiteralPath $env:MOCK_OWNERS)) { Get-Content -Raw -LiteralPath $env:MOCK_OWNERS | ConvertFrom-Json -AsHashtable } else { @{} } }
function Save-Owners($m) { if ($env:MOCK_OWNERS) { $m | ConvertTo-Json | Set-Content -LiteralPath $env:MOCK_OWNERS } }
function Get-OwnerSid([string]$path) { $m = Owners; $k = [IO.Path]::GetFullPath($path); if ($m.ContainsKey($k)) { $m[$k] } elseif ($env:MOCK_EXISTING_OWNER) { $env:MOCK_EXISTING_OWNER } else { 'S-1-5-18' } }
function Open-NewPrivateFile([string]$path, [string]$ownerSid) {
  $asked = $(if ($ownerSid) { $ownerSid } else { 'S-1-5-32-544' })       # an r2 call passes none: its real primitive set Administrators
  if ($env:MOCK_OWNER_LOG) { Add-Content -LiteralPath $env:MOCK_OWNER_LOG -Value "$([IO.Path]::GetFileName($path)) $asked" }
  if ($env:MOCK_OWNER_REFUSE -and $asked -eq $env:MOCK_OWNER_REFUSE) { throw "The security identifier is not allowed to be the owner of this object." }
  if ($env:MOCK_PLANT -and $path -like "*$env:MOCK_PLANT") { [IO.File]::WriteAllText($path, "planted") }
  $fs = New-Object IO.FileStream($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  $m = Owners; $m[[IO.Path]::GetFullPath($path)] = $asked; Save-Owners $m; $fs }
function Invoke-FileReplace([string]$replacement, [string]$destination, [string]$backup) {
  $m = Owners; $old = Get-OwnerSid $destination
  [IO.File]::Replace($replacement, $destination, $backup)
  $r = [IO.Path]::GetFullPath($replacement)
  $m[[IO.Path]::GetFullPath($destination)] = $(if ($env:MOCK_REPLACE_OWNER) { $env:MOCK_REPLACE_OWNER } elseif ($m.ContainsKey($r)) { $m[$r] } else { 'S-1-5-32-544' })
  $m[[IO.Path]::GetFullPath($backup)] = $old; $m.Remove($r); Save-Owners $m }
function New-DirWithPrivateAcl([string]$path) { [void][IO.Directory]::CreateDirectory($path) }
function Test-PrivateAcl([string]$path) { if ($env:MOCK_ACL_BAD -and $path.TrimEnd('/') -like "*$env:MOCK_ACL_BAD") { return "S-1-5-32-545 may modify it" }; return $null }
$p = Get-Content -Raw -LiteralPath $Pins | ConvertFrom-Json
if ($Mode -eq 'expr') { try { Invoke-Expression $PlanSha; 'NO-ERROR' } catch { 'ERROR: ' + $_.Exception.Message }; exit 0 }
if ($Mode -eq 'plan') { $plan = Get-MigrationPlan $Root $p; $j = $plan | ConvertTo-Json -Depth 8 -Compress; [ordered]@{ planSha = (TS $j); plan = $plan } | ConvertTo-Json -Depth 9 }
else { Invoke-Migration $Root $p $PlanSha | ConvertTo-Json -Depth 6 }
'''


def migrate(d, p, mode='plan', plan_sha='', env=None, mig=None):
    t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-m-'))
    (t / 'pins.json').write_text(json.dumps(p)); (t / 'driver.ps1').write_text(DRIVER)
    # the plan's paths use the host form; the root dir here is the simulation dir (Join-Path works on both)
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'driver.ps1'), '-Root', str(d), '-Pins', str(t / 'pins.json'), '-Mode', mode, '-PlanSha', plan_sha],
                       capture_output=True, text=True, timeout=120, env=dict(os.environ, MIG=str(mig or MIG), **(env or {})))
    shutil.rmtree(t, ignore_errors=True)
    if r.returncode: raise RuntimeError(r.stderr[-1500:])
    return r.stdout, (r.stdout.strip() if mode == 'expr' else json.loads(r.stdout))


def migrate_ok(d):
    out, plan = migrate(d, pins(d))
    assert not plan['plan']['refused'], plan['plan']['refused']
    out2, res = migrate(d, pins(d), 'execute', plan['planSha'])
    assert res['result'] == 'MIGRATED', res
    return out + out2, plan, res


GUARD = r'''
param([string]$Dir)
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($env:INST, [ref]$tk, [ref]$er); if ($er.Count) { throw 'parse' }
foreach ($n in 'Get-SetLines', 'Get-UnpersistedSettings') { Invoke-Expression (@($ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $n }, $true))[0].Extent.Text) }
$script:SetLine = Invoke-Expression (@($ast.FindAll({ param($a) $a -is [Management.Automation.Language.AssignmentStatementAst] -and $a.Left.Extent.Text -eq '$script:SetLine' }, $true))[0].Right.Extent.Text)
@(Get-UnpersistedSettings $Dir) | ConvertTo-Json -Compress
'''


def guard(d, installer=R6):
    t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-g-')); (t / 'g.ps1').write_text(GUARD)
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'g.ps1'), '-Dir', str(d)], capture_output=True, text=True, timeout=60, env=dict(os.environ, INST=str(installer)))
    shutil.rmtree(t, ignore_errors=True)
    if r.returncode: raise RuntimeError(r.stderr[-1500:])
    v = json.loads(r.stdout or '[]'); return [v] if isinstance(v, str) else (v or [])


def lost(before, after, names):
    return {n: ('LOST' if n not in after else 'CHANGED') for n in names if before.get(n) != after.get(n)}


class Persistence(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-')); make_pre(self.d)
        self.node0 = cmdsim.effective('run-node.cmd', self.d); self.shield0 = cmdsim.effective('run-shield.cmd', self.d)

    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True)

    def test_baseline_is_what_the_live_layout_runs(self):
        self.assertEqual(self.node0['APP_SLOTS'], '3', 'run-node.cmd sets run after the local hook (same-name override wins)')
        self.assertEqual(self.node0['ENCLAVE_STARTUP_RPCS'], 'https://startup-a.example,https://startup-b.example')
        self.assertEqual(self.node0['LEASE_GAS_MARK'], 'kept')
        self.assertEqual(self.shield0['IPFS_GATEWAY'], 'https://shield-gw.example')
        self.assertNotEqual(self.shield0['NODE_APP_RAM_GB'], '48', 'r5 does not carry a QUOTED local NODE_APP_RAM_GB into Shield (the bug)')

    def test_r6_with_migration_keeps_every_setting(self):
        out, plan, res = migrate_ok(self.d)
        self.assertEqual(guard(self.d), [], 'after migration the r6 guard passes')
        render(R6, self.d, 'new')
        node, shield = cmdsim.effective('run-node.cmd', self.d), cmdsim.effective('run-shield.cmd', self.d)
        self.assertEqual(lost(self.node0, node, NODE_CUSTOM), {})
        self.assertEqual(lost(self.shield0, shield, ['IPFS_GATEWAY', 'ENCLAVE_SHIELD_EXTRA_FLAG', 'ENCLAVE_SHIELD_DEBUG']), {})
        self.assertEqual(shield['NODE_APP_RAM_GB'], node['NODE_APP_RAM_GB'], 'Shield gets the node RAM figure (quoted local entry)')
        self.assertEqual(node['NODE_APP_RAM_GB'], '48')
        self.assertEqual(shield['ENCLAVE_GUEST_IGVM_SHA256'], H('newguest/runtime.bin'), 'generated defaults still follow the new release')
        self.assertNotEqual(self.shield0['ENCLAVE_GUEST_IGVM_SHA256'], shield['ENCLAVE_GUEST_IGVM_SHA256'])
        # wallet hold, platform policy and independent gateway/contract pins effective
        for n, v in [('ENCLAVE_NETWORK_WALLET_HOLD', '1'), ('ENCLAVE_PLATFORM_HOST_POLICY', 'production'), ('ENCLAVE_HOST_OWNERSHIP', SECRETISH[0]),
                     ('ENCLAVE_CONTRACT_PINS_FILE', 'C:\\ProgramData\\Enclave\\node\\contract-pins.json'), ('IPFS_GATEWAYS', SECRETISH[3])]:
            self.assertEqual(node[n], v)
        for s in SECRETISH: self.assertNotIn(s, out, 'no value in the migration output')
        # the moved block is exactly the source lines, after the old local content (precedence kept)
        loc = rlines(self.d / 'node-config.local.cmd')
        self.assertEqual(loc[:len(LOCAL)], LOCAL)
        self.assertEqual(loc[len(LOCAL) + 1:], [l for l in RUN_NODE_CUSTOM if not l.startswith('set "BASE_RPCS')])

    def test_negative_r5_without_migration_drops_wallet_admission_and_pins(self):
        render(R5, self.d, 'new')
        miss = lost(self.node0, cmdsim.effective('run-node.cmd', self.d), NODE_CUSTOM)
        for n in ('ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN', 'ENCLAVE_HOST_CATALOG_PIN', 'ENCLAVE_HOST_POLICY_DIR', 'ENCLAVE_CONTRACT_PINS_FILE', 'IPFS_GATEWAYS', 'ENCLAVE_STARTUP_RPCS'):
            self.assertEqual(miss.get(n), 'LOST', n)
        self.assertEqual(miss.get('APP_SLOTS'), 'CHANGED')

    def test_negative_r5_with_migration_still_drops_shield_settings(self):
        migrate_ok(self.d); render(R5, self.d, 'new')
        self.assertEqual(lost(self.node0, cmdsim.effective('run-node.cmd', self.d), NODE_CUSTOM), {}, 'node settings: the existing hook works')
        shield = cmdsim.effective('run-shield.cmd', self.d)
        self.assertEqual(lost(self.shield0, shield, ['IPFS_GATEWAY', 'ENCLAVE_SHIELD_EXTRA_FLAG', 'ENCLAVE_SHIELD_DEBUG']),
                         {'IPFS_GATEWAY': 'CHANGED', 'ENCLAVE_SHIELD_EXTRA_FLAG': 'LOST', 'ENCLAVE_SHIELD_DEBUG': 'LOST'}, 'r5 has no Shield hook')
        self.assertNotEqual(shield['NODE_APP_RAM_GB'], '48', 'r5 quoted-RAM carry bug')

    def test_r6_guard_refuses_before_migration(self):
        g = guard(self.d)
        want = {f'run-node.cmd:{n}' for n in ('IPFS_GATEWAYS', 'ENCLAVE_CONTRACT_PINS_FILE', 'ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN', 'ENCLAVE_HOST_CATALOG_PIN',
                                               'ENCLAVE_HOST_POLICY_DIR', 'ENCLAVE_STARTUP_RPCS', 'APP_SLOTS')} | {'run-shield.cmd:ENCLAVE_SHIELD_DEBUG'}
        self.assertEqual(set(g), want, 'BASE_RPCS is already persisted verbatim; nothing else is')
        render(R6, self.d, 'new')   # what the guard prevents: r6 alone would drop them
        self.assertIn('ENCLAVE_HOST_OWNERSHIP', lost(self.node0, cmdsim.effective('run-node.cmd', self.d), NODE_CUSTOM))
        self.assertNotIn('Get-UnpersistedSettings', R5.read_text(), 'r5 has no such guard')

    def test_migration_is_idempotent_and_plan_writes_nothing(self):
        before = {p.name: FH(p) for p in self.d.iterdir() if p.is_file()}
        migrate(self.d, pins(self.d))
        self.assertEqual(before, {p.name: FH(p) for p in self.d.iterdir() if p.is_file()}, 'plan mode writes nothing')
        migrate_ok(self.d)
        _, plan = migrate(self.d, pins(self.d))
        acts = {r['action'] for src in plan['plan']['sources'].values() for r in src['setLines']}
        self.assertEqual(acts, {'already-persisted'})
        self.assertTrue(all(h['before'] == h['after'] for h in plan['plan']['hooks'].values()))

    def test_migration_refusals(self):
        cases = {}
        def case(name, mutate, expect):
            d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-r-')); shutil.copytree(self.d, d, dirs_exist_ok=True)
            p = pins(d); p = mutate(d, p) or p
            _, plan = migrate(d, p)
            cases[name] = plan['plan']['refused']
            self.assertTrue(any(expect in r for r in plan['plan']['refused']), (name, plan['plan']['refused']))
            before = FH(d / 'node-config.local.cmd')
            _, res = migrate(d, p, 'execute', plan['planSha'])
            self.assertEqual(res['result'], 'REFUSED'); self.assertEqual(before, FH(d / 'node-config.local.cmd'), 'nothing written')
            shutil.rmtree(d, ignore_errors=True)
        def add_run_node(line):
            def m(d, p):
                rn = rlines(d / 'run-node.cmd'); i = rn.index(':loop') + 1; wlines(d / 'run-node.cmd', rn[:i] + [line] + rn[i:]); return pins(d)
            return m
        case('metachar', add_run_node('set EVIL=a&calc'), 'command, redirection')
        case('expansion', add_run_node('set "PATHY=%ProgramData%\\x"'), 'expansion')
        case('unsupported-if', add_run_node('if "%A%"=="1" set B=2'), 'unsupported conditional')
        case('control-char', add_run_node('set NAME_X=caf\x01'), 'command, redirection')
        def hook_goto(d, p): wlines(d / 'node-config.local.cmd', LOCAL + ['goto :eof']); return pins(d)
        case('hook-control-flow', hook_goto, 'could skip')
        def cas(d, p): p['files']['node-config.local.cmd'] = '0' * 64; return p
        case('cas', cas, 'changed since review')
        def vpin(d, p): p['extra'][0]['valueSha256'] = '1' * 64; return p
        case('extra-value-pin', vpin, 'value hash differs')
        def srcpin(d, p): p['sources']['run-node.cmd'] = p['sources']['run-node.cmd'][:-1]; return p
        case('source-list-pin', srcpin, 'differ from the pinned')
        # a wrong plan sha refuses even when the plan itself is fine
        _, res = migrate(self.d, pins(self.d), 'execute', 'f' * 64)
        self.assertEqual(res['result'], 'REFUSED')



def live_json(d, files=('run-node.cmd', 'node-config.cmd', 'node-config.local.cmd', 'run-network.cmd', 'shield-config.cmd', 'run-card.cmd', 'run-shield.cmd', 'shield-config.local.cmd')):
    """what root's names-and-hashes reader returns for this directory (same regex, same hashing)"""
    out = {}
    for f in files:
        p = d / f
        if not p.exists(): out[f] = {'present': False}; continue
        sets, other = [], []
        for l in rlines(p):
            m = ROOTSET.match(l)
            if m: sets.append({'name': m.group(1), 'valueSha256': H(m.group(2))})
            else: other.append(H(l))
        out[f] = {'present': True, 'sha256': FH(p), 'sets': sets, 'otherLines': len(other), 'otherLineSha256': other}
    return out


def compare(d, tool_args):
    t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-c-')); (t / 'live.json').write_text(json.dumps(live_json(d)))
    (t / 'm.json').write_text(json.dumps(manifest('old')))
    v = {'PF': 'C:\\Program Files\\Enclave', 'PD': 'C:\\ProgramData\\Enclave', 'Name': 'testbox-1', 'Referral': '', 'independent': False, 'pinsDest': 'C:\\ProgramData\\Enclave\\node\\contract-pins.json',
         'want': {'mode': 'relay', 'publicUrl': 'https://api.enclave.host/t/testbox-1', 'relay': 'https://api.enclave.host', 'gateways': [], 'rpcs': [], 'directories': [], 'checkers': []},
         'ramGb': 128, 'vmgs': 'C:\\ProgramData\\Enclave\\shield\\type1.vmgs', 'vmgsSha': 'aa' * 32, 'runtimeId': 'bb' * 32, 'Owner': 'BOX\\owner', 'gpu': False, 'manifest': str(t / 'm.json')}
    (t / 'v.json').write_text(json.dumps(v))
    r = subprocess.run(['python3', str(PKG / 'tools/compare-config.r2.py'), str(t / 'live.json'), *tool_args(t, v), str(t / 'out.json')], capture_output=True, text=True, timeout=180)
    if r.returncode: raise RuntimeError(r.stderr[-1500:])
    o = json.loads((t / 'out.json').read_text()); shutil.rmtree(t, ignore_errors=True); return o


class CompareTool(unittest.TestCase):
    def setUp(self): self.d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-ct-')); make_pre(self.d)
    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True)

    def test_r2_blocks_before_and_clears_after_migration_never_certifies(self):
        args = lambda t, v: [str(R6), str(t / 'v.json')]
        before = compare(self.d, args)
        b = set(x.split(' ')[0] for x in before['blocking'])
        self.assertTrue({'run-node.cmd:ENCLAVE_HOST_OWNERSHIP', 'run-node.cmd:APP_SLOTS', 'shield-config.cmd:IPFS_GATEWAY', 'shield-config.cmd:ENCLAVE_SHIELD_EXTRA_FLAG',
                         'run-shield.cmd:ENCLAVE_SHIELD_DEBUG'} <= b, b)
        self.assertEqual(before['report']['shield-config.cmd']['names']['IPFS_GATEWAY']['status'], 'generated-differs')
        self.assertFalse(before['certifiesPreservation'])
        migrate_ok(self.d)
        after = compare(self.d, args)
        self.assertEqual(after['blocking'], [], after['blocking'])
        self.assertFalse(after['certifiesPreservation'], 'never certified from names/hashes')
        for s in SECRETISH: self.assertNotIn(s, json.dumps(after) + json.dumps(before))

    def test_negative_old_compare_certifies_a_lost_value(self):
        # only value-level customizations: shield IPFS_GATEWAY same name/different value; run-node's names all exist in local by NAME
        d = self.d
        rn = [l for l in rlines(d / 'run-node.cmd') if not ROOTSET.match(l)]; i = rn.index(':loop') + 1
        wlines(d / 'run-node.cmd', rn[:i] + ['set APP_SLOTS=3'] + rn[i:])            # local has APP_SLOTS=4: same name, other value
        # the local hook NAMES the settings the old parser reports as live-only (same values as generated): by NAME all is covered
        wlines(d / 'node-config.local.cmd', LOCAL + ['set IPFS_GATEWAY=https://ipfs.enclave.host',
               'set ENCLAVE_NETWORK_CHECKERS=0x57144c9008cff0b3ed94f6e40964a321fbee848a,0x033bc2b92bb1bb97c7dadf2879d3048748e2257b'])
        rs = [l for l in rlines(d / 'run-shield.cmd') if not ROOTSET.match(l)]; wlines(d / 'run-shield.cmd', rs)
        sc = [l for l in rlines(d / 'shield-config.cmd') if 'ENCLAVE_SHIELD_EXTRA_FLAG' not in l]; wlines(d / 'shield-config.cmd', sc)
        lj = live_json(d)
        # the old tool's template parser misses r5's $(if ...) lines, so any relay host's shield-config.cmd shows spurious "live-only"
        # names (IPFS_GATEWAY, ENCLAVE_SHIELD_PROFILE) and blocks; without that file its NAME-only rule certifies a lost value
        lj['shield-config.cmd'] = {'present': False}
        t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-old-')); (t / 'live.json').write_text(json.dumps(lj))
        r = subprocess.run(['python3', str(PKG / 'ref/compare-config.py'), str(t / 'live.json')], capture_output=True, text=True, timeout=60)
        old = json.loads(r.stdout); shutil.rmtree(t, ignore_errors=True)
        self.assertTrue(old['installSafe'], 'the OLD tool certifies this install as safe (unsound)')
        new = compare(d, lambda t, v: [str(R6), str(t / 'v.json')])
        self.assertIn('run-node.cmd:APP_SLOTS', ' '.join(new['blocking'])); self.assertIn('shield-config.cmd:IPFS_GATEWAY', ' '.join(new['blocking']))
        self.assertFalse(new['certifiesPreservation'])
        # and the effect is real: r5 install over it changes both effective values
        node0, shield0 = cmdsim.effective('run-node.cmd', d), cmdsim.effective('run-shield.cmd', d)
        render(R5, d, 'new')
        self.assertNotEqual(node0['APP_SLOTS'], cmdsim.effective('run-node.cmd', d)['APP_SLOTS'])
        self.assertNotEqual(shield0['IPFS_GATEWAY'], cmdsim.effective('run-shield.cmd', d)['IPFS_GATEWAY'])


class RootPins(unittest.TestCase):
    def test_make_pins_output_drives_the_migration(self):
        d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-mp-')); make_pre(d)
        t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-mpt-')); (t / 'live.json').write_text(json.dumps(live_json(d)))
        r = subprocess.run(['python3', str(PKG / 'root/make-pins.py'), str(t / 'live.json'), str(t / 'pins.json')], capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stderr)
        p = json.loads((t / 'pins.json').read_text())
        self.assertEqual(p['files']['shield-config.local.cmd'], 'absent'); self.assertEqual(p['unpinned'], [])
        _, plan = migrate(d, p); self.assertEqual(plan['plan']['refused'], [])
        _, res = migrate(d, p, 'execute', plan['planSha']); self.assertEqual(res['result'], 'MIGRATED')
        self.assertEqual(guard(d), [], 'the run-node/run-shield lines are persisted (generated-file extras need explicit entries)')
        # the partial pins of the 2026-10-22 live read (no run-shield / Shield hook evidence) REFUSE
        lj = live_json(d); del lj['run-shield.cmd']; del lj['shield-config.local.cmd']; (t / 'live2.json').write_text(json.dumps(lj))
        subprocess.run(['python3', str(PKG / 'root/make-pins.py'), str(t / 'live2.json'), str(t / 'pins2.json')], capture_output=True, text=True, timeout=60)
        _, plan2 = migrate(d, json.loads((t / 'pins2.json').read_text()))
        self.assertTrue(any('not pinned' in x for x in plan2['plan']['refused']), plan2['plan']['refused'])
        shutil.rmtree(d, ignore_errors=True); shutil.rmtree(t, ignore_errors=True)


class SafetyR2(unittest.TestCase):
    """r2 write-path defects found by root's review: each would let the migration write through a link, over an existing name,
    into a reused/unsafe directory, or leave sensitive bytes readable before the ACL was set."""
    def setUp(self): self.d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-s-')); make_pre(self.d)
    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True)

    def refused(self, d, p, needle, env=None):
        _, plan = migrate(d, p, env=env)
        self.assertTrue(any(needle in x for x in plan['plan']['refused']), plan['plan']['refused'])
        _, res = migrate(d, p, 'execute', plan['planSha'], env=env); self.assertEqual(res['result'], 'REFUSED')

    def test_static_primitives_are_exclusive_and_private_at_creation(self):
        src = MIG.read_text()
        for bad in ('WriteAllBytes', '[IO.File]::Create(', 'Copy-FileAcl', 'Set-Acl', 'yyyyMMddTHHmmssZ").ToString()'):
            self.assertNotIn(bad, src, bad)
        body = src[src.index('function Open-NewPrivateFile'):src.index('function New-DirWithPrivateAcl')]
        for need in ('[IO.FileMode]::CreateNew', 'SetAccessRuleProtection($true, $false)', '[IO.FileShare]::None', '$sec)'):
            self.assertIn(need, body, need)
        self.assertIn('[guid]::NewGuid()', src)
        self.assertRegex(src, r'\$tmp = Join-Path \$root ')            # temp beside the hook (same directory/volume)

    def test_hook_symlink_refused(self):
        real = self.d / 'elsewhere.cmd'; (self.d / 'node-config.local.cmd').rename(real); (self.d / 'node-config.local.cmd').symlink_to(real)
        self.refused(self.d, pins(self.d), 'reparse point')

    def test_dangling_link_where_a_hook_is_absent_refused(self):
        (self.d / 'shield-config.local.cmd').symlink_to(self.d / 'nowhere.cmd')
        p = pins(self.d); p['files']['shield-config.local.cmd'] = 'absent'
        self.refused(self.d, p, 'reparse point')

    def test_root_through_an_ancestor_link_refused(self):
        link = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-l-')) / 'pd'; link.symlink_to(self.d)
        self.refused(link, pins(self.d), 'root directory unsafe: a reparse point')

    def test_backup_parent_link_or_unsafe_acl_refused(self):
        other = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-b-')); (self.d / 'backup').symlink_to(other)
        self.refused(self.d, pins(self.d), 'backup directory unsafe: a reparse point')
        (self.d / 'backup').unlink(); (self.d / 'backup').mkdir()
        self.refused(self.d, pins(self.d), 'backup directory unsafe', env={'MOCK_ACL_BAD': 'backup'})
        self.refused(self.d, pins(self.d), 'node-config.local.cmd unsafe', env={'MOCK_ACL_BAD': 'node-config.local.cmd'})

    def test_existing_directory_and_file_are_never_reused(self):
        (self.d / 'x').mkdir(); (self.d / 'y.cmd').write_text('keep')
        out, r = migrate(self.d, pins(self.d), 'expr', f"New-ExclusivePrivateDir '{self.d / 'x'}'")
        self.assertIn('refusing to reuse an existing directory', r)
        out, r = migrate(self.d, pins(self.d), 'expr', f"New-ExclusivePrivateFile '{self.d / 'y.cmd'}' ([byte[]](65,66))")
        self.assertTrue(r.startswith('ERROR'), r); self.assertEqual((self.d / 'y.cmd').read_text(), 'keep')

    def test_file_planted_before_the_exclusive_create_is_not_overwritten(self):
        p = pins(self.d)        # shield-config.local.cmd absent: created by the migration
        _, plan = migrate(self.d, p); self.assertEqual(plan['plan']['refused'], [])
        out, res = migrate(self.d, p, 'execute', plan['planSha'], env={'MOCK_PLANT': 'shield-config.local.cmd'})
        self.assertEqual(res['result'], 'FAILED', res); self.assertEqual((self.d / 'shield-config.local.cmd').read_text(), 'planted')
        for x in SECRETISH: self.assertNotIn(x, out)

    def test_success_leaves_no_temp_and_a_new_private_backup(self):
        _, plan, res = migrate_ok(self.d)
        self.assertEqual(list(self.d.glob('.*.migrate-*.tmp')), [])
        b = pathlib.Path(res['done']['node-config.local.cmd']['backup'])
        self.assertRegex(b.parent.name, r'^local-config-migration-\d{8}T\d{6}Z-[0-9a-f]{12}$')
        self.assertEqual(FH(b), res['done']['node-config.local.cmd']['before'])
        self.assertEqual(b.read_bytes().decode('ascii').split('\r\n')[:-1], LOCAL)
        # a second, same-second migration on a copy gets its own backup directory (no reuse, no collision)
        d2 = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-s2-')); make_pre(d2); shutil.copytree(self.d / 'backup', d2 / 'backup')
        _, _, res2 = migrate_ok(d2)
        self.assertNotEqual(pathlib.Path(res2['done']['node-config.local.cmd']['backup']).parent.name, b.parent.name)
        shutil.rmtree(d2, ignore_errors=True)


R2MIG = PKG.parent / 'config-persistence-r2/root/migrate-local-config.ps1'
SYS, ADM, USR = 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-21-2537925762-761743183-266136738-1002'


class OwnerR3(unittest.TestCase):
    """root's native finding: File.Replace keeps the destination DACL but gives it the REPLACEMENT's owner (backup keeps the old
    owner). r2 created every replacement Administrators-owned, so a SYSTEM-owned hook became Administrators-owned."""
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-o-')); make_pre(self.d)
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='cfgp-ot-'))
        self.env = {'MOCK_OWNERS': str(self.t / 'owners.json'), 'MOCK_OWNER_LOG': str(self.t / 'asked.log')}
    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True); shutil.rmtree(self.t, ignore_errors=True)
    def owners(self): return json.loads((self.t / 'owners.json').read_text()) if (self.t / 'owners.json').exists() else {}
    def asked(self): return (self.t / 'asked.log').read_text().split('\n')[:-1] if (self.t / 'asked.log').exists() else []
    def run_mig(self, extra=None, mig=None):
        env = dict(self.env, **(extra or {})); p = pins(self.d)
        _, plan = migrate(self.d, p, env=env, mig=mig); self.assertEqual(plan['plan']['refused'], [])
        out, res = migrate(self.d, p, 'execute', plan['planSha'], env=env, mig=mig); return out, res

    def test_system_owned_hook_keeps_system_owner(self):
        out, res = self.run_mig({'MOCK_EXISTING_OWNER': SYS})
        self.assertEqual(res['result'], 'MIGRATED', res)
        self.assertIn(f'.node-config.local.cmd.migrate-', ' '.join(self.asked()))
        tmp_asks = [a for a in self.asked() if a.startswith('.node-config.local.cmd.migrate-')]
        self.assertEqual([a.split()[1] for a in tmp_asks], [SYS], 'the replacement is CREATED with the hook owner')
        o = self.owners(); hook = str((self.d / 'node-config.local.cmd').resolve())
        self.assertEqual(o[hook], SYS, 'owner unchanged after the replace')
        self.assertEqual(o[str(pathlib.Path(res['done']['node-config.local.cmd']['backup']).resolve())], SYS)
        self.assertIn('shield-config.local.cmd ' + ADM, self.asked(), 'a NEW hook may be Administrators-owned')

    def test_administrators_owned_hook_keeps_administrators_owner(self):
        _, res = self.run_mig({'MOCK_EXISTING_OWNER': ADM}); self.assertEqual(res['result'], 'MIGRATED')
        self.assertEqual(self.owners()[str((self.d / 'node-config.local.cmd').resolve())], ADM)

    def test_token_cannot_assign_system_owner_fails_before_replacement(self):
        before = FH(self.d / 'node-config.local.cmd')
        out, res = self.run_mig({'MOCK_EXISTING_OWNER': SYS, 'MOCK_OWNER_REFUSE': SYS})
        self.assertEqual(res['result'], 'FAILED'); self.assertIn("hook's owner S-1-5-18 (nothing replaced)", res['error'])
        self.assertEqual(FH(self.d / 'node-config.local.cmd'), before, 'hook bytes untouched')
        self.assertEqual(list(self.d.glob('.*.migrate-*.tmp')), [], 'no replacement left')
        self.assertFalse(any((self.d / 'backup').glob('local-config-migration-*')) if (self.d / 'backup').exists() else False, 'no backup made before the owner is settled')
        for x in SECRETISH: self.assertNotIn(x, out)

    def test_owner_changed_by_replace_is_reported_failed(self):
        out, res = self.run_mig({'MOCK_EXISTING_OWNER': SYS, 'MOCK_REPLACE_OWNER': ADM})
        self.assertEqual(res['result'], 'FAILED'); self.assertIn('owner changed by the replace (S-1-5-18 -> S-1-5-32-544)', res['error'])
        b = next((self.d / 'backup').glob('local-config-migration-*/node-config.local.cmd'))
        self.assertEqual(b.read_bytes().decode('ascii').split('\r\n')[:-1], LOCAL, 'original bytes kept in the backup')

    def test_hook_owned_by_another_principal_is_not_replaced(self):
        before = FH(self.d / 'node-config.local.cmd')
        _, res = self.run_mig({'MOCK_EXISTING_OWNER': USR})
        self.assertEqual(res['result'], 'FAILED'); self.assertIn('is not SYSTEM or Administrators', res['error'])
        self.assertEqual(FH(self.d / 'node-config.local.cmd'), before); self.assertEqual(self.asked(), [])

    def test_negative_control_r2_creates_the_replacement_administrators_owned(self):
        _, res = self.run_mig({'MOCK_EXISTING_OWNER': SYS}, mig=R2MIG)
        self.assertEqual(res['result'], 'MIGRATED', 'r2 reports success')
        tmp_asks = [a.split()[1] for a in self.asked() if a.startswith('.node-config.local.cmd.migrate-')]
        self.assertEqual(tmp_asks, [ADM], 'r2 creates the replacement Administrators-owned, so ReplaceFile makes the SYSTEM-owned hook Administrators-owned')
        src = R2MIG.read_text(); self.assertNotIn('Get-OwnerSid', src); self.assertIn('$sec.SetOwner((New-Object System.Security.Principal.SecurityIdentifier $script:BA))', src)

    def test_static_owner_is_explicit_and_no_privilege_manipulation(self):
        src = MIG.read_text()
        body = src[src.index('function Open-NewPrivateFile'):src.index('function New-DirWithPrivateAcl')]
        self.assertIn('SecurityIdentifier $ownerSid', body); self.assertIn('-notcontains $ownerSid', body)
        for bad in ('AdjustTokenPrivileges', 'SeRestorePrivilege', 'SeTakeOwnershipPrivilege', 'Enable-Privilege', 'Set-Acl', 'SetAccessControl', 'Register-ScheduledTask', 'EncodedCommand'):
            self.assertNotIn(bad, src, bad)
        self.assertLess(src.index("New-ExclusivePrivateFile $tmp $script:Content[$h] $owner"), src.index('New-ExclusivePrivateDir $bak'), 'replacement (owner) before the backup')


if __name__ == '__main__':
    unittest.main(verbosity=2)
