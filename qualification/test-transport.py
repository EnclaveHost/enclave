#!/usr/bin/env python3
"""Tiny hermetic archive-admission checks: no real image, credentials or network."""
import hashlib, io, json, os, shutil, subprocess, sys, tarfile, tempfile, unittest
from pathlib import Path

class ArchiveAdmission(unittest.TestCase):
    def run_case(self, mutation=None):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name); (root/'out').mkdir()
            shutil.copyfile(Path(__file__).with_name('unpack-input.py'),root/'unpack-input.py')
            content={n:b'fixed-'+n.encode() for n in ['initramfs.cpio.gz','vmlinuz','cmdline','manifest.json']}
            pins={n:{'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()} for n,b in content.items()}
            (root/'input-pins.json').write_text(json.dumps({'files':pins}))
            items=[]
            for n,b in content.items():
                item=tarfile.TarInfo(n); item.size=len(b); items.append((item,b))
            if mutation: mutation(items)
            with tarfile.open(root/'input.tar','w') as archive:
                for item,data in items: archive.addfile(item,io.BytesIO(data))
            r=subprocess.run([sys.executable,str(root/'unpack-input.py'),str(root/'input.tar'),str(root/'out')],capture_output=True)
            return r.returncode,sorted(p.name for p in (root/'out').iterdir())
    def test_valid(self): self.assertEqual(self.run_case()[0],0)
    def test_parent_escape(self):
        self.assertNotEqual(self.run_case(lambda xs:setattr(xs[0][0],'name','../escape'))[0],0)
    def test_absolute_path(self):
        self.assertNotEqual(self.run_case(lambda xs:setattr(xs[0][0],'name','/escape'))[0],0)
    def test_duplicate(self): self.assertNotEqual(self.run_case(lambda xs:xs.append(xs[0]))[0],0)
    def test_missing(self): self.assertNotEqual(self.run_case(lambda xs:xs.pop())[0],0)
    def test_hash_mismatch(self):
        self.assertNotEqual(self.run_case(lambda xs:xs.__setitem__(0,(xs[0][0],b'x'*len(xs[0][1]))))[0],0)
    def test_size_mismatch(self):
        def mutate(xs): xs[0][0].size-=1
        self.assertNotEqual(self.run_case(mutate)[0],0)
    def test_symlink(self):
        def mutate(xs): xs[0][0].type=tarfile.SYMTYPE; xs[0][0].linkname='/etc/shadow'
        self.assertNotEqual(self.run_case(mutate)[0],0)

if __name__=='__main__': unittest.main()
