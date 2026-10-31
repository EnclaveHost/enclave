import importlib.util
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('storage',Path(__file__).resolve().parents[2]/'rpc/guest/prepare_storage_client.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class LoaderTests(unittest.TestCase):
    def test_actual_loader_shape_and_private_aliases(self):
        with tempfile.TemporaryDirectory() as td:
            lib=Path(td)/'lib';lib.mkdir()
            names={'libc.so.6':'libc.so.6','ld-linux-x86-64.so.2':'ld-linux-x86-64.so.2','libgnutls.so.30':'libgnutls.so.30.37.1'}
            for name in names.values():(lib/name).write_bytes(b'fixture')
            (lib/'libgnutls.so.30').symlink_to('libgnutls.so.30.37.1')
            lines=['linux-vdso.so.1 (0x123)']+[f"{('/lib64/'+name) if name.startswith('ld-') else name} => {lib/name} (0x456)" for name in names]
            valid='\n'.join(lines)
            m.validate_loader(valid,lib,names)
            for bad in ['\n'.join(lines[:-1]),valid+'\n'+lines[-1],valid+'\nlibother.so => /tmp/other (0x123)',valid+'\nnot found',valid.replace('/lib64/ld-','/wrong/ld-')]:
                with self.assertRaises(ValueError):m.validate_loader(bad,lib,names)
            outside=Path(td)/'outside';outside.write_bytes(b'fixture')
            (lib/'libgnutls.so.30').unlink();(lib/'libgnutls.so.30').symlink_to(outside)
            with self.assertRaises(ValueError):m.validate_loader(valid,lib,names)

if __name__=='__main__':unittest.main()
