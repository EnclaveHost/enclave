import hashlib,json,os,subprocess,tempfile,unittest,time
from pathlib import Path
import offline_mask as om
class NativeSlowLink(unittest.TestCase):
    def test_native_long_symlink_inventory(self):
        with tempfile.TemporaryDirectory(prefix='rpc-native-link-') as d:
            raw=Path(d)/'tiny.ext4'
            with raw.open('xb') as f:f.truncate(32<<20)
            subprocess.run(['/usr/bin/mke2fs','-q','-F','-t','ext4',str(raw)],check=True,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
            dbg=om.Debugfs(om.OsEffects(),'/usr/bin/debugfs',str(raw),{'commandSeconds':5,'maxOutputBytes':65536},om.Deadline(20,time.monotonic),lambda *a:None)
            dbg.call('mkdir /units',True)
            target='../vendor/'+('x'*90)+'.service'
            dbg.call('symlink /units/long.service '+target,True)
            before=dbg.stat('/units/long.service')
            self.assertEqual(before['type'],'symlink');self.assertIsNone(before['target'])
            actual=dbg.cat('<'+str(before['inode'])+'>')
            self.assertEqual(actual,target.encode())
            self.assertEqual(len(actual),before['size'])
            self.assertEqual(dbg.stat('/units/long.service'),before)
            print(json.dumps({'nativeSlowLinkRead':True,'targetBytes':len(actual),'sha256':hashlib.sha256(actual).hexdigest(),'inodeStable':True}))
            inv=om.inventory(dbg,('/units',),100)
            self.assertEqual(inv['entries']['/units/long.service']['target'],target)
