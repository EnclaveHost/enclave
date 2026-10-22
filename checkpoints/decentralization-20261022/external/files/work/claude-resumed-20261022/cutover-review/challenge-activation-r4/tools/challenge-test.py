"""r3 scenario tests of challenge-activate.ps1 under tools/challenge-mock.ps1 (Linux pwsh 7; control flow only, NOT Windows evidence).
Each root finding R1-R5 has (a) the current behaviour and (b) an OLD NEGATIVE: the frozen r1 script (../challenge-activation, a0bc41af) run in
the same scenario, asserting the defect root described actually happens there. r3 adds root's r2 review (R2 incomplete): the frozen r2
script (../challenge-activation-r2, f096aed4) PASSES a wrong appRef binding, an expired grant, a future status and a channel that is no
longer current (fresh/applied/error/generation) where r3 refuses."""
import hashlib, json, os, pathlib, shutil, subprocess, tempfile, unittest
T = pathlib.Path(__file__).resolve().parent; A = T.parent; PWSH = os.environ['PWSH']; NODE = shutil.which('node')
SCRIPT = A / 'challenge-activate.ps1'; R1 = A.parent / 'challenge-activation/challenge-activate.ps1'; R2S = A.parent / 'challenge-activation-r2/challenge-activate.ps1'
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(R1.read_bytes()) == 'a0bc41afa969edb0af3f00474bbed3121e3cde6f09fb8ed2aa77f0a0d39e7946', 'the r1 negative control must be the frozen r1 bytes'
assert sha(R2S.read_bytes()) == 'f096aed4998c2e762f2c0a8e7919c4d9e97e7cce43e610ed0099b5e93dad39fc', 'the r2 negative control must be the frozen r2 bytes'
RUNNER = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'
RPC5 = ["https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co", "https://base-public.nodies.app", "https://base.drpc.org", "https://mainnet.base.org"]
EN_KEYS = ["relay", "checkers", "apps", "control", "wgBinary", "nodeBinary", "workerModule", "firewallBinary", "directories", "paid", "hostEgress", "paceMbps"]
IDS = ['0x' + c * 64 for c in '123456789']
PRIV = {"pid": 13932, "start": "2026-10-22T03:37:14.0971470Z"}; NODEP = {"cmdPid": 900, "cmdStart": "2026-10-22T03:38:00.0000000Z", "agentPid": 901, "agentStart": "2026-10-22T03:38:01.0000000Z"}
def cfg_text(r, rpc=RPC5, wallet=True):   # every expected id has its own expectation file (appRef + configCid), as network-enroll writes them
    en = {k: k for k in EN_KEYS}
    if wallet: en["walletAdmission"] = {"file": "C:\\ProgramData\\Enclave\\network\\wallet-admission.json"}
    apps = [{"deploymentId": i, "expectedFile": str(r / 'network/expect' / (i[:10] + '.json'))} for i in IDS]
    return json.dumps({"version": 2, "directory": "x", "runner": RUNNER, "apps": apps, "chain": {"addressBook": "0xab", "rpc": rpc}, "enclaveNetwork": en}, indent=2) + "\n"
def world(cfg=None):
    r = pathlib.Path(tempfile.mkdtemp(prefix='chal-r2-'))
    for d in ('network/state', 'network/expect', 'logs', 'stage', 'challenge-replica', 'release'): (r / d).mkdir(parents=True)
    for i in IDS: (r / 'network/expect' / (i[:10] + '.json')).write_text(json.dumps({"appRef": 'app-' + i[2], "configCid": 'bafy-' + i[2], "deploymentId": i}))
    (r / 'network/privacy-config.json').write_text(cfg or cfg_text(r)); (r / 'network/wallet-admission.json').write_text('{"generation":"g1"}')
    (r / 'logs/network.log').write_text('04:00:00 boot\n'); (r / 'hs2-config.json').write_text('{"hs2":"parallel-txt"}'); (r / 'expected-ids.json').write_text(json.dumps(IDS))
    (r / 'release/dns.mjs').write_text('// dns'); (r / 'release/network-runtime.bundle.mjs').write_text('// rt')
    for f, src in (('node-hold-cutover.ps1', A / 'inputs/node-hold-cutover.ps1'), ('edit-privacy-config.mjs', A / 'inputs/edit-privacy-config.mjs'), ('challengeReplica.json', A / 'inputs/challengeReplica.json')):
        shutil.copy2(src, r / 'stage' / f)
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
         "challengeWaitSec": 240, "expectedIds": IDS, "forwardSec": 330, "recoverySec": 450, "tunnel": {"mode": "absent-permitted"},
         "tunnelPolicy": "absent-or-sshd"}          # (r1 schema key: lets the OLD NEGATIVE run the same params)
    p.update(over); return p
