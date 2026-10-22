"""Scenario tests of challenge-activate.ps1 under tools/challenge-mock.ps1 (Linux pwsh 7; decisions/control flow only, NOT Windows
evidence). NO_ORPHAN_STOP=1 also runs the negative control: a script copy whose StopOrphans does nothing leaves the replica port held."""
import hashlib, json, os, pathlib, re, shutil, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; A = T.parent; PWSH = os.environ['PWSH']; NODE = shutil.which('node')
SCRIPT = A / 'challenge-activate.ps1'
sha = lambda b: hashlib.sha256(b).hexdigest()
RUNNER = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'
RPC5 = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"]
EN_KEYS = ["relay", "checkers", "apps", "control", "wgBinary", "nodeBinary", "workerModule", "firewallBinary", "directories", "paid", "hostEgress", "paceMbps"]
PRIV = {"pid": 13932, "start": "2026-10-22T03:37:14.0971470Z"}; NODEP = {"cmdPid": 900, "cmdStart": "2026-10-22T03:38:00.0000000Z", "agentPid": 901, "agentStart": "2026-10-22T03:38:01.0000000Z"}
def cfg_text(rpc=RPC5, wallet=True, keys=EN_KEYS):
    en = {k: k for k in keys}
    if wallet: en["walletAdmission"] = {"file": "C:\\ProgramData\\Enclave\\network\\wallet-admission.json"}
    c = {"version": 2, "directory": "x", "runner": RUNNER, "apps": [{"deploymentId": "0x" + "11" * 32}], "chain": {"addressBook": "0xab", "rpc": rpc}, "enclaveNetwork": en}
    return json.dumps(c, indent=2) + "\n"                      # the hold cutover's format (enroll's has no final newline)
