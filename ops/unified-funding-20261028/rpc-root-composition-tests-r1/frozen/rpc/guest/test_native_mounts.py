"""Inert checks: extract definitions without loading production paths or clients."""
import ast
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('chain_service.py')
tree = ast.parse(source.read_text())
names = {'_native_json', '_native_read', 'validate_native_mounts', 'native_mount', 'mount'}
ns = dict(hashlib=hashlib, json=json, os=os, re=re, stat=stat, subprocess=subprocess)
exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in names], type_ignores=[]), str(source), 'exec'), ns)


def fixture():
    manifest = json.dumps({'rpc': {'l1VolumeId': 'a'*64, 'baseVolumeId': 'b'*64}}).encode()
    # Wire fixture only, not a complete deployable V9/controller.
    bundle = b'ENCLAVE-BUNDLE/1\n' + struct.pack('<I', len(manifest)) + manifest + struct.pack('<I', 8) + b'\0asm\r\0\1\0'
    roles = {}
    for role, dev, logical, scopes in [('l1', 11, 'a', {'data':2101, 'tmp':2101, 'cl':2102, 'tmp-cl':2102}), ('base', 12, 'b', {'data':2103, 'tmp':2103})]:
        roles[role] = dict(volumeId=logical*64, dev=dev, ino=2, writes={name:dict(dev=dev, ino=20+i, uid=uid, gid=uid) for i,(name,uid) in enumerate(scopes.items())})
    return bundle, dict(schema='enclave-rpc-native-mounts/1', appId=hashlib.sha256(bundle).hexdigest(), claim='c'*64, roles=roles)


class BindingTests(unittest.TestCase):
    def test_exact_binding(self):
        b,d=fixture()
        self.assertIs(ns['validate_native_mounts'](d,b),d)

    def test_identity_mutations(self):
        b,d=fixture()
        mutations = [lambda x:x.update(appId='d'*64), lambda x:x.update(claim='0'*64), lambda x:x.update(extra=True),
                     lambda x:x['roles']['l1'].update(volumeId='b'*64), lambda x:x['roles']['l1'].update(dev=True),
                     lambda x:x['roles']['l1']['writes']['data'].update(dev=12), lambda x:x['roles']['l1']['writes']['data'].update(uid=2102),
                     lambda x:x['roles']['base']['writes'].pop('tmp'), lambda x:x['roles']['l1']['writes']['cl'].update(ino=0)]
        for i,mutate in enumerate(mutations):
            with self.subTest(mutation=i):
                x=copy.deepcopy(d);mutate(x)
                with self.assertRaises(ValueError):ns['validate_native_mounts'](x,b)

    def test_framing(self):
        b,d=fixture()
        for x in [b'',b[:-1],b+b'junk',b'not-bundle',b'ENCLAVE-BUNDLE/1\n'+b'\xff'*4]:
            with self.subTest(size=len(x)):
                with self.assertRaises(ValueError):ns['validate_native_mounts'](d,x)
        with self.assertRaises(ValueError):ns['_native_json']('{"appId":1,"appId":2}')

    def test_mount_kernel_checks(self):
        b,d=fixture(); ns['NATIVE_BINDING']=d;ns['MANIFEST']={'mounts':{'l1':'/fixture/l1','base':'/fixture/base'}}
        def metadata(path, **kw):
            role=path.split('/')[2]; row=d['roles'][role]
            if len(path.split('/'))==3:
                return SimpleNamespace(st_mode=stat.S_IFDIR|0o755,st_dev=row['dev'],st_ino=row['ino'],st_uid=0)
            child=row['writes'][path.split('/')[-1]]
            return SimpleNamespace(st_mode=stat.S_IFDIR|0o700,st_dev=child['dev'],st_ino=child['ino'],st_uid=child['uid'],st_gid=child['gid'])
        def findmnt(args, **kw):
            self.assertEqual(args[:6],['findmnt','-n','-o','FSTYPE,OPTIONS','--mountpoint',args[5]])
            return 'ext4 '+('ro' if len(args[-1].split('/'))==3 else 'rw')+',nosuid,nodev,noexec'
        with patch.object(os,'stat',side_effect=metadata),patch.object(os.path,'ismount',return_value=True),patch.object(subprocess,'check_output',side_effect=findmnt):
            for role,side in [('l1','el'),('l1','cl'),('base','base')]:
                self.assertEqual(ns['mount'](role,side),'/fixture/'+role)
            with patch.object(subprocess,'check_output',return_value='ext4 rw,nosuid,nodev,noexec'):
                with self.assertRaises(ValueError):ns['mount']('l1','el')
            original=metadata('/fixture/l1/data');original.st_ino+=1
            with patch.object(os,'stat',side_effect=lambda p,**kw:original if p.endswith('/data') else metadata(p,**kw)):
                with self.assertRaises(ValueError):ns['mount']('l1','el')

    def test_vm_uuid_path_retained(self):
        ns['NATIVE_BINDING']=None
        ns['MANIFEST']={'mounts':{'l1':'/fixture/l1'}}
        ns['DISKS']=[dict(role='l1',mount='/fixture/l1',uuid='fixture-uuid')]
        with patch.object(os.path,'ismount',return_value=True),patch.object(subprocess,'check_output',side_effect=['fixture-uuid ext4 ro','fixture-uuid ext4 rw']):
            self.assertEqual(ns['mount']('l1','cl'),'/fixture/l1')
        with patch.object(os.path,'ismount',return_value=True),patch.object(subprocess,'check_output',return_value='other-uuid ext4 rw'):
            with self.assertRaises(AssertionError):ns['mount']('l1','cl')

if __name__=='__main__': unittest.main(verbosity=2)
