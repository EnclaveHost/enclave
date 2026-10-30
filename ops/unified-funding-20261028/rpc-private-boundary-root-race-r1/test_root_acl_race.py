import errno, os, struct, tempfile, unittest
from unittest import mock
import offline_mask as om
class RootAclObservation(unittest.TestCase):
    def test_actual_default_acl_change_invalidates_observation(self):
        original=os.getxattr
        acl=struct.pack('<I',2)+b''.join(struct.pack('<HHI',tag,perm,0xffffffff) for tag,perm in [(1,7),(4,5),(32,0)])
        with tempfile.TemporaryDirectory(prefix='rpc-acl-race-') as directory:
            before=os.lstat(directory)
            changed=[]
            def getter(path,name,**kw):
                try:return original(path,name,**kw)
                except OSError as exc:
                    if name=='system.posix_acl_default' and exc.errno==errno.ENODATA and not changed:
                        os.setxattr(path,name,acl,follow_symlinks=False)
                        changed.append(True)
                    raise
            with mock.patch.object(om.os,'getxattr',side_effect=getter):
                obs=om.OsEffects().access_meta(directory)
            after=os.lstat(directory)
            self.assertEqual(original(directory,'system.posix_acl_default'),acl)
            self.assertEqual(before.st_mode,after.st_mode)
            self.assertNotEqual(before.st_ctime_ns,after.st_ctime_ns)
            self.assertEqual(changed,[True])
            self.assertFalse(obs['stable'],'actual ACL changed during observation without changing mode/inode')
