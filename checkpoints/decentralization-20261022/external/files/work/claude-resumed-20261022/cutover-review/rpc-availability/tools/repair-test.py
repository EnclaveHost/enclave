"""Scenario tests of helper/run-node-rpc-repair.ps1 (and, as NEGATIVE CONTROL, the base 76b8a35e) under tools/repair-mock.ps1.
The script COPY is path-transformed for Linux: $PD -> a scratch root, PrivateDir -> plain mkdir (ACL APIs are Windows-only).
Decisions/control flow only; NOT Windows evidence."""
import hashlib, json, os, pathlib, re, shutil, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; H = T.parent / 'helper'; PWSH = os.environ['PWSH']
NEW = H / 'run-node-rpc-repair.ps1'; BASE = H / 'run-node-rpc-repair.base-76b8a35e.ps1'
L5 = 'set "BASE_RPCS=https://base-rpc.publicnode.com,https://base.gateway.tenderly.co,https://base-public.nodies.app,https://base.drpc.org,https://mainnet.base.org"'
L12 = 'set "BASE_RPCS=https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org"'
LINES = ['@echo off', r'call C:\ProgramData\Enclave\node-config.cmd', r'cd /d "C:\Program Files\Enclave\control"', ':loop', L5] + [f'set X{i}=1' for i in range(6)] + \
        [L12, r'"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"', 'echo exited', 'ping -n 6 127.0.0.1 >nul', 'goto loop']
OLD_B = ('\r\n'.join(LINES) + '\r\n').encode(); NEW_B = OLD_B.replace((L12 + '\r\n').encode(), b'', 1)
sha = lambda b: hashlib.sha256(b).hexdigest()
def transform(src, root):
    t = src.read_text()
    t = t.replace("$PD = 'C:\\ProgramData\\Enclave'", f"$PD = '{root}'", 1)
    t, n = re.subn(r"function PrivateDir \{.*?Set-Acl -LiteralPath \$BAKDIR -AclObject \$acl \}", "function PrivateDir { [void][IO.Directory]::CreateDirectory($BAKDIR) }", t, count=1, flags=re.S)
    assert n == 1 and f"$PD = '{root}'" in t; d = root / ('script-' + src.name); d.write_text(t); return d
def run(src, scenario, mode='repair'):
    root = pathlib.Path(tempfile.mkdtemp(prefix='rpc-repair-')); (root / 'run-node.cmd').write_bytes(OLD_B)
    try:
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / 'repair-mock.ps1'), '-Script', str(transform(src, root)), '-Root', str(root),
                            '-Scenario', scenario, '-Mode', mode, '-OldSha', sha(OLD_B), '-NewSha', sha(NEW_B)], capture_output=True, text=True, timeout=120)
        last = [l for l in c.stdout.splitlines() if l.startswith('{')]; o = json.loads(last[-1]) if last else {}
        cnt = lambda f: (root / f).read_text().count(f[:-5]) if (root / f).exists() else 0
        return {'rc': c.returncode, 'o': o, 'decision': o.get('decision', ''), 'starts': cnt('starts.txt'), 'stops': cnt('stops.txt'),
                'runNode': sha((root / 'run-node.cmd').read_bytes()), 'stderr': c.stderr[-300:]}
    finally: shutil.rmtree(root, ignore_errors=True)
class Repair(unittest.TestCase):
    def test_sizes(self): self.assertEqual(len(OLD_B) - len(NEW_B), 96)
    def test_plan_is_read_only_and_reports_leases(self):
        r = run(NEW, 'ok', 'plan'); self.assertEqual(r['decision'], 'plan ok', r); self.assertEqual((r['starts'], r['stops'], r['runNode']), (0, 0, sha(OLD_B)))
        self.assertTrue(r['o']['lease']['ok']); self.assertEqual(r['o']['lease']['held'], 1); self.assertGreater(r['o']['lease']['minRunningSec'], 800)
    def test_ok_repairs_with_one_restart(self):
        r = run(NEW, 'ok'); self.assertTrue(r['decision'].startswith('repaired; restarted: node agent only'), r)
        self.assertEqual((r['starts'], r['stops'], r['runNode']), (1, 1, sha(NEW_B)))
    def test_agent_exit_race_is_tolerated(self):
        r = run(NEW, 'agent-exits-before-kill'); self.assertTrue(r['decision'].startswith('repaired'), r); self.assertEqual(r['starts'], 1); self.assertIn('agentKill', r['o'])
    def test_error_after_stop_starts_once_when_nothing_remains(self):
        r = run(NEW, 'cim-fails-after-stop'); self.assertTrue(r['decision'].startswith('RECOVERED_START'), r); self.assertEqual((r['rc'], r['starts']), (1, 1))
    def test_error_after_stop_with_agent_left_does_not_start(self):
        r = run(NEW, 'cim-fails-after-stop-agent-remains'); self.assertTrue(r['decision'].startswith('RECOVERY_REQUIRED') and 'NOT started' in r['decision'], r)
        self.assertEqual(r['starts'], 0, 'never a second agent')
    def test_failed_start_request_is_never_repeated(self):
        r = run(NEW, 'start-throws'); self.assertTrue(r['decision'].startswith('RECOVERY_REQUIRED: the Node task start request failed'), r); self.assertEqual(r['starts'], 1)
    def test_gates_refuse_before_any_stop(self):
        for sc, why in (('lease-short', 'refused: a running lease ends'), ('lease-unreadable', 'refused: the node lease state is unreadable'), ('update-due', 'Update task runs or is due')):
            r = run(NEW, sc); self.assertIn(why, r['decision'], (sc, r)); self.assertEqual((r['starts'], r['stops'], r['runNode']), (0, 0, sha(OLD_B)), sc)
class BaseNegativeControl(unittest.TestCase):
    """the unpatched 76b8a35e under the same scenarios: each assertion documents the defect the patch removes"""
    def test_base_defects(self):
        out = {}
        for sc in ('agent-exits-before-kill', 'cim-fails-after-stop', 'start-throws', 'lease-short', 'update-due'):
            r = run(BASE, sc); out[sc] = {k: r[k] for k in ('rc', 'decision', 'starts', 'stops')}
        print('\nBASE 76b8a35e:', json.dumps(out))
        for sc in ('agent-exits-before-kill', 'cim-fails-after-stop'):
            self.assertEqual((out[sc]['stops'], out[sc]['starts'], out[sc]['decision']), (1, 0, ''), f'{sc}: base leaves the node STOPPED with no JSON')
        self.assertEqual(out['start-throws']['decision'], '', 'base: no result line after a lost start reply')
        for sc in ('lease-short', 'update-due'): self.assertEqual((out[sc]['stops'], out[sc]['starts']), (1, 1), f'{sc}: base restarts despite the gate')
        r = run(BASE, 'ok'); print('BASE ok:', r['decision'][:140])
        self.assertTrue(r['decision'].startswith('restarted WITHOUT the change (swap: FAILED') and r['runNode'] == sha(OLD_B), 'base: File.Replace($null) never swaps')
if __name__ == '__main__': unittest.main()
