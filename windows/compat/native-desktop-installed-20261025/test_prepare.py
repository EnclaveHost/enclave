"""Offline deployment preparation must refuse drift before producing an overlay."""
from pathlib import Path
import importlib.util,json,tempfile,unittest,shutil

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('node_overlay_prepare',HERE/'prepare.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

class RefusalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest=json.loads((HERE/'manifest.json').read_text())
        cls.repo=HERE.parents[2]
        # The caller supplies the pinned public installed snapshot, not host state.
        import os
        cls.baseline=Path(os.environ['NATIVE_COMPAT_INSTALLED_SNAPSHOT']).resolve()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='native-port-refusal-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.installed=self.root/'installed';self.source=self.root/'source';self.output=self.root/'output'
        self.installed.mkdir();self.source.mkdir()
        for f in self.manifest['modified']:
            p=self.installed/f['path'];p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(self.baseline/f['path'],p)
        for f in self.manifest['added']:
            p=self.source/f['path'];p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(self.repo/f['path'],p)

    def refuse(self,pattern):
        with self.assertRaisesRegex(ValueError,pattern):module.prepare(self.installed,self.source,self.output)
        self.assertFalse(self.output.exists())

    def test_installed_drift(self):
        p=self.installed/self.manifest['modified'][0]['path'];p.write_bytes(p.read_bytes()+b'\n')
        self.refuse('installed source pin mismatch')

    def test_helper_drift(self):
        p=self.source/self.manifest['added'][0]['path'];p.write_bytes(p.read_bytes()+b'\n')
        self.refuse('new module pin mismatch')

    def test_existing_new_module_is_not_overwritten(self):
        p=self.installed/self.manifest['added'][0]['path'];p.parent.mkdir(parents=True,exist_ok=True);p.write_text('existing local code')
        self.refuse('new module already exists');self.assertEqual(p.read_text(),'existing local code')

    def test_existing_output_is_preserved(self):
        self.output.mkdir();(self.output/'keep').write_text('preserve')
        with self.assertRaisesRegex(ValueError,'output already exists'):module.prepare(self.installed,self.source,self.output)
        self.assertEqual((self.output/'keep').read_text(),'preserve')

    def test_source_symlink_escape(self):
        p=self.source/self.manifest['added'][0]['path'];outside=self.root/'outside';outside.write_bytes(p.read_bytes());p.unlink();p.symlink_to(outside)
        self.refuse('not in the subpath|not in the subpath of|relative path')

    def test_installed_symlink_is_refused_even_with_expected_bytes(self):
        p=self.installed/self.manifest['modified'][0]['path'];saved=self.installed/'same-bytes';p.rename(saved);p.symlink_to(saved)
        self.refuse('must be a regular file')

if __name__=='__main__':unittest.main()
