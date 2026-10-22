#!/usr/bin/env python3
"""test_policy_regeneration.py - LOCAL ONLY (pwsh 7.4 on Linux + test/cmdsim.py's cmd.exe model; NOT native Windows, NOT Windows
PowerShell 5.1). DUMMY data only (*.invalid hosts, 0x1111.. addresses, C:\\dummy paths); no live value is known or used.

The focused launcher-regeneration check for the MERGED installer src/install-host.r6p.ps1 (r6 ed729c84 + 4760aae5):
  PRE      the r3 fixture's way (test_persistence.render over the REAL r5 template text), shaped like root's live names read:
           run-node.cmd carries BASE_RPCS (already persisted verbatim) + the SIX previously unpersisted settings inside its loop;
           node-config.local.cmd carries the live hook's names (respawn ids, audit, quoted NODE_APP_RAM_GB, APP_SLOTS, BASE_RPCS,
           the wallet hold flag); run-shield.cmd has no set line (as live).
  MIGRATE  the unchanged r3 migrate-local-config.ps1 (d2ae8f69) through the reviewed r3 mocks (plan -> execute with its planSha).
  RC       the carrier coordinator's OWN statements (ref/node-policy-activation.86b96c94.ps1: $POLICY_RX, $HOLD_RX, the RC
           $POLICY_LINES construction, PolicyNamed, and the byte-level $sep/$add/$prepared append), extracted by exact text and run
           in pwsh with option RC. Only its two public constants are swapped for dummies of the SAME form ($GATE_RPC4 -> four
           https://*.invalid URLs; $CARRIERS -> a JSON importDir under C:/dummy). The write primitive (CasWrite) is not under test.
  REGEN    the MERGED installer's real launcher/config statements rendered over the same directory with a NEW manifest.
  Check    cmdsim's effective environment of run-node.cmd / run-shield.cmd."""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tempfile, unittest
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent
sys.path.insert(0, str(HERE)); import cmdsim, test_persistence as tp
MERGED, R6 = PKG / 'src/install-host.r6p.ps1', PKG / 'ref/install-host.r6.ps1'
HELPER = PKG / 'ref/node-policy-activation.86b96c94.ps1'
assert tp.R6 == MERGED, 'the copied r3 harness must point at the merged file'
assert hashlib.sha256(HELPER.read_bytes()).hexdigest() == '86b96c94648a0b00f5d36f4765b7d667da1405271a6c4d78c1d25d0723b7083e'

SIX = ['IPFS_GATEWAYS', 'ENCLAVE_CONTRACT_PINS_FILE', 'ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN', 'ENCLAVE_HOST_CATALOG_PIN', 'ENCLAVE_HOST_POLICY_DIR']
RC3 = ['ENCLAVE_PLATFORM_HOST_POLICY', 'ENCLAVE_PLATFORM_HOST_POLICY_RPCS', 'ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS']
BASE_RPCS_LINE = 'set "BASE_RPCS=https://rpc-a.invalid,https://rpc-b.invalid,https://rpc-c.invalid"'
RUN_NODE_SET = [BASE_RPCS_LINE,
                'set IPFS_GATEWAYS=https://gw-a.invalid,https://gw-b.invalid',
                'set ENCLAVE_CONTRACT_PINS_FILE=C:\\dummy\\node\\contract-pins.json',
                'set "ENCLAVE_HOST_OWNERSHIP=0x1111111111111111111111111111111111111111"',
                'set ENCLAVE_HOST_REGISTRY_PIN=0x2222222222222222222222222222222222222222',
                'set "ENCLAVE_HOST_CATALOG_PIN=0x3333333333333333333333333333333333333333"',
                'set ENCLAVE_HOST_POLICY_DIR=C:\\dummy\\node\\host-policy']
LOCAL = ['@echo off', "rem This box's own node settings, read after node-config.cmd. Updates never write this file.",
         'set ENCLAVE_ISOLATION_RESPAWN_IDS=dummy-app-a,dummy-app-b', 'set ENCLAVE_AUDIT_APPREFS=dummy-ref', 'set ENCLAVE_AUDIT_MIN_RATE=7',
         'set "NODE_APP_RAM_GB=48"', 'set APP_SLOTS=4', BASE_RPCS_LINE, 'set ENCLAVE_NETWORK_WALLET_HOLD=1']