def run(r, p, mode='apply', scenario='ok', script=SCRIPT):
    shutil.copy2(script, r / 'stage/challenge-activate.ps1')
    pf = r / 'stage' / f"params-{p['runId']}-{mode}.json"; pf.write_text(json.dumps(p))
    c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / 'challenge-mock.ps1'), '-Script', str(r / 'stage/challenge-activate.ps1'), '-Root', str(r),
                        '-ParamsFile', str(pf), '-ParamsSha', sha(pf.read_bytes()), '-Mode', mode, '-Scenario', scenario, '-Rel', str(r / 'release')], capture_output=True, text=True, timeout=300)
    j = r / 'stage' / f"challenge-{p['runId']}.jsonl"
    return ([json.loads(l) for l in j.read_text().splitlines()] if j.exists() else []), c
final = lambda lines: next((l['final'] for l in reversed(lines) if 'final' in l), '')
cfg = lambda r: (r / 'network/privacy-config.json').read_text()
step = lambda lines, n: next((l for l in lines if l.get('step') == n), None)
listen = lambda r: (r / 'listen-state.txt').read_text().strip() if (r / 'listen-state.txt').exists() else ''
restarts = lambda lines: [l for l in lines if l.get('step') == 'privacy-restart']
class Base(unittest.TestCase):
    def setUp(self): self.r = world(); self.orig = cfg(self.r)
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def other(self, scenario, script, **over):
        r = world()
        self.other_orig = cfg(r)              # that world's own original bytes (its expectation paths differ)
        try: lines, c = run(r, params(r, 'neg-' + scenario, **over), scenario=scenario, script=script); return lines, c, cfg(r), listen(r)
        finally: shutil.rmtree(r, ignore_errors=True)
