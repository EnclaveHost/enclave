"""Local disposable-file checks. Death guard mocked; not live qualification."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import financial_private_checkpoint as cp


class ReadbackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='owned-checkpoint-test-')
        self.root=Path(self.temp.name)
        self.source=self.root/'sessions-relayer.json'
        self.source.write_text(json.dumps({'txs':[{'nonce':0,'status':'sending','hashes':[]}]}))
        self.source.chmod(0o600)
        d=self.root.stat()
        self.kw={'writer_pid':999999,'cgroup':'/sys/fs/cgroup/system.slice/owned-test.service',
                 'expected_directory_device':d.st_dev,'expected_directory_inode':d.st_ino,
                 'expected_observed_bytes':self.source.stat().st_size}
        self.death=patch.object(cp,'verify_dead',return_value=None)
        self.death.start()

    def tearDown(self):
        self.death.stop();self.temp.cleanup()

    def test_owned_readback(self):
        r=cp.preserve(self.source,self.root/'checkpoint',**self.kw)
        self.assertEqual(r['records'],1)
        self.assertTrue(r['fileAndParentFsynced'])
        self.assertFalse(r['writeResumptionAllowed'])
        p=self.root/'checkpoint/journal.private.json'
        self.assertEqual(p.stat().st_mode & 0o777,0o400)
        self.assertEqual(p.read_bytes(),self.source.read_bytes())

    def test_size_mismatch_refuses(self):
        with self.assertRaises(RuntimeError):
            cp.preserve(self.source,self.root/'checkpoint',**{**self.kw,'expected_observed_bytes':1})
        self.assertFalse((self.root/'checkpoint').exists())

    def test_symlink_refuses(self):
        self.source.rename(self.root/'real.json');self.source.symlink_to(self.root/'real.json')
        with self.assertRaises(OSError):
            cp.preserve(self.source,self.root/'checkpoint',**self.kw)

    def test_hardlink_refuses(self):
        os.link(self.source,self.root/'alias.json')
        with self.assertRaises(RuntimeError):
            cp.preserve(self.source,self.root/'checkpoint',**self.kw)

    def test_no_overwrite(self):
        (self.root/'checkpoint').mkdir()
        with self.assertRaises(FileExistsError):
            cp.preserve(self.source,self.root/'checkpoint',**self.kw)

    def test_fsync_failure_refuses(self):
        with patch.object(cp.os,'fsync',side_effect=OSError('test fsync failed')):
            with self.assertRaises(OSError):
                cp.preserve(self.source,self.root/'checkpoint',**self.kw)
        self.assertFalse((self.root/'checkpoint').exists())


if __name__=='__main__':unittest.main()
