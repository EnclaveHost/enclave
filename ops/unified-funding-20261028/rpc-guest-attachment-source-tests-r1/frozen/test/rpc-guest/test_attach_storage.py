import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('attach',Path(__file__).resolve().parents[2]/'rpc/guest/attach_storage.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def config():
    c={'schema':'owned-rpc-attachment/1','instance':'rpc-owned-fixture-20261031','bootId':'fixture-boot','attempt':'a'*32,
       'createdUtcNs':100_000_000_000,'deadlineUtcNs':1000_000_000_000,'roles':{}}
    for role in m.ROLES:
        c['roles'][role]={'host':'192.168.8.249','port':10809 if role=='l1' else 10810,'tlsName':'rpc-storage-fixture-20261031',
                         'export':f"rpc-{c['attempt']}-{role}",'bytes':m.BYTES,'uuid':m.ROLES[role]['uuid'],
                         'caSha256':'b'*64,'certificateSha256':'c'*64,'serverReceiptSha256':'d'*64}
    return c

class AttachmentContractTests(unittest.TestCase):
    def test_actual_roles(self):
        for role in m.ROLES:m.validate_config(config(),role,101_000_000_000,'fixture-boot')
    def test_original_deadline_not_extended(self):
        for field,value in [('deadlineUtcNs',1001_000_000_000),('createdUtcNs',99_000_000_000),('createdUtcNs',True)]:
            c=config();c[field]=value
            with self.assertRaises(ValueError):m.validate_config(c,'l1',101_000_000_000,'fixture-boot')
        for now in [99_000_000_000,1000_000_000_000]:
            with self.assertRaises(ValueError):m.validate_config(config(),'l1',now,'fixture-boot')
    def test_wrong_boot(self):
        with self.assertRaises(ValueError):m.validate_config(config(),'l1',101_000_000_000,'another')
    def test_fixed_role_identity(self):
        for field,value in [('uuid',m.ROLES['base']['uuid']),('bytes',m.BYTES+512),('bytes',True),('export','default'),('host','8.8.8.8'),('host','127.0.0.1'),('tlsName',''),('port',True),('caSha256','')]:
            c=config();c['roles']['l1'][field]=value
            with self.assertRaises(ValueError):m.validate_config(c,'l1',101_000_000_000,'fixture-boot')
    def test_no_extra_fields_or_omission(self):
        c=config();del c['roles']['base']
        with self.assertRaises(ValueError):m.validate_config(c,'l1',101_000_000_000,'fixture-boot')
        c=config();c['roles']['l1']['persist']=True
        with self.assertRaises(ValueError):m.validate_config(c,'l1',101_000_000_000,'fixture-boot')
    def test_adoption_exact_binding_and_time(self):
        import json
        with tempfile.TemporaryDirectory() as td,patch.object(m,'protected'):
            p=Path(td)/'adoption.json';c=config()
            self.assertFalse(m.adopted(p,c,'contract','ready',102_000_000_000))
            a={'attempt':c['attempt'],'bootId':c['bootId'],'contractSha256':'contract','readySha256':'ready','adoptedUtcNs':101_000_000_000}
            p.write_text(json.dumps(a));self.assertTrue(m.adopted(p,c,'contract','ready',102_000_000_000))
            for field,value in [('attempt','foreign'),('bootId','foreign'),('contractSha256','foreign'),('readySha256','foreign'),('adoptedUtcNs',1000_000_000_000),('adoptedUtcNs',103_000_000_000),('adoptedUtcNs',True)]:
                b=dict(a);b[field]=value;p.write_text(json.dumps(b))
                with self.assertRaises(ValueError):m.adopted(p,c,'contract','ready',102_000_000_000)
    def test_consumed_receipt_not_overwritten(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'intent.json';m.write_new(p,{'first':True})
            with self.assertRaises(FileExistsError):m.write_new(p,{'first':False})
            self.assertIn('true',p.read_text())
    def test_mount_dependencies(self):
        root=Path(__file__).resolve().parents[2]/'rpc/guest/units'
        for role in m.ROLES:
            text=(root/f'enclave-rpc-attach-{role}.service').read_text()
            self.assertIn('Type=notify',text);self.assertIn('Restart=no',text);self.assertIn('MemoryMax=128M',text)
        mounts=list(root.glob('*.mount'));self.assertEqual(len(mounts),2)
        for p in mounts:
            self.assertIn('BindsTo=enclave-rpc-attach-',p.read_text());self.assertIn('Options=rw,nosuid,nodev,noexec',p.read_text())

if __name__=='__main__':unittest.main()
