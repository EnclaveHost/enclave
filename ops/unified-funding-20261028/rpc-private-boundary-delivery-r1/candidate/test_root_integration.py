import hashlib,os,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import offline_mask as om
from test_offline_mask import plan,FakePipeProc
class RootIntegration(unittest.TestCase):
 def test_copy_accepts_the_identity_schema_passed_by_execute(self):
  with tempfile.TemporaryDirectory(prefix='rpc-copy-unit-') as t:
   src=Path(t)/'source';dst=Path(t)/'copy';src.write_bytes(b'qualified copy fixture\n');s=src.stat()
   identity={'path':str(src),'sha256':hashlib.sha256(src.read_bytes()).hexdigest(),'device':s.st_dev,'inode':s.st_ino,'size':s.st_size,'mtimeNs':s.st_mtime_ns,'receiptPath':'unused','receiptSha256':'0'*64}
   got=om.OsEffects().sparse_copy(str(src),identity,str(dst),om.Deadline(5,om.time.monotonic))
   self.assertEqual(got,identity['sha256']);self.assertEqual(src.read_bytes(),dst.read_bytes())
 def test_systemctl_preserves_only_required_user_bus_context(self):
  calls=[]
  def popen(*a,**kw):calls.append(kw);return FakePipeProc(b'')
  with patch.dict(os.environ,{'XDG_RUNTIME_DIR':'/run/user/1000','DBUS_SESSION_BUS_ADDRESS':'unix:path=/run/user/1000/bus','PRIVATE_UNRELATED':'must-not-inherit'}):
   om.OsEffects(popen=popen).run(['/usr/bin/systemctl','--user','show','example.service'],3,4096)
  self.assertEqual(calls[0]['env'].get('XDG_RUNTIME_DIR'),'/run/user/1000')
  self.assertEqual(calls[0]['env'].get('DBUS_SESSION_BUS_ADDRESS'),'unix:path=/run/user/1000/bus')
  self.assertNotIn('PRIVATE_UNRELATED',calls[0]['env'])
