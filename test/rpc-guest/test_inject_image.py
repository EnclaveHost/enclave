import hashlib
import importlib.util
import io
from pathlib import Path
import struct
import unittest
import zlib

spec=importlib.util.spec_from_file_location('image',Path(__file__).resolve().parents[2]/'rpc/guest/inject_image.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ImageTests(unittest.TestCase):
    def disk(self):
        raw=bytearray(2*1024**2)
        table=bytearray(128*128)
        table[:16]=b'x'*16
        struct.pack_into('<QQ',table,32,2048,4000)
        header=bytearray(512);header[:8]=b'EFI PART'
        struct.pack_into('<I',header,12,92)
        struct.pack_into('<QIII',header,72,2,128,128,zlib.crc32(table))
        struct.pack_into('<I',header,16,zlib.crc32(header[:92]))
        raw[512:1024]=header;raw[1024:1024+len(table)]=table
        at=2048*512+1024;raw[at+56:at+58]=b'\x53\xef';raw[at+120:at+134]=b'cloudimg-rootfs'
        return raw

    def test_root_geometry_and_identity(self):
        raw=self.disk();self.assertEqual(m.root_partition(io.BytesIO(raw),len(raw)),(1048576,999936))

    def test_corrupt_header_refused(self):
        raw=self.disk();raw[520]^=1
        with self.assertRaisesRegex(ValueError,'header checksum'):m.root_partition(io.BytesIO(raw),len(raw))

    def test_corrupt_table_refused(self):
        raw=self.disk();raw[1024]^=1
        with self.assertRaisesRegex(ValueError,'table checksum'):m.root_partition(io.BytesIO(raw),len(raw))

    def test_wrong_root_filesystem_refused(self):
        raw=self.disk();raw[1048576+1024+120]=ord('x')
        with self.assertRaisesRegex(ValueError,'root ext4'):m.root_partition(io.BytesIO(raw),len(raw))

    def test_out_of_range_partition_refused(self):
        raw=self.disk();struct.pack_into('<Q',raw,1024+40,9000)
        struct.pack_into('<I',raw,512+88,zlib.crc32(raw[1024:1024+16384]))
        struct.pack_into('<I',raw,512+16,0);struct.pack_into('<I',raw,512+16,zlib.crc32(raw[512:604]))
        with self.assertRaisesRegex(ValueError,'partition bounds'):m.root_partition(io.BytesIO(raw),len(raw))

    def test_paths_confined_to_runtime(self):
        self.assertEqual(m.safe_member('opt/enclave-rpc/bin/base'),'opt/enclave-rpc/bin/base')
        for name in ['/etc/passwd','etc/shadow','opt/enclave-rpc/../escape','opt//enclave-rpc/a','opt/enclave-rpc/a\nwrite other']:
            with self.assertRaises(ValueError,msg=name):m.safe_member(name)

    def test_copy_exact_range_and_short_source(self):
        out=io.BytesIO();m.copy_range(io.BytesIO(b'abcDEF'),out,3,lambda:None);self.assertEqual(out.getvalue(),b'abc')
        with self.assertRaisesRegex(ValueError,'Short'):m.copy_range(io.BytesIO(b'a'),io.BytesIO(),2,lambda:None)

    def test_copy_resource_guard_interrupts_before_write(self):
        out=io.BytesIO()
        def stop():raise RuntimeError('guard')
        with self.assertRaisesRegex(RuntimeError,'guard'):m.copy_range(io.BytesIO(b'ab'),out,2,stop)
        self.assertEqual(out.getvalue(),b'')

if __name__=='__main__':unittest.main()
