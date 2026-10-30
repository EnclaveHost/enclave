"""Local metadata fixtures only; no SSH, client, systemd, NBD or production paths."""
import unittest,importlib.util,tempfile,os,stat,sys,ast,json
from pathlib import Path
p=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('ownership',p/'source/ownership.py');own=importlib.util.module_from_spec(spec);spec.loader.exec_module(own)
class Ownership(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory(prefix='nan-owner-fixture-');self.root=Path(self.tmp.name)
  for n in ('cl','tmp-cl'):(self.root/n).mkdir(mode=0o750)
  (self.root/'cl/data').write_bytes(b'preserved');(self.root/'cl/data').chmod(0o640)
  self.ids=(os.getuid(),os.getgid())
 def tearDown(self):self.tmp.cleanup()
 def scan(self,**kw):return own.remap_tree(str(self.root),self.ids,self.ids,**kw)
 def test_metadata_roundtrip(self):
  before=self.scan();after=self.scan(ledger=before);self.assertEqual(before,after);self.assertEqual((self.root/'cl/data').read_bytes(),b'preserved')
 def test_symlink(self):
  (self.root/'cl/link').symlink_to('/etc/passwd')
  with self.assertRaises(OSError):self.scan()
 def test_hardlink(self):
  os.link(self.root/'cl/data',self.root/'tmp-cl/link')
  with self.assertRaisesRegex(RuntimeError,'hardlink'):self.scan()
 def test_privilege_bits(self):
  (self.root/'cl/data').chmod(0o4640)
  with self.assertRaisesRegex(RuntimeError,'privilege'):self.scan()
 def test_drift_before_write(self):
  ledger=self.scan();(self.root/'cl/data').write_bytes(b'different')
  with self.assertRaisesRegex(RuntimeError,'preflight-drift'):self.scan(ledger=ledger)
 def test_unknown_uid(self):
  with self.assertRaisesRegex(RuntimeError,'source-identity'):own.remap_tree(str(self.root),(self.ids[0]+1,self.ids[1]),self.ids)
 def test_stop_request(self):
  def stop():raise RuntimeError('latched-stop')
  with self.assertRaisesRegex(RuntimeError,'latched-stop'):self.scan(tick=stop)
 def test_time_bound(self):
  with self.assertRaisesRegex(RuntimeError,'time-bound'):self.scan(seconds=0)
 def test_depth(self):
  q=self.root/'cl'
  for _ in range(34):q=q/'x';q.mkdir(mode=0o750)
  with self.assertRaisesRegex(RuntimeError,'depth'):self.scan()
class Source(unittest.TestCase):
 def test_all_sources_parse(self):
  for q in (p/'source').glob('*.py'):ast.parse(q.read_text(),filename=str(q))
 def test_source_mount_consistency(self):
  s=p/'source';m=json.loads((s/'MANIFEST.json').read_text());a=json.loads((s/'payload-manifest.json').read_text());d=json.loads((s/'disks.json').read_text())
  self.assertEqual(m['expectedProductionMount'],a['mounts']['l1']);self.assertEqual(d['disks'][0]['mount'],a['mounts']['l1']);self.assertFalse(m['admission']['authorized'])
 def test_no_el_in_client_path(self):
  s=p/'source';m=json.loads((s/'MANIFEST.json').read_text());self.assertNotIn('reth',m['payloadFiles']);t=(s/'client-main.py').read_text();self.assertNotIn('os.replace(temporary,config)',t);self.assertIn("for side in ('cl',):",t)
if __name__=='__main__':unittest.main(verbosity=2)
