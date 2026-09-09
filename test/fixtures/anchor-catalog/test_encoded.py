import copy
import hashlib
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from catalog_binary import encode as encode_source
from encoded_binary import encode
from test_catalog import fixture,digest,ROOT

class EncodedChecks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.raw,self.doc=fixture();self.source=encode_source(self.doc)
        self.calib='ab'*32;self.converter='cd'*32
        self.entries=[]
        for t in sorted(self.doc['tensors'],key=lambda t:t['name_hex']):
            size=t['ne'][0]*t['ne'][1];weights=bytes((i%119 for i in range(size)));h=digest(weights)
            (self.root/(h+'.i8')).write_bytes(weights)
            self.entries.append(dict(name_hex=t['name_hex'],type=t['type'],n_dims=t['n_dims'],ne=t['ne'],
               source_tensor_sha256=t['sha256'],encoded_bytes=size,encoded_sha256=h,
               exponents_le_i32_hex=struct.pack('<'+'i'*t['ne'][1],*([8]*t['ne'][1])).hex(),block_sha256=[h]))
        self.cat=encode(self.doc['model_sha256'],digest(self.source),self.calib,self.converter,self.entries)
    def invoke(self,cat=None,authority=None,calib=None,converter=None,check=False):
        cat=self.cat if cat is None else cat
        (self.root/'model').write_bytes(self.raw);(self.root/'source').write_bytes(self.source);(self.root/'encoded').write_bytes(cat)
        args=[str(ROOT/'check-encoded'),str(self.root/'model'),str(self.root/'source'),digest(self.source),
              self.doc['model_sha256'],str(self.root/'encoded'),authority or digest(cat),calib or self.calib,
              converter or self.converter,str(self.root) if check else '-']
        p=subprocess.run(args,capture_output=True,timeout=5)
        self.assertNotIn(b'Sanitizer',p.stderr);self.assertNotIn(b'runtime error:',p.stderr)
        return p
    def test_valid_read_and_corrupt_artifact(self):
        p=self.invoke(check=True);self.assertEqual(p.returncode,0,p.stderr)
        self.assertEqual(json.loads(p.stdout)['verified_artifact_bytes'],96)
        path=self.root/(self.entries[0]['encoded_sha256']+'.i8');b=bytearray(path.read_bytes());b[0]^=1;path.write_bytes(b)
        self.assertEqual(self.invoke().returncode,0) # metadata admission is explicitly not a tensor read
        self.assertEqual(self.invoke(check=True).returncode,5)
        path.write_bytes(b[:-1]);self.assertEqual(self.invoke(check=True).returncode,5)
    def test_authority_and_all_binding_fields(self):
        self.assertEqual(self.invoke(authority='00'*32).returncode,4)
        self.assertEqual(self.invoke(calib='00'*32).returncode,4)
        self.assertEqual(self.invoke(converter='00'*32).returncode,4)
        for offset in (0,8,12,16,20,24,28,32,64,96,128,160,168,192,192+20,
                       192+128,192+132,192+136,192+144,192+152,192+160,192+168,
                       192+200,192+208,192+216):
            with self.subTest(offset=offset):
                b=bytearray(self.cat);b[offset]^=1
                self.assertEqual(self.invoke(cat=bytes(b)).returncode,4)
    def test_bad_counts_lengths_exponents_and_hashes(self):
        for count in (0,4097,0xffffffff):
            b=bytearray(self.cat);struct.pack_into('<I',b,8,count)
            self.assertEqual(self.invoke(cat=bytes(b)).returncode,4)
        for cat in (self.cat[:191],self.cat[:-1],self.cat+b'X'):
            self.assertEqual(self.invoke(cat=cat).returncode,4)
        for value in (257,-257,2147483647,-2147483648):
            b=bytearray(self.cat);struct.pack_into('<i',b,192+256,value)
            self.assertEqual(self.invoke(cat=bytes(b)).returncode,4)
        # Valid negative exponents are decoded explicitly; backend later applies calib-specific range.
        b=bytearray(self.cat);struct.pack_into('<i',b,192+256,-64)
        self.assertEqual(self.invoke(cat=bytes(b)).returncode,0)
        b=bytearray(self.cat);b[192+256+8]^=1
        self.assertEqual(self.invoke(cat=bytes(b),check=True).returncode,5)
    def test_duplicate_order_and_missing_artifact(self):
        # First entry is 256+2*4+32 bytes. Swap equal-schema entry bytes to violate name ordering.
        at=192+256+8+32
        b=self.cat[:192]+self.cat[at:]+self.cat[192:at]
        self.assertEqual(self.invoke(cat=b).returncode,4)
        for p in self.root.glob('*.i8'):p.unlink()
        self.assertEqual(self.invoke(check=True).returncode,5)

if __name__=='__main__':unittest.main()
