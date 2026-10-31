"""Real disposable keys, mutual TLS and a tiny private NoCloud ISO; no host setup."""
import hashlib, importlib.util, io, json, os
from pathlib import Path
import socket, ssl, stat, tarfile, threading, unittest

ROOT=Path(__file__).resolve().parents[2]
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
c=module('credentials',ROOT/'rpc/guest/credentials.py')
seed=module('prepare_seed',ROOT/'rpc/guest/prepare_seed.py')
def digest(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
PINS={n:{'path':'/usr/bin/'+n,'sha256':digest('/usr/bin/'+n)} for n in ['openssl','ssh-keygen']}

class Credentials(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.parent=Path('/work');cls.parent.chmod(0o700)
        cls.instance='rpc-owned-credential-fixture';cls.attempt='a1'*16
        cls.generated=c.generate(cls.parent,cls.attempt,cls.instance,PINS)
        cls.root=Path(cls.generated['path']);cls.receipt=cls.generated['publicReceiptSha256']
        cls.config={'bundle':str(cls.root),'publicReceiptSha256':cls.receipt,'tools':PINS}
    def material(self):return c.guest_material(self.root,self.receipt,self.instance,PINS)
    def test_01_owned_modes(self):
        for p in self.root.rglob('*'):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o700 if p.is_dir() else 0o600)
    def test_02_attempt_cannot_be_reused(self):
        with self.assertRaises(FileExistsError):c.generate(self.parent,self.attempt,self.instance,PINS)
    def test_03_wrong_guest(self):
        with self.assertRaises(ValueError):c.guest_material(self.root,self.receipt,'rpc-owned-another-guest',PINS)
    def test_04_wrong_receipt(self):
        with self.assertRaises(ValueError):c.guest_material(self.root,'0'*64,self.instance,PINS)
    def test_05_role_authorities_separate(self):
        t=c.Tools(PINS)
        r=t.run('openssl',['verify','-CAfile',self.root/'l1/client/ca-cert.pem','-purpose','sslclient',self.root/'base/client/client-cert.pem'],allow_failure=True)
        self.assertNotEqual(r.returncode,0)
    def test_06_client_key_substitution(self):
        p=self.root/'l1/client/client-key.pem';original=p.read_bytes()
        try:
            p.write_bytes((self.root/'base/client/client-key.pem').read_bytes())
            with self.assertRaises(ValueError):self.material()
        finally:p.write_bytes(original)
    def test_07_public_permissions_refused(self):
        p=self.root/'l1/client/client-key.pem';p.chmod(0o644)
        try:
            with self.assertRaises(ValueError):self.material()
        finally:p.chmod(0o600)
    def test_08_symlink_refused(self):
        p=self.root/'l1/client/client-key.pem';saved=p.with_suffix('.saved');p.rename(saved)
        try:
            p.symlink_to(saved)
            with self.assertRaises(ValueError):self.material()
        finally:p.unlink();saved.rename(p)
    def test_09_guest_has_only_clients(self):
        material=self.material();self.assertEqual(len(material['writes']),6)
        self.assertTrue(all('/client-' in p or p.endswith('/ca-cert.pem') for p in material['writes']))
        self.assertTrue(all('issuer' not in p and 'server-key' not in p for p in material['writes']))
    def test_10_ssh_private_substitution(self):
        p=self.root/'ssh/ssh_host_ed25519_key';original=p.read_bytes()
        try:
            p.write_bytes((self.root/'base/client/client-key.pem').read_bytes())
            with self.assertRaises(ValueError):self.material()
        finally:p.write_bytes(original)
    def test_11_seed_directory_access(self):
        writes,cloud,public=c.seed_material(self.config,self.instance)
        dirs=cloud['bootcmd'][0][4:]
        self.assertNotIn('/etc/enclave-rpc',dirs)
        self.assertEqual(len(dirs),4);self.assertFalse(cloud['ssh_publish_hostkeys']['enabled'])
        self.assertNotIn('PRIVATE KEY',json.dumps(public))
        self.assertEqual(public['sshHostPublicKey'],cloud['ssh_keys']['ed25519_public'])
    def tls(self,client_role,hostname=None):
        server=self.root/'l1/server';client=self.root/client_role/'client'
        sc=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);sc.load_cert_chain(server/'server-cert.pem',server/'server-key.pem')
        sc.verify_mode=ssl.CERT_REQUIRED;sc.load_verify_locations(server/'ca-cert.pem')
        cc=ssl.create_default_context(cafile=str(server/'ca-cert.pem'));cc.load_cert_chain(client/'client-cert.pem',client/'client-key.pem')
        a,b=socket.socketpair();a.settimeout(2);b.settimeout(2);out=[]
        def serve():
            try:
                with sc.wrap_socket(a,server_side=True) as channel:
                    channel.sendall(b'owned');out.append(True)
            except (ssl.SSLError,OSError):out.append(False)
            finally:a.close()
        thread=threading.Thread(target=serve);thread.start();ok=False
        try:
            with cc.wrap_socket(b,server_hostname=hostname or self.generated['public']['roles']['l1']['tlsName']) as channel:
                ok=channel.recv(5)==b'owned'
        except (ssl.SSLError,OSError):pass
        finally:b.close();thread.join(3)
        self.assertFalse(thread.is_alive());return ok and out==[True]
    def test_12_real_mutual_tls(self):self.assertTrue(self.tls('l1'))
    def test_13_cross_role_tls_refused(self):self.assertFalse(self.tls('base'))
    def test_14_wrong_server_name_refused(self):self.assertFalse(self.tls('l1','unapproved.invalid'))
    def test_15_private_iso_readback(self):
        archive=self.parent/'small.tar';data=b'fixture-only'
        with tarfile.open(archive,'w') as t:
            i=tarfile.TarInfo('opt/enclave-rpc/nbd/bin/fixture');i.size=len(data);i.mode=0o755;t.addfile(i,io.BytesIO(data))
        receipt={'bytes':archive.stat().st_size,'sha256':digest(archive),'files':{'bin/fixture':{'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}},'sonames':{}}
        cfg={'bootId':Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'instance':self.instance,
             'publicKey':self.generated['public']['sshHostPublicKey'],'archive':str(archive),'storageReceipt':receipt,
             'output':str(self.parent/'private-seed'),'payload':{},'runtimePins':{},'credentials':self.config,
             'xorriso':'/usr/sbin/xorriso','xorrisoSha256':digest('/usr/sbin/xorriso'),'libraryPath':''}
        result=seed.build(cfg);self.assertTrue(result['readbackVerified']);self.assertTrue(result['seedContainsPrivateCredentials'])
        self.assertFalse(result['storageAttached']);self.assertFalse(result['clientsStarted'])
        cloud=json.loads((self.parent/'private-seed/seed/user-data').read_text().split('\n',1)[1])
        self.assertTrue('ed25519_private' in cloud['ssh_keys'])
        for p in (self.parent/'private-seed').rglob('*'):
            self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o700 if p.is_dir() else 0o600)
        for p,row in result['records'].items():
            if p.endswith('client-key.pem'):self.assertTrue(row['private']);self.assertNotIn('sha256',row)
        self.assertNotIn('PRIVATE KEY',json.dumps(result))
        with self.assertRaises(FileExistsError):seed.build(cfg)

if __name__=='__main__':unittest.main(verbosity=2)
