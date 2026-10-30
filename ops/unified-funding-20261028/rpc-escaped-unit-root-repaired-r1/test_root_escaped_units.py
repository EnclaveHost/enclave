import hashlib, os, subprocess, tempfile, time, unittest
from pathlib import Path
import offline_mask as om

class EscapedUnitNames(unittest.TestCase):
    def test_native_literal_hex_names_are_not_unescaped(self):
        with tempfile.TemporaryDirectory(prefix='rpc-escaped-units-') as tmp:
            root=Path(tmp); tree=root/'tree'; units=tree/'units'; units.mkdir(parents=True)
            expected={r'system-fixture\x2dtest.slice': b'literal-backslash',
                      'system-fixture-test.slice': b'different-decoy',
                      r'literal\x20name.service': b'not-a-space'}
            for name,data in expected.items(): (units/name).write_bytes(data)
            sub=r'fixture\x2dname.service.d'; (units/sub).mkdir(); (units/sub/'a.conf').write_bytes(b'child')
            link=r'link\x2dname.service'; os.symlink(r'system-fixture\x2dtest.slice',units/link)
            raw=root/'tiny.ext4'
            with raw.open('xb') as f: f.truncate(32<<20)
            subprocess.run(['/usr/bin/mke2fs','-q','-F','-t','ext4','-d',str(tree),str(raw)],check=True,
                           stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
            dbg=om.Debugfs(om.OsEffects(),'/usr/bin/debugfs',str(raw),{'commandSeconds':5,'maxOutputBytes':65536},
                           om.Deadline(20,time.monotonic),lambda *a:None)
            listing={e['name']:e for e in dbg.ls('/units')}
            self.assertTrue(set(expected).issubset(listing))
            for name,data in expected.items():
                path='/units/'+name
                self.assertEqual(dbg.stat(path)['inode'],listing[name]['inode'])
                self.assertEqual(dbg.cat(path),data)
            inv=om.inventory(dbg,('/units',),100)
            for name,data in expected.items(): self.assertEqual(inv['hashes']['/units/'+name],hashlib.sha256(data).hexdigest())
            self.assertEqual(inv['hashes']['/units/'+sub+'/a.conf'],hashlib.sha256(b'child').hexdigest())
            self.assertEqual(inv['entries']['/units/'+link]['target'],r'system-fixture\x2dtest.slice')

    def test_unsafe_requests_still_refuse_without_execution(self):
        class NeverRun:
            def run(self,*a): raise AssertionError('unsafe request reached subprocess')
        dbg=om.Debugfs(NeverRun(),'/usr/bin/debugfs','unused',{'commandSeconds':5,'maxOutputBytes':65536},
                       om.Deadline(20,time.monotonic),lambda *a:None)
        for req in ['cat /units/a b', 'cat /units/a\tb','cat /units/a\nb','cat /units/a\x00b',
                    'cat /units/"a"',"cat /units/'a'",'cat /units/a;b','cat /units/a|b','cat /units/a&b',
                    'cat /units/a$b','cat /units/a`b',r'cat /units/a\x1',r'cat /units/a\q',
                    r'cat \x20','cat /units/../etc/a','cat /units/'+('a'*256)]:
            with self.subTest(request=repr(req)),self.assertRaises(om.Refusal):dbg.call(req)