def world(cfg=None):
    r = pathlib.Path(tempfile.mkdtemp(prefix='chal-act-'))
    for d in ('network/state', 'logs', 'stage', 'challenge-replica', 'release'): (r / d).mkdir(parents=True)
    (r / 'network/privacy-config.json').write_text(cfg or cfg_text()); (r / 'network/wallet-admission.json').write_text('{"generation":"g1"}')
    (r / 'logs/network.log').write_text('04:00:00 boot\n'); (r / 'hs2-config.json').write_text('{"hs2":"parallel-txt"}')
    (r / 'release/dns.mjs').write_text('// dns'); (r / 'release/network-runtime.bundle.mjs').write_text('// rt')
    for f, src in (('node-hold-cutover.ps1', A / 'inputs/node-hold-cutover.ps1'), ('challenge-activate.ps1', SCRIPT), ('edit-privacy-config.mjs', A / 'inputs/edit-privacy-config.mjs'),
                   ('challengeReplica.json', A / 'inputs/challengeReplica.json')): shutil.copy2(src, r / 'stage' / f)
    procs = [{"pid": 900, "ppid": 1, "name": "cmd.exe", "cmd": 'cmd.exe /c "C:\\ProgramData\\Enclave\\run-node.cmd"', "start": NODEP["cmdStart"]},
             {"pid": 901, "ppid": 900, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\control\\windows\\node\\agent.mjs"', "start": NODEP["agentStart"]},
             {"pid": PRIV["pid"], "ppid": 3001, "name": "node.exe", "cmd": '"node.exe" "C:\\Program Files\\Enclave\\network\\privacy-agent.mjs" --config x', "start": PRIV["start"]}]
    (r / 'procs.json').write_text(json.dumps(procs)); return r
def params(r, run, **over):
    p = {"stage": str(r / 'stage'), "runId": run, "boundSec": 900, "runner": RUNNER, "nodeExe": "unused", "nodeSha": "unused", "testRoot": str(r), "testNode": NODE,
         "cutoverSha": sha((A / 'inputs/node-hold-cutover.ps1').read_bytes()), "editSha": sha((A / 'inputs/edit-privacy-config.mjs').read_bytes()),
         "blockSha": sha((A / 'inputs/challengeReplica.json').read_bytes()), "cfgSha": sha((r / 'network/privacy-config.json').read_bytes()), "enKeys": EN_KEYS + ["walletAdmission"],
         "privacy": PRIV, "node": NODEP, "chainRpc": RPC5, "hs2ConfigSha": sha((r / 'hs2-config.json').read_bytes()),
         "release": {"dir": str(r / 'release'), "dnsSha256": sha(b'// dns'), "runtimeBundleSha256": sha(b'// rt')},
         "declarationFile": str(r / 'challenge-replica/challenge-front.json'), "ports": {"dns": 18353, "api": 18354, "front": 18292, "tunnel": 31053},
         "challengeWaitSec": 240, "tunnelPolicy": "absent-or-sshd"}
    p.update(over); return p
def run(r, p, mode='apply', scenario='ok', script=SCRIPT):
    pf = r / 'stage' / f"params-{p['runId']}-{mode}.json"; pf.write_text(json.dumps(p))
    if script != SCRIPT: shutil.copy2(script, r / 'stage/challenge-activate.ps1')
    c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / 'challenge-mock.ps1'), '-Script', str(r / 'stage/challenge-activate.ps1'), '-Root', str(r),
                        '-ParamsFile', str(pf), '-ParamsSha', sha(pf.read_bytes()), '-Mode', mode, '-Scenario', scenario, '-Rel', str(r / 'release')], capture_output=True, text=True, timeout=240)
    j = r / 'stage' / f"challenge-{p['runId']}.jsonl"
    return ([json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []), c
final = lambda lines: next((l['final'] for l in reversed(lines) if 'final' in l), '')
cfg = lambda r: (r / 'network/privacy-config.json').read_text()
step = lambda lines, n: next((l for l in lines if l.get('step') == n), None)
listen = lambda r: (r / 'listen-state.txt').read_text().strip() if (r / 'listen-state.txt').exists() else ''
def restarts(lines): return [l for l in lines if l.get('step') == 'privacy-restart']
class Activation(unittest.TestCase):
    def setUp(self): self.r = world(); self.orig = cfg(self.r)
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def test_done_adds_only_the_block_before_walletAdmission_with_one_restart(self):
        lines, c = run(self.r, params(self.r, 'ok')); f = final(lines); self.assertTrue(f.startswith('DONE:'), (f, c.stderr[-800:]))
        new = json.loads(cfg(self.r)); en = list(new['enclaveNetwork']); self.assertEqual(en[-2:], ['challengeReplica', 'walletAdmission'])
        self.assertEqual(new['chain']['rpc'], RPC5, '5 RPCs kept'); self.assertEqual(new['enclaveNetwork']['challengeReplica'], json.loads((A / 'inputs/challengeReplica.json').read_text()))
        back = json.loads(cfg(self.r)); del back['enclaveNetwork']['challengeReplica']; self.assertEqual(json.dumps(back, indent=2) + "\n", self.orig, 'every other byte kept')
        self.assertEqual(len(restarts(lines)), 1); bk = step(lines, 'backup'); self.assertEqual(pathlib.Path(bk['backup']).read_text(), self.orig)
        self.assertNotIn('SECRET-PROOF-KEY', json.dumps(lines), 'the proof key is never journaled'); post = lines[-1]
        self.assertEqual(post['dnsOwner']['parent'], restarts(lines)[0]['newPid']); self.assertTrue(post['apiOk'] and post['nodeUnchanged'] and post['privacyUnchanged'])
        self.assertEqual([x.name for x in (self.r / 'network').iterdir() if '.nh-' in x.name], [], 'no temp left')
    def test_challenge_not_serving_is_check_and_keeps_the_core(self):
        lines, c = run(self.r, params(self.r, 'never'), scenario='challenge-never'); f = final(lines); self.assertTrue(f.startswith('CHECK:'), (f, c.stderr[-500:]))
        self.assertIn('challengeReplica', cfg(self.r)); self.assertTrue(restarts(lines)[0]['core']['enforcing']); self.assertEqual(lines[-1]['log']['challenge replica not started'], 1)
    def test_core_failure_reverts_exactly_once(self):
        lines, c = run(self.r, params(self.r, 'core'), scenario='core-fails'); f = final(lines); self.assertTrue(f.startswith('ROLLED_BACK_CORE'), (f, c.stderr[-800:]))
        self.assertEqual(cfg(self.r), self.orig, 'exact before-bytes'); rv = step(lines, 'revert'); self.assertEqual(rv['cfg'], 'restored'); self.assertTrue(rv['core']['enforcing'])
        self.assertEqual(sum(1 for l in lines if l.get('step') == 'revert'), 1)
    def test_write_failure_restores_without_a_restart(self):
        lines, c = run(self.r, params(self.r, 'wf'), scenario='write-fails'); f = final(lines); self.assertTrue(f.startswith('ROLLED_BACK_R0'), (f, c.stderr[-500:]))
        self.assertEqual(cfg(self.r), self.orig); self.assertEqual(restarts(lines), []); self.assertIn('not needed', step(lines, 'revert')['restart'])
    def test_refusals_change_nothing(self):
        cases = [('tunnel-squatter', {}, 'owned by something other than sshd'), ('port-busy', {}, 'port 18353 (dns) is already in use'), ('update-queued', {}, 'state Queued'),
                 ('ok', {'hs2ConfigSha': '0' * 64}, 'run root-hs2-parallel.py --execute first'), ('ok', {'cfgSha': '0' * 64}, 'not the pinned sha'),
                 ('ok', {'privacy': {'pid': 1, 'start': 'x'}}, 'privacy agent is not the pinned'), ('ok', {'tunnelPolicy': 'sshd-required'}, 'require the tunnel'),
                 ('ok', {'release': {'dir': 'x', 'dnsSha256': '0', 'runtimeBundleSha256': '0'}}, 'installed replica release'), ('ok', {'enKeys': EN_KEYS}, 'keys differ')]
        for sc, over, why in cases:
            r = world()
            try:
                p = params(r, 'ref-' + sc, **over)
                if over.get('release'): p['release']['dir'] = str(r / 'release')
                lines, c = run(r, p, scenario=sc); f = final(lines)
                self.assertTrue(f.startswith('REFUSED') and why in f, (sc, over, f, c.stderr[-300:])); self.assertEqual(cfg(r), cfg_text()); self.assertEqual(restarts(lines), [])
            finally: shutil.rmtree(r, ignore_errors=True)
        for name, text, why in (('3 RPCs', cfg_text(rpc=RPC5[:1] + RPC5[3:]), 'not the 5 pinned'), ('no hold', cfg_text(wallet=False), 'no walletAdmission')):
            r = world(text)
            try: lines, c = run(r, params(r, 'ref-x')); self.assertIn(why, final(lines), name); self.assertEqual(cfg(r), text)
            finally: shutil.rmtree(r, ignore_errors=True)
    def test_sshd_tunnel_is_accepted_and_recorded(self):
        lines, c = run(self.r, params(self.r, 'ssh'), scenario='tunnel-sshd'); self.assertTrue(final(lines).startswith('DONE:'), final(lines))
        self.assertEqual(step(lines, 'pins')['tunnel']['name'], 'sshd.exe')
    def test_render_refuses_a_non_enroll_format(self):
        r = world(json.dumps(json.loads(cfg_text())))                 # compact JSON: no writer of this file produces it
        try: lines, c = run(r, params(r, 'fmt')); self.assertTrue(final(lines).startswith('REFUSED: the challengeReplica render failed'), final(lines)); self.assertEqual(restarts(lines), [])
        finally: shutil.rmtree(r, ignore_errors=True)
    def rollback_after_done(self, script=SCRIPT):
        lines, c = run(self.r, params(self.r, 'rb')); self.assertTrue(final(lines).startswith('DONE:'), final(lines))
        rs = restarts(lines)[0]; bk = step(lines, 'backup'); cf = step(lines, 'config')
        procs = json.loads((self.r / 'procs.json').read_text()); procs[2] = dict(procs[2], pid=rs['newPid'], start=rs['newStart']); (self.r / 'procs.json').write_text(json.dumps(procs))
        p = params(self.r, 'rb2', privacy={'pid': rs['newPid'], 'start': rs['newStart']}, before={'cfg': {'before': sha(self.orig.encode()), 'after': cf['after'], 'backup': bk['backup']}})
        return run(self.r, p, mode='rollback', scenario='prior-orphan', script=script)
    def test_explicit_rollback_restores_bytes_and_stops_the_orphaned_replica(self):
        l2, c2 = self.rollback_after_done(); f = final(l2); self.assertTrue(f.startswith('ROLLED_BACK:'), (f, c2.stderr[-800:]))
        self.assertEqual(cfg(self.r), self.orig); rv = step(l2, 'revert'); self.assertEqual(len(rv['orphansStopped']), 1, 'exactly the old agent\'s replica child')
        self.assertNotIn('18353', listen(self.r)); self.assertEqual(rv['challengeLogSinceRestart']['challenge replica serving:'], 0)
    def test_negative_control_without_orphan_stop_the_port_stays_held(self):
        if not os.environ.get('NO_ORPHAN_STOP'): self.skipTest('NO_ORPHAN_STOP not set')
        t = SCRIPT.read_text(); t2, n = re.subn(r"function StopOrphans\(\$oldAgentPid\) \{.*?return ,\$done \}", "function StopOrphans($oldAgentPid) { return ,@() }", t, count=1, flags=re.S)
        assert n == 1; neg = self.r / 'no-orphan-stop.ps1'; neg.write_text(t2)
        l2, c2 = self.rollback_after_done(script=neg); f = final(l2)
        print('\nNEGATIVE (no orphan stop):', f[:110], '| listeners:', listen(self.r))
        self.assertTrue(f.startswith('ROLLED_BACK_CHECK'), f); self.assertIn('18353', listen(self.r))
if __name__ == '__main__': unittest.main()
