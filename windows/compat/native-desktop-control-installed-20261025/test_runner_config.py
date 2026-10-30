#!/usr/bin/env python3
"""Fixture-only tests; never executes the captured production runners."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('runner_config', HERE / 'runner_config.py')
rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)


@unittest.skipUnless(os.environ.get('NATIVE_RUNNER_FIXTURES'), 'set NATIVE_RUNNER_FIXTURES to the exported public fixtures')
class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='native-runner-test-')
        self.home = Path(self.tmp.name); self.root = self.home / 'installed'; self.root.mkdir()
        self.output = self.home / 'prepared'; self.journal = self.home / 'journal'
        fixtures = Path(os.environ['NATIVE_RUNNER_FIXTURES'])
        self.capture = json.loads((fixtures / 'runners.json').read_text())
        self.release = json.loads((fixtures / 'release.json').read_text())
        self.environment = (fixtures / 'native-desktop-env.cmd').read_bytes()
        self.original = {r['name']:base64.b64decode(r['bytes']) for r in self.capture['runners']}
        for name, b in self.original.items(): (self.root / name).write_bytes(b)
        # Private production base configs are never copied. Use fixture content,
        # with fixture pins, while keeping the two real public runners unchanged.
        self.base = {n:('fixture-only '+n).encode() for n in rc.BASE_CONFIGS}
        self.basepins = {'files':[]}
        for name, b in self.base.items():
            (self.root / name).write_bytes(b)
            self.basepins['files'].append(dict(path=name,sha256=rc.tx.sha(b),bytes=len(b)))
        rel = self.root / rc.release_directory(self.release); rel.mkdir(parents=True)
        for n in ['desktop-config.json','desktop-release.json','native-desktop-env.cmd']:
            shutil.copyfile(fixtures/n, rel/n)
        self.manifest = rc.prepare(self.capture,self.basepins,self.release,self.environment,self.output)
        self.raw = (self.output/'manifest.json').read_bytes(); self.payload = self.output/'payload'
        self.guardCalls = 0

    def tearDown(self): self.tmp.cleanup()
    def guard(self, root):
        self.assertEqual(root,self.root); self.guardCalls += 1
    def assert_original(self):
        for name,b in {**self.original,**self.base}.items(): self.assertEqual((self.root/name).read_bytes(),b)

    def test_real_captured_runners_preserved_except_two_line_hook(self):
        rc.validate_payload(self.payload,self.manifest)
        for name,old in self.original.items():
            data=(self.payload/name).read_bytes()
            blocks=[rc.hook(self.release,n) for n in [b'\r\n',b'\n']]
            block=next(b for b in blocks if b in data)
            self.assertEqual(data.replace(block,b'',1),old)
            self.assertEqual(data.count(b'native-desktop-env.cmd'),1)
        # The installed scripts intentionally use different line-ending styles.
        self.assertIn(b'\r\n',self.original['run-node.cmd'])
        self.assertIn(b'\ncall ',self.original['run-shield.cmd'])

    def test_apply_restore_preserves_base_configs(self):
        self.assertEqual(rc.apply(self.root,self.payload,self.raw,self.journal,guard=self.guard)['phase'],'applied')
        self.assertGreaterEqual(self.guardCalls,3)
        for name,b in self.base.items():self.assertEqual((self.root/name).read_bytes(),b)
        self.assertEqual(rc.rollback(self.root,self.journal,guard=self.guard)['phase'],'rolled-back')
        rc.rollback(self.root,self.journal,guard=self.guard)
        self.assert_original()

    def test_private_path_or_added_file_is_refused(self):
        m=json.loads(self.raw); m['modified'][0]['path']='node/operator.key'
        with self.assertRaisesRegex(ValueError,'only the two'):rc.validate_manifest(m)
        m=json.loads(self.raw);m['added']=[dict(path='node/anything',sha256='a'*64,bytes=1)]
        with self.assertRaisesRegex(ValueError,'unsupported runner'):rc.validate_manifest(m)
        self.assert_original()

    def test_unexpected_required_path_refused(self):
        m=json.loads(self.raw);m['requiredUnchanged'][0]['path']='node/operator.key'
        with self.assertRaisesRegex(ValueError,'unexpected required'):rc.validate_manifest(m)

    def test_changed_base_config_prevents_apply(self):
        (self.root/'node-config.local.cmd').write_bytes(b'new operator preference')
        with self.assertRaisesRegex(ValueError,'required source drift'):
            rc.apply(self.root,self.payload,self.raw,self.journal,guard=self.guard)
        self.assertEqual((self.root/'run-node.cmd').read_bytes(),self.original['run-node.cmd'])
        self.assertFalse(self.journal.exists())

    def test_changed_release_environment_prevents_apply(self):
        env=self.root/rc.release_directory(self.release)/'native-desktop-env.cmd';env.write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError,'required source drift'):
            rc.apply(self.root,self.payload,self.raw,self.journal,guard=self.guard)
        self.assert_original();self.assertFalse(self.journal.exists())

    def test_payload_cannot_smuggle_other_runner_changes(self):
        p=self.payload/'run-node.cmd';data=p.read_bytes().replace(b'publicnode.com',b'example.invalid');self.assertNotEqual(data,p.read_bytes());p.write_bytes(data)
        m=json.loads(self.raw);m['modified'][0].update(afterSha256=rc.tx.sha(data),afterBytes=len(data))
        with self.assertRaisesRegex(ValueError,'more than the native hook'):rc.validate_payload(self.payload,m)
        self.assert_original()

    def test_hook_cannot_move_before_base_configuration(self):
        p=self.payload/'run-node.cmd';data=p.read_bytes();block=rc.hook(self.release,b'\r\n');data=block+data.replace(block,b'',1);p.write_bytes(data)
        m=json.loads(self.raw);m['modified'][0].update(afterSha256=rc.tx.sha(data),afterBytes=len(data))
        with self.assertRaisesRegex(ValueError,'more than the native hook'):rc.validate_payload(self.payload,m)

    def test_wrong_release_path_refused(self):
        release=dict(self.release,target=r'C:\ProgramData\Other\release')
        with self.assertRaisesRegex(ValueError,'dedicated permanent'):rc.hook(release)

    def test_duplicate_hook_and_captured_drift_refused(self):
        with self.assertRaisesRegex(ValueError,'already present'):
            rc.add_hook((self.payload/'run-node.cmd').read_bytes(),'run-node.cmd',self.release)
        c=json.loads(json.dumps(self.capture));c['runners'][0]['sha256']='a'*64
        with self.assertRaisesRegex(ValueError,'captured runner hash'):
            rc.prepare(c,self.basepins,self.release,self.environment,self.home/'bad')

    def test_existing_output_not_overwritten(self):
        before=(self.output/'manifest.json').read_bytes()
        with self.assertRaisesRegex(ValueError,'output already exists'):
            rc.prepare(self.capture,self.basepins,self.release,self.environment,self.output)
        self.assertEqual((self.output/'manifest.json').read_bytes(),before)

    def test_running_service_guard_prevents_writes(self):
        def running(_):raise RuntimeError('fixture service running')
        with self.assertRaisesRegex(RuntimeError,'fixture service running'):
            rc.apply(self.root,self.payload,self.raw,self.journal,guard=running)
        self.assert_original();self.assertFalse(self.journal.exists())
        with self.assertRaises(RuntimeError):rc.stopped(self.root)

    def test_rollback_refuses_later_runner_change(self):
        rc.apply(self.root,self.payload,self.raw,self.journal,guard=self.guard)
        (self.root/'run-node.cmd').write_bytes(b'later operator change')
        with self.assertRaisesRegex(ValueError,'unrelated installed changes'):
            rc.rollback(self.root,self.journal,guard=self.guard)
        self.assertEqual((self.root/'run-node.cmd').read_bytes(),b'later operator change')
        self.assertEqual((self.root/'run-shield.cmd').read_bytes(),(self.payload/'run-shield.cmd').read_bytes())

    def run_cmd_hook(self, environment):
        # Execute only the inserted CALL/error guard in cmd.exe, targeting a
        # disposable copy of the public environment. NEVER run a real runner.
        directory=self.home/'quoted path & test';directory.mkdir()
        env=directory/'native-desktop-env.cmd'
        if environment is not None:env.write_bytes(environment)
        expected=str(rc.DATA.joinpath(*rc.release_directory(self.release).split('/'),'native-desktop-env.cmd'))
        block=rc.hook(self.release).decode('ascii').replace(expected,str(env))
        probe=directory/'probe.py';result=directory/'result.json'
        probe.write_text("import os,json,sys\nkeys=['KEEP_FIXTURE','ENCLAVE_DESKTOP_CONFIG','ENCLAVE_DESKTOP_CONFIG_SHA256','ENCLAVE_DESKTOP_RELEASE_FILE','ENCLAVE_DESKTOP_RELEASE_SHA256','NODE_VM_RAM_GB']\nopen(sys.argv[1],'w').write(json.dumps({k:os.environ.get(k) for k in keys}))\n")
        entered=directory/'entered.txt'
        cmd=directory/'test.cmd';cmd.write_bytes(('@echo off\r\n> "'+str(entered)+'" echo entered\r\nset "KEEP_FIXTURE=preserved"\r\n'+block+'"'+sys.executable+'" "'+str(probe)+'" "'+str(result)+'"\r\nexit /b %errorlevel%\r\n').encode('ascii'))
        run=subprocess.run(['cmd.exe','/d','/c','call',str(cmd)],capture_output=True,text=True,timeout=15)
        # A broken test-launch command must not count as a successful refusal.
        self.assertTrue(entered.is_file(),run.stderr)
        return run,json.loads(result.read_text()) if result.exists() else None

    @unittest.skipUnless(os.name=='nt','requires real Windows cmd.exe')
    def test_cmd_success_passes_pinned_values_and_existing_environment(self):
        run,result=self.run_cmd_hook(self.environment)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertEqual(result['KEEP_FIXTURE'],'preserved')
        self.assertEqual(result['NODE_VM_RAM_GB'],'83')
        self.assertEqual(result['ENCLAVE_DESKTOP_CONFIG_SHA256'],self.release['configurationPins']['desktop-config.json']['sha256'])
        self.assertEqual(result['ENCLAVE_DESKTOP_RELEASE_SHA256'],self.release['configurationPins']['desktop-release.json']['sha256'])
        self.assertEqual(result['ENCLAVE_DESKTOP_CONFIG'],self.release['target']+'\\desktop-config.json')
        self.assertEqual(result['ENCLAVE_DESKTOP_RELEASE_FILE'],self.release['target']+'\\desktop-release.json')

    @unittest.skipUnless(os.name=='nt','requires real Windows cmd.exe')
    def test_cmd_missing_environment_never_starts_service_probe(self):
        run,result=self.run_cmd_hook(None)
        self.assertEqual(run.returncode,1);self.assertIsNone(result)

    @unittest.skipUnless(os.name=='nt','requires real Windows cmd.exe')
    def test_cmd_failed_environment_never_starts_service_probe(self):
        run,result=self.run_cmd_hook(b'@echo off\r\nexit /b 7\r\n')
        self.assertEqual(run.returncode,1);self.assertIsNone(result)

if __name__=='__main__':unittest.main(verbosity=2)