class Activation(Base):
    def test_done_with_exact_ids_and_one_restart(self):
        lines, c = run(self.r, params(self.r, 'ok')); f = final(lines); self.assertTrue(f.startswith('DONE:'), (f, c.stderr[-800:]))
        for at in (step(lines, 'pins')['ids'], restarts(lines)[0]['core']['ids'], lines[-1]['ids']):     # the normal 9 pass the whole verdict
            self.assertTrue(at['ok']); self.assertEqual((at['channelBad'], at['idsBad'], at['egressMissing'], at['egressExtra']), ([], [], [], []))
        self.assertEqual(len(IDS), 9); self.assertNotIn('bafy-', json.dumps(lines))
        self.assertEqual(len(restarts(lines)), 1); self.assertTrue(restarts(lines)[0]['core']['ids']['ok']); self.assertTrue(lines[-1]['ids']['ok'] and lines[-1]['tunnelUnchanged'])
        new = json.loads(cfg(self.r)); self.assertEqual(list(new['enclaveNetwork'])[-2:], ['challengeReplica', 'walletAdmission']); self.assertEqual(new['chain']['rpc'], RPC5)
        self.assertNotIn('SECRET-PROOF-KEY', json.dumps(lines))
    def test_r1_foreign_change_at_write_survives_byte_identical(self):
        lines, c = run(self.r, params(self.r, 'r1'), scenario='foreign-at-write'); f = final(lines)
        self.assertTrue(f.startswith('RECOVERY_REQUIRED'), (f, c.stderr[-500:])); self.assertEqual(cfg(self.r), self.orig + ' ', 'the foreign bytes survive exactly')
        self.assertEqual(restarts(lines), []); self.assertIn('neither its before nor its journaled after', step(lines, 'revert')['cfg'])
        nl, nc, ncfg, _ = self.other('foreign-at-write', R1)
        self.assertTrue(final(nl).startswith('ROLLED_BACK_R0'), final(nl)); self.assertEqual(ncfg, self.other_orig, 'OLD r1: the operator change was OVERWRITTEN with the old backup')
    def test_r2_one_expected_id_missing_with_the_same_count_reverts(self):
        lines, c = run(self.r, params(self.r, 'r2'), scenario='egress-wrong-ids'); f = final(lines); self.assertTrue(f.startswith('ROLLED_BACK_CORE'), (f, c.stderr[-500:]))
        ids = restarts(lines)[0]['core']['ids']; self.assertEqual(ids['egressMissing'], [IDS[0]]); self.assertEqual(len(ids['egressExtra']), 1); self.assertEqual(cfg(self.r), self.orig)
        nl, nc, ncfg, _ = self.other('egress-wrong-ids', R1); self.assertTrue(final(nl).startswith('DONE:'), 'OLD r1: 9 routes counted as success with an expected id missing')
    def test_r2_no_vacuous_or_unbound_ids(self):
        for over, why in (({'expectedIds': []}, 'vacuous'), ({'expectedIds': IDS + [IDS[0]]}, 'vacuous')):
            r = world()
            try: lines, c = run(r, params(r, 'r2v', **over)); self.assertIn(why, final(lines)); self.assertTrue(final(lines).startswith('REFUSED')); self.assertEqual(cfg(r), cfg_text(r))
            finally: shutil.rmtree(r, ignore_errors=True)
        lines, c = run(self.r, params(self.r, 'r2n'), scenario='id-not-running'); self.assertIn('not all running/granted/routed', final(lines)); self.assertEqual(cfg(self.r), self.orig)
    def test_r2b_binding_expired_grant_future_status_refused_before_any_change(self):
        for sc, where in (('wrong-binding', ('ids', IDS[0], 'appRef')), ('expired-grant', ('ids', IDS[1], 'validUntil')), ('future-status', ('channel', 'statusAge'))):
            r = world()
            try:
                lines, c = run(r, params(r, 'r2b-' + sc), scenario=sc); f = final(lines); ids = lines[-1].get('ids') or {}
                self.assertTrue(f.startswith('REFUSED') and 'exact binding and live deadlines' in f, (sc, f, c.stderr[-500:]))
                self.assertEqual(cfg(r), cfg_text(r)); self.assertEqual(restarts(lines), []); self.assertIsNone(step(lines, 'config'))
                if where[0] == 'ids': self.assertEqual(ids['idsBad'], [{'id': where[1], 'bad': [where[2]]}], sc)
                else: self.assertEqual(ids['channelBad'], [where[1]], sc)
                self.assertNotIn('app-OTHER', json.dumps(lines)); self.assertNotIn('bafy-', json.dumps(lines))   # bindings compared on-host: booleans only
            finally: shutil.rmtree(r, ignore_errors=True)
            nl, nc, ncfg, _ = self.other(sc, R2S)
            self.assertTrue(final(nl).startswith('DONE:'), (f'OLD r2 must PASS {sc}', final(nl), nc.stderr[-300:])); self.assertIn('challengeReplica', ncfg)
    def test_r2b_post_on_a_channel_no_longer_current_is_not_done(self):
        for sc, bad in (('late-fresh', 'fresh'), ('late-applied', 'applied'), ('late-error', 'errorNull'), ('late-generation', 'generation')):
            r = world()
            try:
                lines, c = run(r, params(r, 'r2b-' + sc), scenario=sc); f = final(lines)
                self.assertTrue(f.startswith('CHECK:'), (sc, f, c.stderr[-500:])); self.assertTrue(restarts(lines)[0]['core']['ok'], 'the core passed before the channel changed')
                self.assertEqual(lines[-1]['ids']['channelBad'], [bad], sc); self.assertFalse(lines[-1]['ids']['ok'])
            finally: shutil.rmtree(r, ignore_errors=True)
            nl, nc, ncfg, _ = self.other(sc, R2S)
            self.assertTrue(final(nl).startswith('DONE:'), (f'OLD r2 must PASS {sc} at post', final(nl), nc.stderr[-300:]))
    def test_r3_budget_is_refused_before_any_change(self):
        lines, c = run(self.r, params(self.r, 'r3b', boundSec=700)); f = final(lines); self.assertTrue(f.startswith('REFUSED') and 'forward 330 + recovery 450' in f, f)
        self.assertEqual(cfg(self.r), self.orig); self.assertEqual(restarts(lines), [])
        lines, c = run(self.r, params(self.r, 'r3f', recoverySec=300)); self.assertIn('below the source-derived', final(lines))
    def test_r3_deadline_at_core_failure_keeps_the_recovery_reserve(self):
        lines, c = run(self.r, params(self.r, 'r3d', boundSec=790), scenario='core-fails'); f = final(lines); self.assertTrue(f.startswith('ROLLED_BACK_CORE'), (f, c.stderr[-500:]))
        rv = step(lines, 'revert'); self.assertGreaterEqual(rv['leftSec'], 440, 'the revert started with its reserve'); self.assertEqual(cfg(self.r), self.orig)
        self.assertEqual(len(rv['orphans']['found']), 1); self.assertTrue(rv['orphans']['gone'] and rv['ports']['free'])
        nl, nc, ncfg, _ = self.other('core-fails', R1, boundSec=240)        # OLD r1: no budget check and no reserve
        self.assertIsNotNone(step(nl, 'config'), 'OLD r1 mutated with only 240 s of bound'); rv1 = step(nl, 'revert')
        self.assertLess(240 - rv1['sec'], 30, ('OLD r1: its revert started with the budget almost exhausted', rv1['sec']))
        r = world()
        try: l3, c3 = run(r, params(r, 'r3d240', boundSec=240), scenario='core-fails'); self.assertTrue(final(l3).startswith('REFUSED') and step(l3, 'config') is None, final(l3)); self.assertEqual(cfg(r), cfg_text(r))
        finally: shutil.rmtree(r, ignore_errors=True)
    def test_r3_late_challenge_exception_does_not_revert(self):
        lines, c = run(self.r, params(self.r, 'r3c'), scenario='challenge-query-throws'); f = final(lines)
        self.assertTrue(f.startswith('CHECK: the core was verified; an exception in phase challenge'), (f, c.stderr[-500:])); self.assertEqual(len(restarts(lines)), 1)
        self.assertIn('challengeReplica', cfg(self.r)); self.assertIsNone(step(lines, 'revert'))
        nl, nc, ncfg, _ = self.other('challenge-query-throws', R1)
        self.assertTrue(final(nl).startswith('ROLLED_BACK_AFTER_CRASH'), ('OLD r1: an unbudgeted automatic revert after the core was verified', final(nl)))
    def rollback(self, scenario, script):
        lines, c = run(self.r, params(self.r, 'rb')); self.assertTrue(final(lines).startswith('DONE:'), final(lines))
        rs = restarts(lines)[0]; bk = step(lines, 'backup'); cf = step(lines, 'config')
        procs = json.loads((self.r / 'procs.json').read_text()); procs[2] = dict(procs[2], pid=rs['newPid'], start=rs['newStart']); (self.r / 'procs.json').write_text(json.dumps(procs))
        p = params(self.r, 'rb2' + scenario, privacy={'pid': rs['newPid'], 'start': rs['newStart']}, before={'cfg': {'before': sha(self.orig.encode()), 'after': cf['after'], 'backup': bk['backup']}})
        return run(self.r, p, mode='rollback', scenario=scenario, script=script)
    def test_rollback_proves_the_orphan_gone_and_ports_free(self):
        l2, c2 = self.rollback('prior-orphan', SCRIPT); f = final(l2); self.assertTrue(f.startswith('ROLLED_BACK:'), (f, c2.stderr[-500:]))
        rv = step(l2, 'revert'); self.assertEqual(len(rv['orphans']['found']), 1); self.assertTrue(rv['orphans']['gone']); self.assertTrue(rv['ports']['free']); self.assertEqual(cfg(self.r), self.orig)
    def test_r4_an_unkillable_orphan_is_never_reported_stopped(self):
        l2, c2 = self.rollback('orphan-unkillable', SCRIPT); f = final(l2)
        self.assertTrue(f.startswith('RECOVERY_REQUIRED') and 'NOT proven gone' in f, (f, c2.stderr[-500:])); rv = step(l2, 'revert'); self.assertEqual(len(rv['orphans']['alive']), 1)
        self.assertIn('Access is denied', rv['orphans']['stopErrors'][0])
    def test_r4_old_negative(self):
        l2, c2 = self.rollback('orphan-unkillable', R1); f = final(l2); rv = step(l2, 'revert')
        self.assertEqual(len(rv['orphansStopped']), 1, 'OLD r1 reports the orphan as stopped'); self.assertIn('18353', listen(self.r), 'while it still holds the DNS port')
        self.assertFalse(f.startswith('RECOVERY_REQUIRED'), f)
    def test_r5_tunnel_identity(self):
        lines, c = run(self.r, params(self.r, 'r5u', tunnel={}), scenario='ok'); self.assertIn('UNPROVEN', final(lines)); self.assertEqual(cfg(self.r), self.orig)
        pinned = {'mode': 'proven', 'pid': 4100, 'start': '2026-10-22T03:00:00.0000000Z'}
        r = world()
        try: lines, c = run(r, params(r, 'r5p', tunnel=pinned), scenario='tunnel-sshd'); self.assertTrue(final(lines).startswith('DONE:'), (final(lines), c.stderr[-400:]))
        finally: shutil.rmtree(r, ignore_errors=True)
        r = world()
        try: lines, c = run(r, params(r, 'r5i', tunnel=pinned), scenario='tunnel-impostor'); self.assertIn('not the driver-proven tunnel listener', final(lines)); self.assertEqual(cfg(r), cfg_text(r))
        finally: shutil.rmtree(r, ignore_errors=True)
        r = world()
        try: lines, c = run(r, params(r, 'r5a', tunnel={'mode': 'absent-permitted'}), scenario='tunnel-sshd'); self.assertIn('only a root-permitted ABSENCE', final(lines))
        finally: shutil.rmtree(r, ignore_errors=True)
        nl, nc, ncfg, _ = self.other('tunnel-impostor', R1); self.assertTrue(final(nl).startswith('DONE:'), 'OLD r1: any process NAMED sshd.exe was accepted on 31053')
    def test_write_failure_and_refusals_still_change_nothing(self):
        lines, c = run(self.r, params(self.r, 'wf'), scenario='write-fails'); self.assertTrue(final(lines).startswith('ROLLED_BACK_R0'), final(lines)); self.assertEqual(cfg(self.r), self.orig)
        for sc, over, why in (('port-busy', {}, 'port 18353 (dns) is already in use'), ('update-queued', {}, 'state Queued'), ('ok', {'hs2ConfigSha': '0' * 64}, 'root-hs2-parallel.py --execute first')):
            r = world()
            try: lines, c = run(r, params(r, 'ref', **over), scenario=sc); self.assertIn(why, final(lines)); self.assertEqual(cfg(r), cfg_text(r))
            finally: shutil.rmtree(r, ignore_errors=True)
if __name__ == '__main__': unittest.main()
