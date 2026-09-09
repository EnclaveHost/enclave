import copy
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from catalog_binary import encode

ROOT=Path(os.environ.get('CATALOG_TEST_BIN', Path(__file__).resolve().parent))
def digest(b): return hashlib.sha256(b).hexdigest()
def string(b): return struct.pack('<Q',len(b))+b

def fixture():
    header=b'GGUF'+struct.pack('<IQQ',3,2,0)
    header+=string(b'firstx')+struct.pack('<IQQIQ',2,32,2,8,0)
    header+=string(b'second')+struct.pack('<IQQIQ',2,32,1,8,96)
    data_start=(len(header)+31)//32*32
    raw=header.ljust(data_start,b'\0')+bytes(range(68))+bytes(28)+bytes(range(34))+b'trailer'
    d=dict(format='enclave-gguf-digest-catalog-v0',model_sha256=digest(raw),file_size=len(raw),
           header_len=len(header),header_sha256=digest(header),gguf_version=3,alignment=32,data_start=data_start,
           tensors=[dict(name_hex=b'firstx'.hex(),n_dims=2,ne=[32,2,1,1],type=8,offset=0,size=68,sha256=digest(bytes(range(68)))),
                    dict(name_hex=b'second'.hex(),n_dims=2,ne=[32,1,1,1],type=8,offset=96,size=34,sha256=digest(bytes(range(34))))])
    return raw,d

class Checks(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.raw,self.doc=fixture();self.cat=encode(self.doc)
    def invoke(self,raw=None,cat=None,ch=None,mh=None,check=True):
        raw=self.raw if raw is None else raw;cat=self.cat if cat is None else cat
        mp=self.root/'model';cp=self.root/'catalog';mp.write_bytes(raw);cp.write_bytes(cat)
        args=[str(ROOT/'check'),str(mp),str(cp),ch or digest(cat),mh or self.doc['model_sha256']]
        if check:args.append('--check-tensors')
        p=subprocess.run(args,capture_output=True,timeout=5)
        self.assertNotIn(b'Sanitizer',p.stderr)
        self.assertNotIn(b'runtime error:',p.stderr)
        return p
    def test_valid_and_unchecked_trailer_semantics(self):
        p=self.invoke();self.assertEqual(p.returncode,0,p.stderr)
        self.assertFalse(json.loads(p.stdout)['has_whole'])
        changed=self.raw[:-1]+b'X'
        self.assertEqual(self.invoke(raw=changed).returncode,0)
    def test_authorities_and_header_and_tensor_corruption(self):
        self.assertEqual(self.invoke(ch='00'*32).returncode,3)
        self.assertEqual(self.invoke(mh='00'*32).returncode,3)
        b=bytearray(self.raw);b[8]^=1
        self.assertEqual(self.invoke(raw=bytes(b)).returncode,3)
        b=bytearray(self.raw);b[self.doc['data_start']]^=1
        self.assertEqual(self.invoke(raw=bytes(b)).returncode,4)
        # Catalog admission does not claim unused tensors were read.
        self.assertEqual(self.invoke(raw=bytes(b),check=False).returncode,0)
    def test_all_layout_bindings(self):
        for offset in (0,8,12,16,24,32,40,48,80,112,112+10,112+128,
                       112+132,112+136,112+144,112+152,112+160,112+168,112+176):
            with self.subTest(offset=offset):
                b=bytearray(self.cat);b[offset]^=1
                self.assertEqual(self.invoke(cat=bytes(b)).returncode,3)
        b=bytearray(self.cat);b[112+184]^=1
        self.assertEqual(self.invoke(cat=bytes(b)).returncode,4)
    def test_lengths_and_counts(self):
        for raw in (self.raw[:-1],self.raw+b'X',self.raw[:5]):
            self.assertEqual(self.invoke(raw=raw).returncode,3)
        for cat in (self.cat[:111],self.cat[:-1],self.cat+b'X'):
            self.assertEqual(self.invoke(cat=cat).returncode,3)
        for count in (0,65537,0xffffffff):
            cat=self.cat[:8]+struct.pack('<I',count)+self.cat[12:]
            self.assertEqual(self.invoke(cat=cat).returncode,3)
    def test_verified_but_malformed_header(self):
        # Rebind expected catalog to malicious header: the GGUF parser still
        # rejects overlapping layouts and duplicate names, independently of SHA.
        for mode in ('overlap','duplicate','overflow','bad_type'):
            with self.subTest(mode=mode):
                raw=bytearray(self.raw);d=copy.deepcopy(self.doc)
                if mode=='overlap':
                    raw[d['header_len']-8:d['header_len']]=struct.pack('<Q',32)
                    d['tensors'][1]['offset']=32
                elif mode=='duplicate':
                    # Same name length using a fixture with a first name of six bytes.
                    at=raw.index(b'second');raw[at:at+6]=b'firstx'
                elif mode=='overflow':
                    at=raw.index(b'firstx')+len(b'firstx')+4
                    raw[at:at+8]=struct.pack('<Q',0xffffffffffffffff)
                else:
                    at=raw.index(b'firstx')+len(b'firstx')+4+16
                    raw[at:at+4]=struct.pack('<I',0xffffffff)
                d['header_sha256']=digest(raw[:d['header_len']])
                self.assertEqual(self.invoke(raw=bytes(raw),cat=encode(d)).returncode,3)

if __name__=='__main__':unittest.main()