LOCAL_NAMES = ['ENCLAVE_ISOLATION_RESPAWN_IDS', 'ENCLAVE_AUDIT_APPREFS', 'ENCLAVE_AUDIT_MIN_RATE', 'NODE_APP_RAM_GB', 'APP_SLOTS', 'BASE_RPCS', 'ENCLAVE_NETWORK_WALLET_HOLD']
DUMMY_RPC4 = ['https://gate-1.invalid', 'https://gate-2.invalid', 'https://gate-3.invalid', 'https://gate-4.invalid']
DUMMY_CARRIERS = '{"importDir":"C:/dummy/node/policy-import"}'
WANT_RC = {'ENCLAVE_PLATFORM_HOST_POLICY': 'production', 'ENCLAVE_PLATFORM_HOST_POLICY_RPCS': ','.join(DUMMY_RPC4),
           'ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS': DUMMY_CARRIERS}


def helper_statements():
    """the coordinator's own text for the RC lines, the refusal regexes and the append (each statement must match exactly once)"""
    lines = HELPER.read_text().split('\n')
    def one(prefix):
        hit = [l for l in lines if l.startswith(prefix)]
        assert len(hit) == 1, (prefix, len(hit)); return hit[0]
    i = lines.index(one('$POLICY_LINES = '))
    rpc4 = one('$GATE_RPC4 = @('); car = one("$CARRIERS = '")
    assert rpc4 == "$GATE_RPC4 = @('https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base-rpc.polkachu.com', 'https://base.drpc.org')"
    assert car == "$CARRIERS = '{\"importDir\":\"C:/ProgramData/Enclave/node/policy-import\"}'"
    return '\n'.join([
        one('$HOLD_RX = '), one('$POLICY_RX = '),
        '$GATE_RPC4 = @(' + ', '.join(f"'{u}'" for u in DUMMY_RPC4) + ')',              # dummy, same form
        "$CARRIERS = '" + DUMMY_CARRIERS + "'",                                           # dummy, same form
        one('$CARRIER_LINE = '), one('$BASE_OPTION = '), lines[i], lines[i + 1],
        one("if ($OPTION -in 'PC', 'RC' -and $POLICY_LINES.Count)"), one('function PolicyNamed($p)'),
        one('  $sep = $(if ($lb.Length -eq 0').strip(), one('  $add = [Text.Encoding]::ASCII.GetBytes($sep').strip(),
        one('  $prepared = New-Object byte[]').strip()])


RC_DRIVER = r'''
param([string]$PD, [string]$Mode)
$ErrorActionPreference = 'Stop'
$OPTION = 'RC'; $LOCAL = Join-Path $PD 'node-config.local.cmd'; $NODECFG = Join-Path $PD 'node-config.cmd'; $RUNNODE = Join-Path $PD 'run-node.cmd'
$lb = [IO.File]::ReadAllBytes($LOCAL)
Invoke-Expression ([IO.File]::ReadAllText($env:RC_TEXT))
$o = [ordered]@{ lines = @($POLICY_LINES); holdFlags = [regex]::Matches([IO.File]::ReadAllText($LOCAL), $HOLD_RX).Count
                 policyNamed = [ordered]@{ local = (PolicyNamed $LOCAL); nodeConfig = (PolicyNamed $NODECFG); runNode = (PolicyNamed $RUNNODE) } }
# the coordinator's activate precondition (line 671): any of the three already assigning ENCLAVE_PLATFORM_HOST_POLICY* -> refused
$o.refused = @(foreach ($k in 'local', 'nodeConfig', 'runNode') { if ($o.policyNamed[$k] -ne 0) { $k } })
if ($Mode -eq 'append') { [IO.File]::WriteAllBytes($LOCAL, $prepared); $o.appended = $add.Length }
$o | ConvertTo-Json -Compress
'''


