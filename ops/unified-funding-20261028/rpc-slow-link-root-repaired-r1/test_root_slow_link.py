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
            before=om.parse_stat(dbg.call('stat /units/long.service').decode())
            self.assertEqual(before['type'],'symlink');self.assertIsNone(before['target'])
            actual=dbg.cat('<'+str(before['inode'])+'>')
            self.assertEqual(actual,target.encode())
            self.assertEqual(len(actual),before['size'])
            self.assertEqual(om.parse_stat(dbg.call('stat /units/long.service').decode()),before)
            print(json.dumps({'nativeSlowLinkRead':True,'targetBytes':len(actual),'sha256':hashlib.sha256(actual).hexdigest(),'inodeStable':True}))
            inv=om.inventory(dbg,('/units',),100)
            self.assertEqual(inv['entries']['/units/long.service']['target'],target)

class SlowLinkRefusals(unittest.TestCase):
    def fake(self,record,payload,after=None):
        from unittest import mock
        dbg=om.Debugfs.__new__(om.Debugfs);dbg.b={'maxOutputBytes':8192}
        dbg.call=lambda req: b'stat' if req.startswith('stat ') else payload
        records=[record,record if after is None else after]
        with mock.patch.object(om,'parse_stat',side_effect=records):return dbg.stat('/units/link')
    def test_bad_length_encoding_and_nul_refuse(self):
        for payload,size in [(b'a',2),(b'a\x00',2),(b'\xff',1),(b'a',4097)]:
            with self.subTest(payload=repr(payload),size=size),self.assertRaises(om.Refusal):
                self.fake({'type':'symlink','inode':123,'size':size,'target':None},payload)
    def test_slow_metadata_drift_refuses(self):
        r={'type':'symlink','inode':123,'size':1,'target':None}
        for key,value in [('inode',124),('type','regular'),('size',2),('uid',1000)]:
            with self.subTest(key=key),self.assertRaises(om.Refusal):self.fake(r,b'a',dict(r,**{key:value}))
    def test_fast_target_size_mismatch_refuses(self):
        with self.assertRaises(om.Refusal):self.fake({'type':'symlink','inode':123,'size':3,'target':'a'},b'')
    def test_inventory_rejects_listing_stat_identity_drift(self):
        import test_offline_revalidation as f
        g=f.Guest();original=g.stat;target=next(iter(om.UNITS))
        def drift(path):
            r=original(path)
            if path==f.WANTS+'/'+target:r['inode']+=1
            return r
        g.stat=drift
        with self.assertRaises(om.Refusal):om.inventory(g,om.guest_dirs(g,True),500)
