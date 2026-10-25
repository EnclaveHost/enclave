#!/usr/bin/python3 -I
"""finalize-receipts tests. Receipts are produced by ROOT's frozen helper (nvme-copy-root-review/nvme_copy.py, pinned
sha) run on disposable qcow2 images (<= 24 MiB) in the sandbox; mount identity and unit state are mocked as in
test_nvme_migration.Env. No production path is read or written."""
import contextlib
import copy
import hashlib
import io as iomod
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_nvme_migration as base  # noqa: E402  (sets the sandbox HOME before loading the launcher)

pv, mig = base.pv, base.mig
HELPER = os.path.abspath(os.environ.get('NVME_COPY_HELPER') or
                         os.path.join(base.HERE, '..', 'nvme-copy', 'executed', 'nvme_copy.py'))


def sha(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()


class Receipts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sha(HELPER) != mig.HELPER_SHA256:
            raise AssertionError(f'{HELPER} is not the pinned root-reviewed helper {mig.HELPER_SHA256}')

    def setUp(self):
        self.root = tempfile.mkdtemp(dir=base.SANDBOX)
        self.e = e = base.Env(self.root)
        self.assertEqual(e.plan_ok()[0], 0)
        self.plan = json.load(open(e.plan))
        os.mkdir(e.tdir, 0o700)
        fake = os.path.join(self.root, 'systemctl-fake')
        with open(fake, 'w') as f:
            f.write('#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n"\n')
        os.chmod(fake, 0o755)
        self.receipts = {}
        for r in ('os', 'l1'):
            d = self.plan['disks'][r]
            hp = os.path.join(self.root, f'copy-{r}.plan.json')
            rp = os.path.join(self.root, f'copy-{r}.receipt.json')
            json.dump({'format': 'enclave-nvme-copy-plan/v1',
                       'source': {k: d['src'][k] for k in ('path', 'dev', 'ino', 'size')},
                       'target': {'dir': e.tdir, 'name': os.path.basename(d['dst'])}, 'unit': pv.UNIT,
                       'systemctl': fake, 'allowIncompleteProcScan': True, 'reserveBytes': 300_000_000_000,
                       'progressPath': os.path.join(self.root, f'copy-{r}.progress.json'), 'receiptPath': rp},
                      open(hp, 'w'))
            out = subprocess.run([sys.executable, '-I', HELPER, hp], capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
            self.receipts[r] = rp
        self.n = 0

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(pv.STATE_DIR, ignore_errors=True)
        shutil.rmtree(pv.UNIT_PATH.parent, ignore_errors=True)

    def fin(self, receipts=None, **kw):
        self.n += 1
        args = ['finalize-receipts', '--plan', self.e.plan, '--out', os.path.join(self.root, f'staged-{self.n}')]
        for r, p in (receipts or self.receipts).items():
            args += ['--receipt', f'{r}={p}']
        for k, v in kw.items():
            args += ['--' + k.replace('_', '-')] + ([] if v is True else [str(v)])
        err = iomod.StringIO()
        out = iomod.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            rc = mig.main(args)
        return rc, err.getvalue(), out.getvalue(), args[args.index('--out') + 1]

    def mutated(self, role, fn):
        rec = json.load(open(self.receipts[role]))
        fn(rec)
        p = os.path.join(self.root, f'mut-{self.n}-{role}.json')
        json.dump(rec, open(p, 'w'))
        return dict(self.receipts, **{role: p})

    def refused(self, needle, **kw):
        rc, err, _, out = self.fin(**kw)
        self.assertEqual(rc, 2, err)
        self.assertIn(needle, err)
        self.assertFalse(os.path.exists(out))

    def test_ok_stages_v2_and_installs_nothing(self):
        installed = {p: sha(p) for p in (self.e.m1['paths']['manifest'], self.e.m1['paths']['launcher'], str(pv.UNIT_PATH))}
        rc, err, out, staged = self.fin()
        self.assertEqual(rc, 0, err)
        res = json.loads(out)
        self.assertEqual({r: v['identity'] for r, v in res['disks'].items()},
                         {'os': 'receipt inode+size+mtime/ctime<=finished', 'l1': 'receipt inode+size+mtime/ctime<=finished'})
        self.assertEqual({p: sha(p) for p in installed}, installed)
        m2 = json.load(open(os.path.join(staged, 'manifest.json')))
        pv.validate_v2(m2)
        for r in ('os', 'l1'):
            rec = json.load(open(self.receipts[r]))
            self.assertEqual(m2['disks'][r]['ino'], rec['finalInode'])
            self.assertEqual(m2['migration']['disks'][r]['to']['sha256'], rec['copySha256'])
            self.assertEqual(m2['migration']['disks'][r]['to']['copy']['receiptSha256'], sha(self.receipts[r]))
            for k in ('serial', 'uuid', 'label', 'mount', 'bytes'):
                self.assertEqual(m2['disks'][r].get(k), self.e.m1['disks'][r].get(k))
        self.assertEqual(m2['migration']['copyMethod'], 'root-reviewed nvme_copy.py byte-for-byte copy (receipts)')
        self.assertEqual(pv.seed_files(m2), pv.seed_files(self.e.m1))
        self.assertEqual(pv.sha256_text(pv.canonical(pv.qemu_argv(m2))), m2['files']['qemuArgv'])
        self.assertEqual(m2['files']['launcher'], self.plan['launcher']['sha256'])
        self.assertIn('not a user cap', m2['nvme']['freeFloorPolicy'])
        self.assertEqual(subprocess.run(['sha256sum', '-c', '--quiet', 'SHA256SUMS'], cwd=staged).returncode, 0)

    def test_wrong_helper(self):
        self.refused('root-reviewed helper', receipts=self.mutated('os', lambda r: r.update(helperSha256='0' * 64)))

    def test_copy_hash_differs(self):
        self.refused('equal sourceSha256', receipts=self.mutated('l1', lambda r: r.update(copySha256='f' * 64)))

    def test_non_hex_digest(self):
        for bogus in ('x' * 64, 'A' * 64, ' ' + 'a' * 63):
            self.refused('64 lowercase hex', receipts=self.mutated(
                'os', lambda r, b=bogus: r.update(copySha256=b, sourceSha256=b)))

    def test_same_path_launcher_repin(self):          # root regression (ROOT-STEERING 17:04), imported verbatim
        same = self.plan['launcher']['path']
        os.chmod(same, 0o700)
        with open(same, 'a') as f:
            f.write('\n# reviewed replacement at the same source path\n')
        self.refused('launcher changed since the plan')
        rc, err, out, staged = self.fin(launcher=same, accept_launcher_sha=sha(same))
        self.assertEqual(rc, 0, err)
        with open(os.path.join(staged, 'manifest.json')) as f:
            manifest = json.load(f)
        self.assertEqual(manifest['files']['launcher'], sha(same))
        self.assertEqual(sha(os.path.join(staged, 'provision_vm.py')), sha(same))

    def test_wrong_target_path(self):
        self.refused('is not the planned', receipts=self.mutated(
            'l1', lambda r: r.update(final=r['final'] + '.x')))

    def test_wrong_inode(self):
        self.refused('inode/size', receipts=self.mutated('l1', lambda r: r.update(finalInode=r['finalInode'] + 1)))

    def test_failed_status(self):
        self.refused("status 'failed'", receipts=self.mutated('os', lambda r: r.update(status='failed')))

    def test_unit_active_in_receipt(self):
        self.refused('unitAfterCopy', receipts=self.mutated(
            'os', lambda r: r['unitAfterCopy'].update(ActiveState='active', MainPID='77')))

    def test_source_differs_from_plan(self):
        def bump(r):
            for k in ('sourceBefore', 'sourceAfter'):
                r[k]['mtime_ns'] += 1
        self.refused('modified since the plan', receipts=self.mutated('l1', bump))

    def test_missing_l1(self):
        self.refused('every disk needs one', receipts={'os': self.receipts['os']})

    def test_active_unit_now(self):
        self.e.units[pv.UNIT] = ('active', 4242)
        self.refused('finalize only with the VM stopped')

    def test_guard_unit_active_now(self):
        self.e.units[pv.GUARD_UNIT] = ('activating', 99)
        self.refused('finalize only with the VM stopped')

    def test_source_touched_after_copy(self):
        time.sleep(1.1)
        os.utime(self.plan['disks']['l1']['src']['path'])
        self.refused('changed after the copy receipt')

    def test_stale_target_mutation(self):
        dst = self.plan['disks']['l1']['dst']
        time.sleep(2.1)                                           # beyond the receipt's 1 s finished granularity
        base.qio(dst, 'write -P 0x66 0 64k')
        self.refused('stale or substituted')
        self.refused('no longer matches the receipt sha256', rehash_if_stale=True)

    def test_metadata_only_change_needs_and_passes_rehash(self):
        dst = self.plan['disks']['os']['dst']
        time.sleep(2.1)
        os.chmod(dst, 0o600)                                      # ctime moves, content does not
        self.refused('stale or substituted')
        rc, err, out, _ = self.fin(rehash_if_stale=True)
        self.assertEqual(rc, 0, err)
        self.assertEqual(json.loads(out)['disks']['os']['identity'], 'full re-hash (timestamps later than the receipt)')

    def test_substituted_same_name(self):
        dst = self.plan['disks']['l1']['dst']
        tmp = dst + '.sub'
        shutil.copyfile(dst, tmp)
        os.chmod(tmp, 0o600)
        os.replace(tmp, dst)                                       # same bytes, new inode
        self.refused('inode/size')

    def test_target_held_by_qemu(self):
        dst = self.plan['disks']['l1']['dst']
        h = subprocess.Popen(['/usr/bin/qemu-io', '-f', 'qcow2', dst], stdin=subprocess.PIPE,
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
        try:
            self.refused('lock')
        finally:
            h.communicate(b'quit\n', timeout=30)

    def test_launcher_repin_requires_explicit_sha(self):
        new = os.path.join(self.root, 'provision_vm.repin.py')
        shutil.copyfile(base.LAUNCHER, new)
        with open(new, 'a') as f:
            f.write('\n# re-pin test\n')
        self.refused('--accept-launcher-sha', launcher=new, accept_launcher_sha='0' * 64)
        rc, err, out, staged = self.fin(launcher=new, accept_launcher_sha=sha(new))
        self.assertEqual(rc, 0, err)
        m2 = json.load(open(os.path.join(staged, 'manifest.json')))
        self.assertEqual(m2['files']['launcher'], sha(new))
        self.assertEqual(sha(os.path.join(staged, 'provision_vm.py')), sha(new))
        os.chmod(self.e.m1['paths']['launcher'], 0o700)
        with open(self.e.m1['paths']['launcher'], 'a') as f:     # the plan's own launcher changed: refused w/o re-pin
            f.write('\n# drift\n')
        self.refused('launcher changed since the plan')


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(base.SANDBOX, ignore_errors=True)