def rc(d, mode):
    t = pathlib.Path(tempfile.mkdtemp(prefix='ipc-rc-')); (t / 'rc.ps1').write_text(RC_DRIVER); (t / 'rc.txt').write_text(helper_statements())
    r = subprocess.run([tp.PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'rc.ps1'), '-PD', str(d), '-Mode', mode],
                       capture_output=True, text=True, timeout=60, env=dict(os.environ, RC_TEXT=str(t / 'rc.txt')))
    shutil.rmtree(t, ignore_errors=True)
    if r.returncode: raise RuntimeError(r.stderr[-1500:])
    return json.loads(r.stdout)


def make_pre(d):
    tp.wlines(d / 'node-config.local.cmd', LOCAL)
    tp.render(tp.R5, d, 'old')
    rn = tp.rlines(d / 'run-node.cmd'); i = rn.index(':loop') + 1; tp.wlines(d / 'run-node.cmd', rn[:i] + RUN_NODE_SET + rn[i:])


def migrate(d):
    p = tp.pins(d, extra=False)
    _, plan = tp.migrate(d, p); assert plan['plan']['refused'] == [], plan['plan']['refused']
    _, res = tp.migrate(d, p, 'execute', plan['planSha']); assert res['result'] == 'MIGRATED', res
    return plan


def env(d):
    return cmdsim.effective('run-node.cmd', d), cmdsim.effective('run-shield.cmd', d)


