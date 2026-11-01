"""Real ext4/key/persistence checks; unit envelope and resource reader mocked.

The native composition fixture separately exercises those actual services.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

SOURCE=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('owner_state',SOURCE/'rpc/server/owner_state.py')
o=importlib.util.module_from_spec(spec);spec.loader.exec_module(o)
c=o.c


class OwnerStateTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['RPC_OWNER_TEST_ROOT']);self.root=Path(self.tmp.name);self.root.chmod(0o700);self.addCleanup(self.tmp.cleanup)
        attempt=uuid.uuid4().hex;cp=self.root/'clocks';cp.mkdir(mode=0o700)
        begin=c.begin(cp,attempt,'rpc-owned-fixture-'+attempt,uuid.uuid4().hex);r=c.protocol.decode(c.read_pinned(begin))
        sample=c.write_new(self.root/'sample',c.encode({'schema':'owned-rpc-windows-clock/1','attempt':attempt,'vmAttempt':r['vmAttempt'],'windowsBoot':uuid.uuid4().hex,'monotonicMilliseconds':1000000000}))
        clock=c.finish(begin,sample)
        self.parent=self.root/'owner';self.parent.mkdir(mode=0o700)
        roles={}
        for role in ('l1','base'):
            p=self.root/(role+'.dummy');p.write_bytes(b'original dummy');p.chmod(0o600)
            roles[role]={'volumeId':('a' if role=='l1' else 'b')*64,'originals':[[str(p),o.v.metadata(p)]]}
        rc=c.write_new(self.root/'resource.json',b'{}')
        paths=[o.HERE/n for n in ('owner_state.py','owner_entry.py','volume_export.py','observe_resources.mjs')]
        paths += [o.HERE.parent/n for n in ('startup_clock.py','storage_protocol.py')]
        paths += [Path('/usr/bin/'+n) for n in ('python3','node','openssl','stat')]+[Path(rc['path'])]
        self.cfg={'schema':'enclave-rpc-owner-provision/1','attempt':attempt,'clock':clock,'parent':{'path':str(self.parent),'identity':o.identity(self.parent.stat())},'roles':roles,'resourceConfig':rc,'pins':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
        self.policy={'l1Volume':'a'*64,'baseVolume':'b'*64}
        self.contract={'roles':{r:{'originals':x['originals']} for r,x in roles.items()}}

    def provision(self):
        real_run=o.subprocess.run;real_load=o.load
        class Entry:
            @staticmethod
            def envelope(*args):return {'fixtureEnvelope':True}
        class Response:
            stdout=b'{"authenticated":true,"unreadUnits":0,"availableMiB":40000,"pendingMiB":0,"floorMiB":18432}'
            stderr=b''
        with patch.object(o,'load',side_effect=lambda n,p:Entry if n=='owner_state_entry' else real_load(n,p)),patch.object(o.subprocess,'run',side_effect=lambda args,**kw:Response() if args[0]=='/usr/bin/node' else real_run(args,**kw)):
            return o.provision(self.cfg)

    def test_real_keys_bind_and_repeated_setup_refused(self):
        result=self.provision();binding=result['authority'];root=Path(binding['path']).parent
        before={n:(root/n).read_bytes() for n in ('l1-seed','base-seed','authority.json','provision.intent')}
        self.assertFalse(result['ownerCommitmentVerified']);self.assertFalse(result['reservationMayRelease'])
        self.assertNotEqual(result['rpcStorage']['l1']['publicKey'],result['rpcStorage']['base']['publicKey'])
        fds=o.bind(binding,self.contract,self.policy)
        try:
            self.assertEqual([n for n,_,_ in fds],['journal','l1-seed','base-seed'])
            self.assertTrue(all(fd>=20 for _,fd,_ in fds))
        finally:
            for _,fd,_ in fds:os.close(fd)
        with self.assertRaises(FileExistsError):self.provision()
        self.assertEqual(before,{n:(root/n).read_bytes() for n in before})

    def test_partial_key_write_consumes_authority(self):
        real=c.write_new
        def fail(path,raw):
            if Path(path).name=='base-seed':raise OSError('injected second key persistence failure')
            return real(path,raw)
        with patch.object(c,'write_new',side_effect=fail):
            with self.assertRaises(OSError):self.provision()
        root=self.parent/'authority'
        self.assertTrue((root/'l1-seed').exists());self.assertTrue((root/'provision.intent').exists());self.assertFalse((root/'authority.json').exists())
        with self.assertRaises(FileExistsError):self.provision()

    def test_replacement_empty_journal_cannot_reset_consumption(self):
        binding=self.provision()['authority'];root=Path(binding['path']).parent
        (root/'journal').rename(root/'retained-journal');(root/'journal').mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError,'directory identity'):o.bind(binding,self.contract,self.policy)
        self.assertTrue((root/'retained-journal').is_dir())

    def test_changed_seed_and_cross_role_sources_refused(self):
        binding=self.provision()['authority'];root=Path(binding['path']).parent
        (root/'base-seed').write_bytes(os.urandom(32))
        with self.assertRaisesRegex(ValueError,'key was replaced'):o.bind(binding,self.contract,self.policy)
        self.contract['roles']['l1']['originals']=self.contract['roles']['base']['originals']
        with self.assertRaisesRegex(ValueError,'mapping differs'):o.inspect(binding,self.contract,self.policy)

    def test_alias_refused_before_setup(self):
        self.cfg['roles']['base']['originals']=self.cfg['roles']['l1']['originals']
        with self.assertRaisesRegex(ValueError,'aliases'):self.provision()
        self.assertFalse((self.parent/'authority').exists())


if __name__=='__main__':unittest.main()
