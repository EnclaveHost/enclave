"""rpc-integrated scenarios (Linux mock; decisions only, NOT Windows evidence): the run-node.cmd override removal and chain.rpc
inside the cutover. BASELINE=<943a helper> runs the negative-control class against the unrepaired cutover."""
import importlib.util, json, os, pathlib, shutil, stat, sys, unittest
p = pathlib.Path(__file__).with_name('cutover-mock-test.py'); spec = importlib.util.spec_from_file_location('fixture', p)
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
cfg = lambda r: json.loads((r / 'network/privacy-config.json').read_text())
runnode = lambda r: (r / 'run-node.cmd').read_bytes()
def step(lines, name): return next((l for l in lines if l.get('step') == name), None)
def editor(r, mutate):     # a node.exe wrapper that changes run-node.cmd WHILE the config is rendered (pre-stop)
    f = r / 'editor.py'
    f.write_text('#!' + sys.executable + '\nimport pathlib,subprocess,sys\nr=pathlib.Path(__file__).parent\n' + mutate +
                 '\nsys.exit(subprocess.run([' + repr(shutil.which('node')) + ']+sys.argv[1:]).returncode)\n')
    f.chmod(f.stat().st_mode | stat.S_IEXEC); return str(f)
class Repair(unittest.TestCase):
    def setUp(self): self.r = m.world()
    def tearDown(self): shutil.rmtree(self.r, ignore_errors=True)
    def test_done_repairs_launcher_and_chain_and_keeps_everything_else(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-ok')); self.assertTrue(m.final(lines).startswith('DONE:'), (m.final(lines), c.stderr[-600:]))
        self.assertEqual(runnode(r), m.RUN_NODE_NEW); after = cfg(r)
        self.assertEqual(after['chain'], {**m.CFG['chain'], 'rpc': m.RPC5}, 'chain.rpc = the 5 in order; addressBook kept')
        self.assertEqual(list(after['chain']), list(m.CFG['chain']), 'key order kept')
        exp = json.loads(json.dumps(m.CFG)); exp['chain']['rpc'] = m.RPC5; exp['enclaveNetwork']['walletAdmission'] = after['enclaveNetwork']['walletAdmission']
        self.assertEqual(after, exp, 'no other key changed'); self.assertEqual(list(after), list(m.CFG))
        bk = step(lines, 'backups'); self.assertEqual(pathlib.Path(bk['runNodeBackup']).read_bytes(), m.RUN_NODE_OLD)
        rn = step(lines, 'run-node'); self.assertTrue(rn['aclKept']); self.assertEqual(rn['after'], m.hashlib.sha256(m.RUN_NODE_NEW).hexdigest())
        post = lines[-1]; self.assertTrue(post['runNodeAsWritten'] and post['chainRpcAsWritten'] and post['privacyUnchanged'], post)
        self.assertEqual(m.temps(r) + [x.name for x in r.iterdir() if '.nh-' in x.name], [], 'no temp survives')
        text = json.dumps(lines); self.assertNotIn('ENCLAVE_SETTING_', text, 'launcher content never journaled')
    def test_explicit_rollback_restores_the_old_launcher_and_the_3(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-rb')); self.assertTrue(m.final(lines).startswith('DONE:'))
        st = json.loads((r / 'procs-state.json').read_text()); node = [x for x in st if 'node\\agent.mjs' in x['cmd']][0]; cmd = [x for x in st if x['pid'] == node['ppid']][0]
        pa = [x for x in st if 'privacy-agent' in x['cmd']][0]; (r / 'procs.json').write_text(json.dumps(st))
        bk, fl, cf, rn = step(lines, 'backups'), step(lines, 'flag'), step(lines, 'config'), step(lines, 'run-node')
        rb = m.params(r, 'rpc-rb-rb', node={'cmdPid': cmd['pid'], 'cmdStart': cmd['start'], 'agentPid': node['pid'], 'agentStart': node['start']}, privacy={'pid': pa['pid'], 'start': pa['start']},
                      before={'local': {'before': m.sha(m.LOCAL), 'after': fl['after'], 'backup': bk['localBackup']}, 'cfg': {'before': bk['cfg'], 'after': cf['after'], 'backup': bk['cfgBackup']},
                              'runNode': {'before': bk['runNode'], 'after': rn['after'], 'backup': bk['runNodeBackup']}})
        l2, c2 = m.run(r, rb, mode='rollback'); self.assertTrue(m.final(l2).startswith('ROLLED_BACK:'), (m.final(l2), c2.stderr[-500:]))
        self.assertEqual(runnode(r), m.RUN_NODE_OLD); self.assertEqual(cfg(r), m.CFG); self.assertEqual(step(l2, 'revert')['runNode'], 'restored')
    def test_r1_r2_and_crash_restore_launcher_and_config(self):
        for sc, prefix, starts in (('net-ignores-wallet', 'ROLLED_BACK_R1', 1), ('node-no-channel', 'ROLLED_BACK_R2', 2), ('crash-once', 'ROLLED_BACK_AFTER_CRASH', 1)):
            r = m.world()
            try:
                lines, c = m.run(r, m.params(r, 'rpc-' + sc), scenario=sc); self.assertTrue(m.final(lines).startswith(prefix), (sc, m.final(lines), c.stderr[-400:]))
                self.assertEqual((runnode(r), cfg(r), m.starts(r)), (m.RUN_NODE_OLD, m.CFG, starts), sc)
            finally: shutil.rmtree(r, ignore_errors=True)
    def test_a_launcher_that_does_not_have_the_override_refuses_before_the_stop(self):
        r = self.r; (r / 'run-node.cmd').write_bytes(m.RUN_NODE_NEW)          # e.g. already repaired by hand: nothing to remove
        lines, c = m.run(r, m.params(r, 'rpc-shape')); f = m.final(lines)
        self.assertTrue(f.startswith('REFUSED: the run-node.cmd RPC override removal does not apply'), f)
        self.assertTrue(m.node_running(r)); self.assertEqual((m.starts(r), m.flag(r), m.block(r), runnode(r)), (0, False, False, m.RUN_NODE_NEW))
        self.assertNotIn('stop-node', [l.get('step') for l in lines])
    def test_wrong_new_pin_refuses_before_the_stop(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-pin', runNodeNewSha='0' * 64))
        self.assertIn('is not the pinned one (96 bytes removed)', m.final(lines)); self.assertTrue(m.node_running(r)); self.assertEqual(runnode(r), m.RUN_NODE_OLD)
    def test_launcher_edited_during_preparation_refuses_before_the_stop(self):
        r = self.r; ed = editor(r, "(r/'run-node.cmd').write_bytes((r/'run-node.cmd').read_bytes()+b'rem operator\\r\\n')")
        lines, c = m.run(r, m.params(r, 'rpc-prep', testNode=ed)); self.assertTrue(m.final(lines).startswith('REFUSED: a config changed during preparation'), m.final(lines))
        self.assertTrue(m.node_running(r)); self.assertEqual((m.starts(r), m.flag(r), m.block(r)), (0, False, False))
    def test_a_config_without_chain_rpc_refuses_before_the_stop(self):
        r = self.r; c0 = dict(m.CFG); c0.pop('chain'); (r / 'network/privacy-config.json').write_text(json.dumps(c0, indent=2) + '\n')
        lines, c = m.run(r, m.params(r, 'rpc-nochain')); self.assertTrue(m.final(lines).startswith('REFUSED: config preparation failed'), m.final(lines))
        self.assertTrue(m.node_running(r)); self.assertEqual(runnode(r), m.RUN_NODE_OLD)
    def test_launcher_acl_without_ai_refuses_at_the_pins(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-acl'), scenario='runnode-acl-no-ai')
        self.assertIn('run-node.cmd has a DACL that is not auto-inherited', m.final(lines)); self.assertTrue(m.node_running(r))
    def test_launcher_write_failure_reverts_flag_and_block(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-wfail'), scenario='runnode-write-fails'); self.assertTrue(m.final(lines).startswith('ROLLED_BACK_R0'), (m.final(lines), c.stderr[-400:]))
        self.assertEqual((runnode(r), cfg(r), m.flag(r), m.starts(r)), (m.RUN_NODE_OLD, m.CFG, False, 1))
    def test_launcher_changed_by_someone_else_keeps_the_node_stopped(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-conc'), scenario='runnode-concurrent-edit'); f = m.final(lines)
        self.assertTrue(f.startswith('RECOVERY_REQUIRED'), f); self.assertIn('node launcher was not restored', lines[-1]['recovery'])
        self.assertFalse(m.flag(r), 'the flag was restored first'); self.assertTrue(m.block(r), 'the network block is KEPT'); self.assertEqual(m.starts(r), 0, 'R1 path: no forward start, and never the old config')
        self.assertFalse(m.node_running(r))
    def test_a_second_privacy_restart_is_not_reported_as_done(self):
        r = self.r; lines, c = m.run(r, m.params(r, 'rpc-p2'), scenario='privacy-restarts-after-node')
        self.assertTrue(m.final(lines).startswith('DONE_CHECK'), m.final(lines)); self.assertFalse(lines[-1]['privacyUnchanged'])
class BaseNegativeControl(unittest.TestCase):
    """the unrepaired 943a cutover under the same fixture: the launcher keeps its override and the config keeps the 3"""
    def test_base(self):
        base = os.environ.get('BASELINE')
        if not base: self.skipTest('BASELINE not set')
        r = m.world(); old = m.SCRIPT
        try:
            m.SCRIPT = pathlib.Path(base); lines, c = m.run(r, m.params(r, 'base-ok'))
            print('\nBASELINE', m.sha(m.SCRIPT.read_bytes())[:8], m.final(lines)[:60], '| run-node repaired:', runnode(r) == m.RUN_NODE_NEW, '| chain.rpc:', len(cfg(r)['chain']['rpc']))
            self.assertEqual(runnode(r), m.RUN_NODE_OLD); self.assertEqual(cfg(r)['chain']['rpc'], m.RPC3)
            self.assertNotIn('run-node', [l.get('step') for l in lines])
        finally: m.SCRIPT = old; shutil.rmtree(r, ignore_errors=True)
if __name__ == '__main__': unittest.main()
