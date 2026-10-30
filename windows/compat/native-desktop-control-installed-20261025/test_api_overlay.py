#!/usr/bin/env python3
"""Public-file fixtures only. Never changes a production file or service."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('api_overlay', HERE/'api_overlay.py')
api = importlib.util.module_from_spec(spec); spec.loader.exec_module(api)


@unittest.skipUnless(os.environ.get('NATIVE_API_FIXTURES'), 'set NATIVE_API_FIXTURES to the exported public fixtures')
class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='native-api-test-')
        self.home = Path(self.tmp.name); fixtures = Path(os.environ['NATIVE_API_FIXTURES'])
        self.root = self.home/'installed'; self.payload = self.home/'payload'
        shutil.copytree(fixtures/'before', self.root)
        shutil.copytree(fixtures/'payload', self.payload)
        self.raw = (fixtures/'manifest.json').read_bytes(); self.m = json.loads(self.raw)
        self.journal = self.home/'journal'; self.calls = 0
        self.original = {str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}

    def tearDown(self): self.tmp.cleanup()

    def guard(self, root):
        self.assertEqual(root, self.root); self.calls += 1
        api.metadata(root, self.m, uid=os.getuid(), gid=os.getgid())

    def assert_original(self):
        self.assertEqual({str(p.relative_to(self.root)):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}, self.original)

    def apply(self, **kwargs):
        return api.apply(self.root, self.payload, self.raw, self.journal, guard=self.guard, **kwargs)

    def changed_policy(self, change):
        p=self.payload/api.POLICY; policy=json.loads(p.read_bytes()); change(policy)
        b=(json.dumps(policy)+'\n').encode(); p.write_bytes(b)
        for e in self.m['modified']:
            if e['path']==api.POLICY:
                e.update(afterSha256=api.tx.sha(b),afterBytes=len(b))
        self.raw=json.dumps(self.m).encode()

    def test_exact_thirteen_file_apply_and_repeated_rollback(self):
        self.assertEqual(len(api.tx.entries(self.m)),13)
        self.assertEqual(self.apply()['phase'],'applied')
        self.assertEqual(len(json.loads((self.root/api.POLICY).read_bytes())['images']),13)
        self.assertGreaterEqual(self.calls,14)
        for e in self.m['requiredUnchanged']:
            self.assertEqual((self.root/e['path']).read_bytes(),self.original[e['path']])
        for e in api.tx.entries(self.m):
            self.assertEqual((self.root/e['path']).stat().st_mode & 0o777,0o644)
        for _ in range(2):
            self.assertEqual(api.rollback(self.root,self.journal,guard=self.guard)['phase'],'rolled-back')
            self.assert_original()

    def test_partial_write_failure_restores_all_originals(self):
        count=0
        def fail(p,data):
            nonlocal count
            count+=1;api.tx.atomic_write(p,data)
            if count==11:raise OSError('injected failure after rename')
        with self.assertRaisesRegex(OSError,'injected'):
            self.apply(write=fail)
        self.assert_original()
        self.assertEqual(json.loads((self.journal/'state.json').read_text())['phase'],'rolled-back')

    def test_newer_svn_policy_applies_and_rolls_back_without_legacy_changes(self):
        self.m['nativeImage']['minimumGuestSvn']=15
        self.changed_policy(lambda p:p['images'][-1].update(minimumGuestSvn=15))
        self.assertEqual(self.apply()['phase'],'applied')
        installed=json.loads((self.root/api.POLICY).read_bytes())
        original=json.loads(self.original[api.POLICY])
        self.assertEqual(installed['images'][:-1],original['images'])
        self.assertEqual(installed['images'][-1]['minimumGuestSvn'],15)
        self.assertEqual(api.rollback(self.root,self.journal,guard=self.guard)['phase'],'rolled-back')
        self.assert_original()

    def test_invalid_or_downgraded_svn_floor_refused_before_writes(self):
        for floor in [None,True,False,12,-1,15.0,'15',0x100000000]:
            with self.subTest(floor=floor):
                self.m['nativeImage']['minimumGuestSvn']=floor
                self.changed_policy(lambda p:p['images'][-1].update(minimumGuestSvn=floor))
                with self.assertRaisesRegex(ValueError,'uint32 SVN floor'):
                    self.apply()
                self.assert_original();self.assertFalse(self.journal.exists())

    def test_process_death_after_rename_can_be_restored(self):
        class ProcessDeath(BaseException): pass
        def fail(p,data):
            api.tx.atomic_write(p,data);raise ProcessDeath()
        with self.assertRaises(ProcessDeath):self.apply(write=fail)
        self.assertEqual(json.loads((self.journal/'state.json').read_text())['completed'],[])
        api.rollback(self.root,self.journal,guard=self.guard);self.assert_original()

    def test_legacy_policy_changes_refused_even_with_updated_payload_hash(self):
        self.changed_policy(lambda p:p['images'].pop(0))
        with self.assertRaisesRegex(ValueError,'existing image policy'):self.apply()
        self.assert_original();self.assertFalse(self.journal.exists())

    def test_existing_non_image_policy_changes_refused(self):
        key=next(k for k in json.loads((self.root/api.POLICY).read_bytes()) if k!='images')
        self.changed_policy(lambda p:p.__setitem__(key,'changed'))
        with self.assertRaisesRegex(ValueError,'existing policy field'):self.apply()
        self.assert_original();self.assertFalse(self.journal.exists())

    def test_extra_policy_field_refused(self):
        self.changed_policy(lambda p:p.__setitem__('unexpected',True))
        with self.assertRaisesRegex(ValueError,'exactly one new'):self.apply()
        self.assert_original()

    def test_release_and_image_must_agree(self):
        self.m['desktopRelease']['runtimeId']='a'*64
        self.changed_policy(lambda p:p.__setitem__('desktop',self.m['desktopRelease']))
        with self.assertRaisesRegex(ValueError,'native image/release mismatch'):self.apply()
        self.assert_original()

    def test_rollback_refuses_unrelated_drift_without_other_changes(self):
        self.apply();target=self.root/self.m['modified'][0]['path'];target.write_bytes(b'operator edit')
        before={str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with self.assertRaisesRegex(ValueError,'unrelated installed changes'):
            api.rollback(self.root,self.journal,guard=self.guard)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_rollback_refuses_corrupt_policy_backup(self):
        self.apply();(self.journal/'before'/api.POLICY).write_bytes(b'corrupt')
        with self.assertRaisesRegex(ValueError,'backup pin mismatch'):
            api.rollback(self.root,self.journal,guard=self.guard)
        self.assertTrue(all(e['state']=='after' for e in api.tx.inspect(self.root,self.m)))

    def test_service_restart_during_apply_leaves_journal_for_stopped_recovery(self):
        calls=0
        def restarted(root):
            nonlocal calls
            calls+=1
            if calls>=3:raise RuntimeError('service running')
            self.guard(root)
        with self.assertRaisesRegex(RuntimeError,'service running'):
            api.apply(self.root,self.payload,self.raw,self.journal,guard=restarted)
        self.assertEqual(len(json.loads((self.journal/'state.json').read_text())['completed']),1)
        api.rollback(self.root,self.journal,guard=self.guard);self.assert_original()

    def test_entrypoint_drift_prevents_first_write(self):
        (self.root/api.PREFIX/'api-relay.js').write_bytes(b'new entrypoint')
        with self.assertRaisesRegex(ValueError,'required source drift'):self.apply()
        self.assertFalse(self.journal.exists())
        self.assertEqual((self.root/api.POLICY).read_bytes(),self.original[api.POLICY])

    def test_forbidden_or_duplicate_path_refused(self):
        for group in ['modified','added','requiredUnchanged']:
            m=json.loads(self.raw);m[group][0]['path']='etc/nan-relay/private.key'
            with self.assertRaisesRegex(ValueError,'unexpected path set'):api.validate_manifest(m)
        m=json.loads(self.raw);m['modified'].append(m['modified'][0])
        with self.assertRaisesRegex(ValueError,'unexpected path set'):api.validate_manifest(m)

    def test_file_directory_modes_and_owner_drift_refused(self):
        p=self.root/api.POLICY;p.chmod(0o600)
        with self.assertRaisesRegex(ValueError,'file metadata drift'):self.apply()
        self.assertFalse(self.journal.exists());p.chmod(0o644)
        d=self.root/'etc/nan-relay';d.chmod(0o777)
        with self.assertRaisesRegex(ValueError,'directory metadata drift'):self.apply()
        self.assertFalse(self.journal.exists());d.chmod(0o755)
        with self.assertRaisesRegex(ValueError,'metadata drift'):
            api.metadata(self.root,self.m,uid=os.getuid()+1,gid=os.getgid())

    def test_symlinked_policy_directory_refused(self):
        directory=self.root/'etc/nan-relay';renamed=self.home/'elsewhere'
        directory.rename(renamed);directory.symlink_to(renamed,target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'linked path'):self.apply()
        self.assertFalse(self.journal.exists())

    def test_default_live_guard_refuses_fixture_root(self):
        with self.assertRaisesRegex(RuntimeError,'installed Linux filesystem'):
            api.apply(self.root,self.payload,self.raw,self.journal)
        self.assertFalse(self.journal.exists());self.assert_original()

    def test_running_service_guard_only_issues_systemctl_show(self):
        output='LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=73131\nKillMode=control-group\nUser=enclave-api-relay\nGroup=enclave-api-relay\n'
        with patch.object(api.os,'geteuid',return_value=0),patch.object(api.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output,'')) as run:
            with self.assertRaisesRegex(RuntimeError,'service must be stopped'):api.stopped(Path('/'),self.m)
            self.assertEqual(run.call_count,1)
            self.assertEqual(run.call_args.args[0][:3],['systemctl','show','enclave-api-relay'])

    def test_inactive_service_still_requires_expected_unit_and_metadata(self):
        output='LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nKillMode=control-group\nUser=enclave-api-relay\nGroup=enclave-api-relay\n'
        with patch.object(api.os,'geteuid',return_value=0),patch.object(api.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output,'')),patch.object(api,'metadata') as metadata:
            api.stopped(Path('/'),self.m);metadata.assert_called_once_with(Path('/'),self.m)
        for old,new in [('MainPID=0','MainPID=73131'),('KillMode=control-group','KillMode=process'),('Group=enclave-api-relay','Group=root')]:
            with patch.object(api.os,'geteuid',return_value=0),patch.object(api.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output.replace(old,new),'')):
                with self.assertRaisesRegex(RuntimeError,'service must be stopped'):api.stopped(Path('/'),self.m)


if __name__=='__main__':unittest.main(verbosity=2)