class PolicyRegeneration(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='ipc-')); make_pre(self.d); self.node0, self.shield0 = env(self.d)

    def tearDown(self): shutil.rmtree(self.d, ignore_errors=True)

    def test_pre_fixture_is_the_live_shape(self):
        for n in SIX + LOCAL_NAMES: self.assertIn(n, self.node0, n)
        for n in RC3: self.assertNotIn(n, self.node0, 'before RC the gate is unset (OFF)')
        self.assertEqual(set(tp.guard(self.d, MERGED)), {f'run-node.cmd:{n}' for n in SIX}, 'the merged guard blocks exactly the six')

    def test_migrate_then_rc_then_merged_regeneration_keeps_six_and_rc_three(self):
        plan = migrate(self.d)
        self.assertEqual([a['name'] for a in plan['plan']['hooks']['node-config.local.cmd']['append']], SIX)
        self.assertEqual(tp.guard(self.d, MERGED), [], 'after migration the merged guard passes')
        pre = rc(self.d, 'check')
        self.assertEqual(pre['refused'], [], 'RC precondition holds on the pre-merge launchers'); self.assertEqual(pre['holdFlags'], 1)
        local_mig = (self.d / 'node-config.local.cmd').read_bytes()
        a = rc(self.d, 'append')
        self.assertEqual(a['lines'], ['set ENCLAVE_PLATFORM_HOST_POLICY=production', 'set "ENCLAVE_PLATFORM_HOST_POLICY_RPCS=' + ','.join(DUMMY_RPC4) + '"',
                                      'set "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=' + DUMMY_CARRIERS + '"'])
        self.assertEqual((self.d / 'node-config.local.cmd').read_bytes(), local_mig + ''.join(l + '\r\n' for l in a['lines']).encode('ascii'), 'byte append only')
        self.assertEqual(tp.guard(self.d, MERGED), [], 'RC lines live in the hook: the guard still passes')
        tp.render(MERGED, self.d, 'new')                               # REGENERATION by the merged installer
        node, shield = env(self.d)
        self.assertEqual(tp.lost(self.node0, node, SIX + LOCAL_NAMES), {}, 'six + every live local name effective, same values')
        self.assertEqual({n: node.get(n) for n in RC3}, WANT_RC, 'the three RC settings effective')
        self.assertEqual(node['ENCLAVE_NETWORK_WALLET_HOLD'], '1'); self.assertEqual(node['NODE_APP_RAM_GB'], '48'); self.assertEqual(shield['NODE_APP_RAM_GB'], '48')
        self.assertEqual(node['ENCLAVE_HOST_OWNERSHIP'], '0x1111111111111111111111111111111111111111')
        self.assertEqual(shield['ENCLAVE_GUEST_IGVM_SHA256'], tp.H('newguest/runtime.bin'), 'generated defaults follow the new release')
        nc = tp.rlines(self.d / 'node-config.cmd'); pol = [k for k, l in enumerate(nc) if 'ENCLAVE_PLATFORM_HOST_POLICY' in l and l.startswith('set ')]
        self.assertEqual([nc[k] for k in pol], ['set ENCLAVE_PLATFORM_HOST_POLICY=production'])
        self.assertEqual(nc[-1], 'if exist "C:\\ProgramData\\Enclave\\node-config.local.cmd" call "C:\\ProgramData\\Enclave\\node-config.local.cmd"')
        self.assertLess(pol[0], len(nc) - 1, 'generated policy line precedes the hook call: the hook has the last word')
        for f in ('run-node.cmd', 'run-shield.cmd'): self.assertEqual(tp.reader(self.d, f), [], f'{f} regenerated without set lines')
        self.assertEqual(tp.guard(self.d, MERGED), [], 'a following update is not refused')
        # a SECOND update (same merged installer, another manifest) keeps everything
        tp.render(MERGED, self.d, 'newer'); node2, _ = env(self.d)
        self.assertEqual(tp.lost(self.node0, node2, SIX + LOCAL_NAMES), {}); self.assertEqual({n: node2.get(n) for n in RC3}, WANT_RC)
        # the migration has nothing left to move
        _, plan2 = tp.migrate(self.d, tp.pins(self.d, extra=False))
        self.assertEqual(plan2['plan']['refused'], []); self.assertTrue(all(x['before'] == x['after'] for x in plan2['plan']['hooks'].values()))

    def test_control_without_migration_merged_loses_the_six(self):
        tp.render(MERGED, self.d, 'new'); node, _ = env(self.d)   # what the guard prevents
        self.assertEqual(tp.lost(self.node0, node, SIX), {n: 'LOST' for n in SIX})
        self.assertEqual(node['ENCLAVE_PLATFORM_HOST_POLICY'], 'production')
        for n in RC3[1:]: self.assertNotIn(n, node)

    def test_control_r6_alone_leaves_the_gate_off_merged_alone_sets_production_only(self):
        migrate(self.d)
        tp.render(R6, self.d, 'new'); node, _ = env(self.d)
        self.assertEqual(tp.lost(self.node0, node, SIX), {}); self.assertNotIn('ENCLAVE_PLATFORM_HOST_POLICY', node, 'r6 without RC: OFF (book:null)')
        tp.render(MERGED, self.d, 'new'); node, _ = env(self.d)
        self.assertEqual(node['ENCLAVE_PLATFORM_HOST_POLICY'], 'production', 'merged without RC: ON via the generated line')
        for n in RC3[1:]: self.assertNotIn(n, node, 'no RPC quorum override / carriers without RC')

    def test_interaction_rc_after_merged_install_is_refused_by_its_precondition(self):
        migrate(self.d); tp.render(MERGED, self.d, 'new')
        c = rc(self.d, 'check')
        self.assertEqual(c['policyNamed'], {'local': 0, 'nodeConfig': 1, 'runNode': 0})
        self.assertEqual(c['refused'], ['nodeConfig'], 'ORDER: RC must be appended BEFORE the merged installer regenerates node-config.cmd')

    def test_interaction_rc_rollback_after_merged_install_leaves_the_gate_on(self):
        migrate(self.d); local_mig = (self.d / 'node-config.local.cmd').read_bytes()
        rc(self.d, 'append'); tp.render(MERGED, self.d, 'new')
        (self.d / 'node-config.local.cmd').write_bytes(local_mig)      # what RC's rollback restores (the journaled before bytes)
        node, _ = env(self.d)
        self.assertEqual(node['ENCLAVE_PLATFORM_HOST_POLICY'], 'production', 'rollback no longer turns the gate OFF')
        for n in RC3[1:]: self.assertNotIn(n, node, 'the RC RPC quorum and carriers are gone (only the generated production line remains)')
        self.assertEqual(tp.lost(self.node0, node, SIX + LOCAL_NAMES), {}, 'the migrated six survive the RC rollback')


if __name__ == '__main__':
    unittest.main()
